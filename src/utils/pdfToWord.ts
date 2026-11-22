// PDF -> Word (.docx) conversion with layout recovery:
// paragraphs re-flowed from lines, headings, bold/italic/size, alignment, indents and spacing,
// tables (aligned columns), images, and the same page size and margins as the PDF.
import * as pdfjsLib from 'pdfjs-dist';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ISectionOptions,
} from 'docx';

interface Span {
  text: string;
  x: number;
  right: number;
  top: number;
  baseline: number;
  size: number;
  bold: boolean;
  italic: boolean;
  family: string;
  color: string; // hex RRGGBB
}

interface Line {
  spans: Span[];
  x: number;
  right: number;
  top: number;
  baseline: number;
  size: number;
}

type Block =
  | { kind: 'para'; lines: Line[]; top: number }
  | { kind: 'table'; rows: Line[][]; columns: number[]; top: number }
  | { kind: 'image'; png: Uint8Array; width: number; height: number; top: number; x: number };

const PT_TO_TWIP = 20;
const PT_TO_PX = 96 / 72;

const KNOWN_FONTS: Record<string, string> = {
  arial: 'Arial',
  helvetica: 'Arial',
  timesnewroman: 'Times New Roman',
  times: 'Times New Roman',
  timesroman: 'Times New Roman',
  couriernew: 'Courier New',
  courier: 'Courier New',
  calibri: 'Calibri',
  cambria: 'Cambria',
  georgia: 'Georgia',
  verdana: 'Verdana',
  tahoma: 'Tahoma',
  garamond: 'Garamond',
  trebuchetms: 'Trebuchet MS',
  segoeui: 'Segoe UI',
  centurygothic: 'Century Gothic',
  bookantiqua: 'Book Antiqua',
  palatinolinotype: 'Palatino Linotype',
  aptos: 'Aptos',
};

/** Word font name from the PDF font name (e.g. "ABCDEF+TimesNewRomanPS-BoldMT" -> "Times New Roman"). */
function wordFont(pdfName: string, fallbackFamily: string) {
  const base = pdfName
    .replace(/^[A-Z]{6}\+/, '')
    .split(/[-,]/)[0]
    .replace(/(PSMT|MT|PS)$/, '')
    .replace(/(Bold|Italic|Oblique|Regular|Light|Semibold|Black)+$/i, '');
  const known = KNOWN_FONTS[base.toLowerCase()];
  if (known) return known;
  if (base.length > 2 && /^[A-Za-z][A-Za-z0-9 ]+$/.test(base)) return base.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (/mono/i.test(fallbackFamily)) return 'Courier New';
  if (/serif/i.test(fallbackFamily) && !/sans/i.test(fallbackFamily)) return 'Times New Roman';
  return 'Arial';
}

async function getObj(objs: { get: (id: string, cb?: (o: unknown) => void) => unknown; has?: (id: string) => boolean }, id: string) {
  return new Promise<unknown>((resolve) => {
    try {
      objs.get(id, resolve);
    } catch {
      resolve(null);
    }
    setTimeout(() => resolve(null), 4000);
  });
}

/** Converts a PDF.js image object to PNG bytes. */
async function imageToPng(img: unknown): Promise<Uint8Array | null> {
  const o = img as { bitmap?: ImageBitmap; data?: Uint8ClampedArray; width: number; height: number; kind?: number } | null;
  if (!o || !o.width || !o.height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = o.width;
  canvas.height = o.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (o.bitmap) {
    ctx.drawImage(o.bitmap, 0, 0);
  } else if (o.data) {
    const rgba = new Uint8ClampedArray(o.width * o.height * 4);
    const src = o.data;
    if (o.kind === 3) rgba.set(src.subarray(0, rgba.length));
    else if (o.kind === 2) {
      for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
        rgba[j] = src[i];
        rgba[j + 1] = src[i + 1];
        rgba[j + 2] = src[i + 2];
        rgba[j + 3] = 255;
      }
    } else if (o.kind === 1) {
      const rowBytes = (o.width + 7) >> 3;
      for (let y = 0; y < o.height; y++) {
        for (let x = 0; x < o.width; x++) {
          const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0;
          const j = (y * o.width + x) * 4;
          rgba[j] = rgba[j + 1] = rgba[j + 2] = v;
          rgba[j + 3] = 255;
        }
      }
    } else return null;
    ctx.putImageData(new ImageData(rgba, o.width, o.height), 0, 0);
  } else return null;
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Text in drawing order with the fill colour of every character (letters only, no spaces). */
interface TextInk {
  chars: string;
  colors: string[];
}

function assignColors(spans: Span[], ink: TextInk) {
  let from = 0;
  for (const s of spans) {
    const key = s.text.replace(/\s+/g, '');
    if (!key) continue;
    const at = ink.chars.indexOf(key, from);
    if (at < 0) continue;
    s.color = ink.colors[at] ?? '000000';
    from = at + key.length;
  }
}

/** One pass on the page operators: images with their position, and text colours. */
async function pageOperators(page: pdfjsLib.PDFPageProxy, vp: pdfjsLib.PageViewport) {
  const ops = await page.getOperatorList();
  const images: Array<{ png: Uint8Array; x: number; top: number; width: number; height: number }> = [];
  const ink: TextInk = { chars: '', colors: [] };
  let ctm: number[] = [1, 0, 0, 1, 0, 0];
  let fill = '000000';
  const stack: Array<{ ctm: number[]; fill: string }> = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === pdfjsLib.OPS.save) stack.push({ ctm, fill });
    else if (fn === pdfjsLib.OPS.restore) {
      const st = stack.pop();
      ctm = st?.ctm ?? [1, 0, 0, 1, 0, 0];
      fill = st?.fill ?? '000000';
    } else if (fn === pdfjsLib.OPS.setFillRGBColor && typeof args[0] === 'string') {
      fill = args[0].replace('#', '').toLowerCase();
    } else if (fn === pdfjsLib.OPS.showText && Array.isArray(args[0])) {
      for (const g of args[0] as Array<{ unicode?: string } | number | null>) {
        const u = g && typeof g === 'object' ? (g.unicode ?? '') : '';
        for (const ch of u.replace(/\s+/g, '')) {
          ink.chars += ch;
          ink.colors.push(fill);
        }
      }
    }
    else if (fn === pdfjsLib.OPS.transform) ctm = pdfjsLib.Util.transform(ctm, args as number[]);
    else if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintImageXObjectRepeat) {
      const id = String(args[0]);
      const m = pdfjsLib.Util.transform(vp.transform, ctm);
      const p1 = [m[4], m[5]];
      const p2 = [m[0] + m[2] + m[4], m[1] + m[3] + m[5]];
      const x = Math.min(p1[0], p2[0]);
      const top = Math.min(p1[1], p2[1]);
      const width = Math.abs(p2[0] - p1[0]);
      const height = Math.abs(p2[1] - p1[1]);
      if (width < 16 || height < 16) continue; // decorations
      const obj = await getObj(id.startsWith('g_') ? page.commonObjs : page.objs, id);
      const png = await imageToPng(obj);
      if (png) images.push({ png, x, top, width, height });
    }
  }
  return { images, ink };
}

async function pageSpans(page: pdfjsLib.PDFPageProxy, vp: pdfjsLib.PageViewport, ink: TextInk): Promise<Span[]> {
  const content = await page.getTextContent();
  const spans: Span[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
    const size = Math.hypot(tx[2], tx[3]);
    if (size < 1) continue;
    let fontName = '';
    let bold = false;
    let italic = false;
    try {
      const font = page.commonObjs.get(item.fontName) as { name?: string; bold?: boolean; black?: boolean; italic?: boolean };
      fontName = font?.name ?? '';
      bold = !!(font?.bold || font?.black) || /bold|black|heavy|semibold|demi/i.test(fontName);
      italic = !!font?.italic || /italic|oblique/i.test(fontName);
    } catch {
      // font not loaded
    }
    const family = wordFont(fontName, content.styles[item.fontName]?.fontFamily ?? 'sans-serif');
    spans.push({
      text: item.str,
      x: tx[4],
      right: tx[4] + item.width * vp.scale,
      top: tx[5] - size * 0.9,
      baseline: tx[5],
      size,
      bold,
      italic,
      family,
      color: '000000',
    });
  }
  assignColors(spans, ink);
  return spans;
}


function groupLines(spans: Span[]): Line[] {
  const lines: Line[] = [];
  for (const s of [...spans].sort((a, b) => a.baseline - b.baseline || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l.baseline - s.baseline) < Math.max(2, s.size * 0.35));
    if (line) {
      line.spans.push(s);
      line.x = Math.min(line.x, s.x);
      line.right = Math.max(line.right, s.right);
      line.size = Math.max(line.size, s.size);
      line.top = Math.min(line.top, s.top);
    } else {
      lines.push({ spans: [s], x: s.x, right: s.right, top: s.top, baseline: s.baseline, size: s.size });
    }
  }
  for (const l of lines) l.spans.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => a.baseline - b.baseline);
}

/** Splits a line into cells where the horizontal gap is large. */
function cellsOf(line: Line): Line[] {
  const cells: Line[] = [];
  for (const s of line.spans) {
    const cur = cells[cells.length - 1];
    const gap = cur ? s.x - cur.right : Infinity;
    if (cur && gap < Math.max(line.size * 0.9, 8)) {
      cur.spans.push(s);
      cur.right = Math.max(cur.right, s.right);
    } else {
      cells.push({ spans: [s], x: s.x, right: s.right, top: s.top, baseline: s.baseline, size: s.size });
    }
  }
  return cells;
}

function buildBlocks(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    // Table: at least 2 consecutive lines with the same column starts (2+ columns)
    const cells = cellsOf(lines[i]);
    if (cells.length >= 2) {
      const cols = cells.map((c) => c.x);
      const rows: Line[][] = [cells];
      let j = i + 1;
      while (j < lines.length) {
        const next = cellsOf(lines[j]);
        const gap = lines[j].top - (lines[j - 1].baseline + lines[j - 1].size * 0.3);
        if (gap > lines[j].size * 2.2) break;
        if (next.length !== cols.length || !next.every((c, k) => Math.abs(c.x - cols[k]) < 10)) break;
        rows.push(next);
        j++;
      }
      if (rows.length >= 2) {
        blocks.push({ kind: 'table', rows, columns: cols, top: lines[i].top });
        i = j;
        continue;
      }
    }
    // Paragraph: lines with the same size and left edge, close together
    const para: Line[] = [lines[i]];
    let j = i + 1;
    while (j < lines.length) {
      const prev = para[para.length - 1];
      const cur = lines[j];
      const gap = cur.top - (prev.baseline + prev.size * 0.3);
      const sameSize = Math.abs(cur.size - prev.size) < 0.6;
      const sameLeft = Math.abs(cur.x - para[0].x) < 4 || (para.length === 1 && cur.x < prev.x && prev.x - cur.x < 40);
      if (!sameSize || !sameLeft || gap > prev.size * 0.9 || cellsOf(cur).length >= 2) break;
      para.push(cur);
      j++;
    }
    blocks.push({ kind: 'para', lines: para, top: lines[i].top });
    i = j;
  }
  return blocks;
}

function runsOf(line: Line, scale = 1): TextRun[] {
  const runs: TextRun[] = [];
  let prevRight = -Infinity;
  for (const s of line.spans) {
    const space = prevRight > -Infinity && s.x - prevRight > s.size * 0.18 ? ' ' : '';
    runs.push(
      new TextRun({
        text: space + s.text,
        bold: s.bold,
        italics: s.italic,
        size: Math.max(2, Math.round(s.size * 2 * scale)),
        font: s.family,
        color: s.color,
      })
    );
    prevRight = s.right;
  }
  return runs;
}

export async function convertPdfToDocx(pdf: pdfjsLib.PDFDocumentProxy): Promise<Blob> {
  const sections: ISectionOptions[] = [];
  // Body size (most frequent) of the whole document, to detect headings
  const sizeCount = new Map<number, number>();
  const pagesData: Array<{ vp: pdfjsLib.PageViewport; lines: Line[]; images: Awaited<ReturnType<typeof pageOperators>>['images'] }> = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const { images, ink } = await pageOperators(page, vp).catch(() => ({ images: [], ink: { chars: '', colors: [] } }));
    const lines = groupLines(await pageSpans(page, vp, ink));
    for (const l of lines) for (const s of l.spans) sizeCount.set(Math.round(s.size), (sizeCount.get(Math.round(s.size)) ?? 0) + s.text.length);
    pagesData.push({ vp, lines, images });
  }
  const body = [...sizeCount].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;

  for (const { vp, lines, images } of pagesData) {
    const textLeft = lines.length ? Math.min(...lines.map((l) => l.x)) : 56;
    const textRight = lines.length ? Math.max(...lines.map((l) => l.right)) : vp.width - 56;
    const marginLeft = Math.max(18, Math.min(textLeft, images.length ? Math.min(...images.map((i) => i.x)) : textLeft));
    const marginRight = Math.max(18, vp.width - Math.max(textRight, ...images.map((i) => i.x + i.width)));
    const marginTop = Math.max(18, Math.min(lines[0]?.top ?? 56, images[0]?.top ?? Infinity) - 4);
    const contentWidth = vp.width - marginLeft - marginRight;

    const blocks: Block[] = [
      ...buildBlocks(lines),
      ...images.map((im) => ({ kind: 'image' as const, png: im.png, width: im.width, height: im.height, top: im.top, x: im.x })),
    ].sort((a, b) => a.top - b.top);

    const children: Array<Paragraph | Table> = [];
    let lastBottom = marginTop;
    for (const block of blocks) {
      const before = Math.max(0, Math.round((block.top - lastBottom) * PT_TO_TWIP * 0.9));
      if (block.kind === 'image') {
        const w = Math.min(block.width, contentWidth);
        const h = (block.height * w) / block.width;
        children.push(
          new Paragraph({
            spacing: { before },
            indent: { left: Math.max(0, Math.round((block.x - marginLeft) * PT_TO_TWIP)) },
            children: [
              new ImageRun({
                type: 'png',
                data: block.png,
                transformation: { width: Math.round(w * PT_TO_PX), height: Math.round(h * PT_TO_PX) },
              }),
            ],
          })
        );
        lastBottom = block.top + h;
        continue;
      }
      if (block.kind === 'table') {
        const pad = 5; // cell padding (points)
        const lastRight = Math.max(...block.rows.map((r) => r[r.length - 1].right));
        const colX = [...block.columns, Math.min(marginLeft + contentWidth, lastRight + pad * 2)];
        // Each column at least as wide as its longest text plus padding (Word must not wrap it)
        const widths = block.columns.map((x, k) => {
          const textWidth = Math.max(...block.rows.map((r) => (r[k] ? r[k].right - r[k].x : 0)));
          return Math.round(Math.max(colX[k + 1] - x, textWidth + pad * 2 + 6) * PT_TO_TWIP);
        });
        const pitch =
          block.rows.length > 1
            ? (block.rows[block.rows.length - 1][0].baseline - block.rows[0][0].baseline) / (block.rows.length - 1)
            : block.rows[0][0].size * 1.6;
        const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFC7D5' };
        children.push(
          new Table({
            width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
            columnWidths: widths,
            indent: { size: Math.max(0, Math.round((block.columns[0] - pad - marginLeft) * PT_TO_TWIP)), type: WidthType.DXA },
            margins: { left: pad * PT_TO_TWIP, right: pad * PT_TO_TWIP, top: 30, bottom: 30 },
            rows: block.rows.map(
              (row) =>
                new TableRow({
                  height: { value: Math.round(pitch * PT_TO_TWIP), rule: 'atLeast' as never },
                  children: row.map(
                    (cell, k) =>
                      new TableCell({
                        width: { size: widths[k], type: WidthType.DXA },
                        borders: { top: border, bottom: border, left: border, right: border },
                        verticalAlign: 'center' as never,
                        children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: runsOf(cell) })],
                      })
                  ),
                })
            ),
          })
        );
        const lastRow = block.rows[block.rows.length - 1][0];
        lastBottom = lastRow.baseline + lastRow.size * 0.3;
        continue;
      }
      const first = block.lines[0];
      const last = block.lines[block.lines.length - 1];
      const width = Math.max(...block.lines.map((l) => l.right - l.x));
      const center = (Math.min(...block.lines.map((l) => l.x)) + Math.max(...block.lines.map((l) => l.right))) / 2;
      const pageCenter = marginLeft + contentWidth / 2;
      let alignment: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.LEFT;
      if (width < contentWidth * 0.85 && Math.abs(center - pageCenter) < 12 && first.x - marginLeft > 20) {
        alignment = AlignmentType.CENTER;
      } else if (Math.abs(Math.max(...block.lines.map((l) => l.right)) - (marginLeft + contentWidth)) < 8 && first.x - marginLeft > contentWidth * 0.3) {
        alignment = AlignmentType.RIGHT;
      } else if (block.lines.length > 2 && block.lines.slice(0, -1).every((l) => contentWidth - (l.right - marginLeft) < 6)) {
        alignment = AlignmentType.JUSTIFIED;
      }
      const isHeading = first.size >= body * 1.25 && block.lines.length <= 3;
      const heading = isHeading ? (first.size >= body * 1.7 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2) : undefined;
      // Re-flow the lines into one paragraph (hyphenated words joined)
      const runs: TextRun[] = [];
      block.lines.forEach((l, k) => {
        const lineRuns = runsOf(l);
        if (k > 0) runs.push(new TextRun({ text: ' ' }));
        runs.push(...lineRuns);
      });
      const lineGap = block.lines.length > 1 ? (last.baseline - first.baseline) / (block.lines.length - 1) : first.size * 1.2;
      children.push(
        new Paragraph({
          heading,
          alignment,
          spacing: { before, line: Math.round(Math.max(lineGap, first.size) * PT_TO_TWIP), lineRule: 'atLeast' as never },
          indent:
            alignment === AlignmentType.LEFT || alignment === AlignmentType.JUSTIFIED
              ? (() => {
                  const bodyX = block.lines.length > 1 ? block.lines[1].x : first.x;
                  const shift = Math.round((first.x - bodyX) * PT_TO_TWIP);
                  return {
                    left: Math.max(0, Math.round((bodyX - marginLeft) * PT_TO_TWIP)),
                    firstLine: shift > 0 ? shift : undefined,
                    hanging: shift < 0 ? -shift : undefined,
                  };
                })()
              : undefined,
          children: runs,
        })
      );
      lastBottom = last.baseline + last.size * 0.3;
    }
    if (children.length === 0) children.push(new Paragraph(''));
    sections.push({
      properties: {
        page: {
          size: { width: Math.round(vp.width * PT_TO_TWIP), height: Math.round(vp.height * PT_TO_TWIP) },
          margin: {
            top: Math.round(marginTop * PT_TO_TWIP),
            bottom: Math.round(36 * PT_TO_TWIP),
            left: Math.round(marginLeft * PT_TO_TWIP),
            right: Math.round(marginRight * PT_TO_TWIP),
          },
        },
      },
      children,
    });
  }
  const doc = new Document({
    creator: 'F-pdf',
    styles: { default: { document: { run: { font: 'Arial' } } } },
    sections,
  });
  return Packer.toBlob(doc);
}
