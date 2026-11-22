// Low-level drawing helpers shared by the PDF engine:
// Unicode fonts, rotation-aware frames, page vs. annotation painters,
// real PDF annotations (editable in Acrobat/Foxit), OCR text layer, encryption.
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFHexString,
  PDFArray,
  PDFDict,
  PDFStream,
  StandardFonts,
  degrees,
  rgb,
  drawRectangle,
  drawEllipse,
  drawLine,
  drawText,
  type PDFFont,
  type PDFPage,
  type PDFOperator,
  type RGB,
} from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import dejavuRegularUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url';
import dejavuBoldUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?url';
import type { OverlayItem, PdfSecurity } from '../types/pdf';

// ---------- Colors & coordinates ----------

export function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0');
  const num = parseInt(full, 16);
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

const toRgb = (hex: string): RGB => {
  const [r, g, b] = hexToRgbTuple(hex);
  return rgb(r, g, b);
};

const normRot = (deg: number) => ((deg % 360) + 360) % 360;

// Normalized visual coordinates (top-left origin 0..1, as displayed) -> raw PDF coordinates.
// pdf.js shows /Rotate clockwise, so e.g. at 90° the visual top-left is the raw origin.
export function visualToPdfCoords(nx: number, ny: number, rawW: number, rawH: number, rotDeg: number) {
  const r = normRot(rotDeg);
  if (r === 90) return { x: ny * rawW, y: nx * rawH };
  if (r === 180) return { x: (1 - nx) * rawW, y: ny * rawH };
  if (r === 270) return { x: (1 - ny) * rawW, y: (1 - nx) * rawH };
  return { x: nx * rawW, y: (1 - ny) * rawH };
}

// Inverse of visualToPdfCoords
export function pdfToVisualCoords(x: number, y: number, rawW: number, rawH: number, rotDeg: number) {
  const r = normRot(rotDeg);
  if (r === 90) return { x: y / rawH, y: x / rawW };
  if (r === 180) return { x: 1 - x / rawW, y: y / rawH };
  if (r === 270) return { x: 1 - y / rawH, y: 1 - x / rawW };
  return { x: x / rawW, y: 1 - y / rawH };
}

export function visualRectToPdfBox(
  nx: number,
  ny: number,
  nw: number,
  nh: number,
  rawW: number,
  rawH: number,
  rotDeg: number
) {
  const p1 = visualToPdfCoords(nx, ny, rawW, rawH, rotDeg);
  const p2 = visualToPdfCoords(nx + nw, ny + nh, rawW, rawH, rotDeg);
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    w: Math.abs(p2.x - p1.x),
    h: Math.abs(p2.y - p1.y),
  };
}

export type Box = ReturnType<typeof visualRectToPdfBox>;

/**
 * A rotation-aware frame for one overlay: local coordinates (u to the visual right,
 * v visually downwards, in points) mapped to raw PDF coordinates.
 */
export interface Frame {
  w: number; // visual width in points
  h: number; // visual height in points
  rot: number; // page rotation: content drawn with this rotation looks upright
  at: (u: number, v: number) => { x: number; y: number };
}

export function makeFrame(
  area: { x: number; y: number; w: number; h: number },
  rawW: number,
  rawH: number,
  rotDeg: number
): Frame {
  const r = normRot(rotDeg);
  const vw = r % 180 ? rawH : rawW;
  const vh = r % 180 ? rawW : rawH;
  const tl = visualToPdfCoords(area.x, area.y, rawW, rawH, r);
  const basis: Record<number, [[number, number], [number, number]]> = {
    0: [[1, 0], [0, -1]],
    90: [[0, 1], [1, 0]],
    180: [[-1, 0], [0, 1]],
    270: [[0, -1], [-1, 0]],
  };
  const [eu, ev] = basis[r] ?? basis[0];
  return {
    w: area.w * vw,
    h: area.h * vh,
    rot: r,
    at: (u, v) => ({ x: tl.x + u * eu[0] + v * ev[0], y: tl.y + u * eu[1] + v * ev[1] }),
  };
}

// ---------- Fonts ----------

const WINANSI_EXTENDED = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

// Fallback only (Helvetica): keeps WinAnsi characters, strips accents from the others.
export function toWinAnsiSafe(input: string): string {
  let out = '';
  for (const ch of input.replace(/ /g, ' ')) {
    const cp = ch.codePointAt(0) ?? 32;
    if (cp === 10 || (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WINANSI_EXTENDED.has(cp)) {
      out += ch;
    } else {
      const stripped = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      if (stripped && stripped.charCodeAt(0) >= 0x20 && stripped.charCodeAt(0) <= 0x7e) out += stripped;
    }
  }
  return out;
}

export interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
  isUnicode: boolean;
  /** Removes the characters the font cannot draw (instead of crashing). */
  clean: (text: string, bold?: boolean) => string;
}

let fontBytesPromise: Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }> | null = null;

function loadFontBytes() {
  if (!fontBytesPromise) {
    fontBytesPromise = Promise.all([
      fetch(dejavuRegularUrl).then((r) => r.arrayBuffer()),
      fetch(dejavuBoldUrl).then((r) => r.arrayBuffer()),
    ]).then(([regular, bold]) => ({ regular, bold }));
    fontBytesPromise.catch(() => {
      fontBytesPromise = null;
    });
  }
  return fontBytesPromise;
}

function isWinAnsiText(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 32;
    if (!(cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WINANSI_EXTENDED.has(cp))) {
      return false;
    }
  }
  return true;
}

async function standardFonts(doc: PDFDocument): Promise<FontSet> {
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { regular, bold, isUnicode: false, clean: (t) => toWinAnsiSafe(t.replace(/\r/g, '')) };
}

/**
 * Fonts for the text F-pdf writes. Latin text (French, English...) uses Helvetica: tiny files.
 * As soon as the text holds other characters (Greek, Cyrillic, symbols...), DejaVu Sans is
 * embedded in full (font subsetting of the fontkit library fails on this font).
 * Falls back to Helvetica if the font files cannot be read.
 */
export async function embedUnicodeFonts(doc: PDFDocument, allText = ''): Promise<FontSet> {
  if (isWinAnsiText(allText)) return standardFonts(doc);
  try {
    const bytes = await loadFontBytes();
    doc.registerFontkit(fontkit);
    const regular = await doc.embedFont(bytes.regular, { subset: false });
    const bold = await doc.embedFont(bytes.bold, { subset: false });
    const sets = new Map<PDFFont, Set<number>>([
      [regular, new Set(regular.getCharacterSet())],
      [bold, new Set(bold.getCharacterSet())],
    ]);
    const clean = (text: string, isBold = false) => {
      const set = sets.get(isBold ? bold : regular)!;
      let out = '';
      for (const ch of text.replace(/\r/g, '').replace(/ /g, ' ')) {
        const cp = ch.codePointAt(0) ?? 32;
        if (cp === 10 || set.has(cp)) out += ch;
      }
      return out;
    };
    return { regular, bold, isUnicode: true, clean };
  } catch {
    return standardFonts(doc);
  }
}
function wrapLine(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (maxWidth <= 0 || font.widthOfTextAtSize(text, size) <= maxWidth) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  return text.split('\n').flatMap((l) => wrapLine(l, font, size, maxWidth));
}

// ---------- Painters ----------

interface RectOpts {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: RGB;
  stroke?: RGB;
  strokeWidth?: number;
  opacity?: number;
}
interface TextOpts {
  x: number;
  y: number;
  size: number;
  color: RGB;
  rotate: number;
  bold?: boolean;
  opacity?: number;
}

export interface Painter {
  fonts: FontSet;
  rect(o: RectOpts): void;
  ellipse(o: { cx: number; cy: number; rx: number; ry: number; stroke: RGB; strokeWidth: number }): void;
  line(o: { start: { x: number; y: number }; end: { x: number; y: number }; thickness: number; color: RGB }): void;
  text(s: string, o: Partial<TextOpts> & { x: number; y: number; size: number; color: RGB }): void;
}

/** Draws directly into the page content (flattened). */
export class PagePainter implements Painter {
  private page: PDFPage;
  fonts: FontSet;
  constructor(page: PDFPage, fonts: FontSet) {
    this.page = page;
    this.fonts = fonts;
  }
  rect(o: RectOpts) {
    this.page.drawRectangle({
      x: o.x,
      y: o.y,
      width: o.w,
      height: o.h,
      color: o.fill,
      borderColor: o.stroke,
      borderWidth: o.stroke ? (o.strokeWidth ?? 1) : 0,
      opacity: o.fill ? (o.opacity ?? 1) : undefined,
      borderOpacity: o.stroke ? 1 : undefined,
    });
  }
  ellipse(o: { cx: number; cy: number; rx: number; ry: number; stroke: RGB; strokeWidth: number }) {
    this.page.drawEllipse({
      x: o.cx,
      y: o.cy,
      xScale: Math.max(1, o.rx),
      yScale: Math.max(1, o.ry),
      borderColor: o.stroke,
      borderWidth: o.strokeWidth,
    });
  }
  line(o: { start: { x: number; y: number }; end: { x: number; y: number }; thickness: number; color: RGB }) {
    this.page.drawLine({ start: o.start, end: o.end, thickness: o.thickness, color: o.color });
  }
  text(s: string, o: Partial<TextOpts> & { x: number; y: number; size: number; color: RGB }) {
    const font = o.bold ? this.fonts.bold : this.fonts.regular;
    const clean = this.fonts.clean(s, o.bold);
    if (!clean) return;
    this.page.drawText(clean, {
      x: o.x,
      y: o.y,
      size: o.size,
      font,
      color: o.color,
      opacity: o.opacity,
      rotate: degrees(o.rotate ?? 0),
    });
  }
}

/** Collects PDF operators for an annotation appearance stream, tracking the painted area. */
export class OpsPainter implements Painter {
  ops: PDFOperator[] = [];
  private gs = new Map<number, string>();
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  fonts: FontSet;
  constructor(fonts: FontSet) {
    this.fonts = fonts;
  }

  private extend(x: number, y: number, pad = 0) {
    this.minX = Math.min(this.minX, x - pad);
    this.minY = Math.min(this.minY, y - pad);
    this.maxX = Math.max(this.maxX, x + pad);
    this.maxY = Math.max(this.maxY, y + pad);
  }
  private gsName(opacity: number | undefined) {
    if (opacity === undefined || opacity >= 1) return undefined;
    const key = Math.round(opacity * 100);
    if (!this.gs.has(key)) this.gs.set(key, `GSa${key}`);
    return this.gs.get(key);
  }
  rect(o: RectOpts) {
    const sw = o.stroke ? (o.strokeWidth ?? 1) : 0;
    const zero = degrees(0);
    if (o.fill) {
      this.ops.push(
        ...drawRectangle({
          x: o.x,
          y: o.y,
          width: o.w,
          height: o.h,
          color: o.fill,
          borderColor: undefined,
          borderWidth: 0,
          rotate: zero,
          xSkew: zero,
          ySkew: zero,
          graphicsState: this.gsName(o.opacity),
        })
      );
    }
    if (o.stroke) {
      this.ops.push(
        ...drawRectangle({
          x: o.x,
          y: o.y,
          width: o.w,
          height: o.h,
          color: undefined,
          borderColor: o.stroke,
          borderWidth: sw,
          rotate: zero,
          xSkew: zero,
          ySkew: zero,
        })
      );
    }
    this.extend(o.x, o.y, sw);
    this.extend(o.x + o.w, o.y + o.h, sw);
  }
  ellipse(o: { cx: number; cy: number; rx: number; ry: number; stroke: RGB; strokeWidth: number }) {
    this.ops.push(
      ...drawEllipse({
        x: o.cx,
        y: o.cy,
        xScale: Math.max(1, o.rx),
        yScale: Math.max(1, o.ry),
        color: undefined,
        borderColor: o.stroke,
        borderWidth: o.strokeWidth,
      })
    );
    this.extend(o.cx - o.rx, o.cy - o.ry, o.strokeWidth);
    this.extend(o.cx + o.rx, o.cy + o.ry, o.strokeWidth);
  }
  line(o: { start: { x: number; y: number }; end: { x: number; y: number }; thickness: number; color: RGB }) {
    this.ops.push(...drawLine({ start: o.start, end: o.end, thickness: o.thickness, color: o.color }));
    this.extend(o.start.x, o.start.y, o.thickness);
    this.extend(o.end.x, o.end.y, o.thickness);
  }
  text(s: string, o: Partial<TextOpts> & { x: number; y: number; size: number; color: RGB }) {
    const font = o.bold ? this.fonts.bold : this.fonts.regular;
    const clean = this.fonts.clean(s, o.bold);
    if (!clean) return;
    const zero = degrees(0);
    const rot = o.rotate ?? 0;
    this.ops.push(
      ...drawText(font.encodeText(clean), {
        x: o.x,
        y: o.y,
        size: o.size,
        font: o.bold ? 'F2' : 'F1',
        color: o.color,
        rotate: degrees(rot),
        xSkew: zero,
        ySkew: zero,
        graphicsState: this.gsName(o.opacity),
      })
    );
    const width = font.widthOfTextAtSize(clean, o.size);
    const rad = (rot * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    // Text box corners: baseline start/end, plus ascent and descent
    for (const [u, v] of [
      [0, -0.3],
      [width, -0.3],
      [0, 1],
      [width, 1],
    ]) {
      this.extend(o.x + u * ux - v * o.size * uy, o.y + u * uy + v * o.size * ux, 1);
    }
  }
  bounds(): [number, number, number, number] | null {
    if (!isFinite(this.minX)) return null;
    return [this.minX, this.minY, this.maxX, this.maxY];
  }
  resources(doc: PDFDocument) {
    const ext: Record<string, PDFDict> = {};
    for (const [key, name] of this.gs) {
      ext[name] = doc.context.obj({ Type: 'ExtGState', ca: key / 100, CA: key / 100 });
    }
    return doc.context.obj({
      Font: { F1: this.fonts.regular.ref, F2: this.fonts.bold.ref },
      ...(this.gs.size ? { ExtGState: ext } : {}),
    });
  }
}

// ---------- Drawing one overlay (shared by flattening and annotations) ----------

export function paintOverlay(
  p: Painter,
  item: OverlayItem,
  fr: Frame,
  box: Box,
  rawW: number,
  rawH: number,
  rotDeg: number
) {
  const color = toRgb(item.color || '#1746d1');
  const sw = item.strokeWidth ?? 2;
  const map = (pt: { x: number; y: number }) => visualToPdfCoords(pt.x, pt.y, rawW, rawH, rotDeg);

  switch (item.kind) {
    case 'highlight':
      p.rect({ x: box.x, y: box.y, w: box.w, h: box.h, fill: color, opacity: item.opacity ?? 0.35 });
      return;
    case 'rect':
      p.rect({ x: box.x, y: box.y, w: box.w, h: box.h, stroke: color, strokeWidth: sw });
      return;
    case 'ellipse':
      p.ellipse({ cx: box.x + box.w / 2, cy: box.y + box.h / 2, rx: box.w / 2, ry: box.h / 2, stroke: color, strokeWidth: sw });
      return;
    case 'draw': {
      const pts = item.points ?? [];
      for (let i = 1; i < pts.length; i++) {
        p.line({ start: map(pts[i - 1]), end: map(pts[i]), thickness: item.strokeWidth ?? 2.2, color });
      }
      return;
    }
    case 'arrow': {
      const pts = item.points ?? [];
      if (pts.length < 2) return;
      const start = map(pts[0]);
      const end = map(pts[pts.length - 1]);
      const t = item.strokeWidth ?? 2.2;
      p.line({ start, end, thickness: t, color });
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      for (const side of [-1, 1]) {
        p.line({
          start: end,
          end: {
            x: end.x - 11 * Math.cos(angle + (side * Math.PI) / 6),
            y: end.y - 11 * Math.sin(angle + (side * Math.PI) / 6),
          },
          thickness: t,
          color,
        });
      }
      return;
    }
    case 'text': {
      const size = item.fontSize ?? 13;
      const font = item.bold ? p.fonts.bold : p.fonts.regular;
      const lines = wrapText(p.fonts.clean(item.text || '', item.bold), font, size, Math.max(20, fr.w - 4));
      lines.forEach((l, i) => {
        const pt = fr.at(2, size * 0.95 + i * size * 1.3);
        p.text(l, { x: pt.x, y: pt.y, size, color, rotate: fr.rot, bold: item.bold });
      });
      return;
    }
    case 'note': {
      p.rect({
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        fill: rgb(1, 0.96, 0.72),
        stroke: rgb(0.85, 0.65, 0.1),
        strokeWidth: 1,
      });
      const size = 9.5;
      const lines = wrapText(p.fonts.clean(item.text || 'Note'), p.fonts.regular, size, Math.max(20, fr.w - 12));
      const maxLines = Math.max(1, Math.floor((fr.h - 8) / (size * 1.25)));
      lines.slice(0, maxLines).forEach((l, i) => {
        const pt = fr.at(6, 14 + i * size * 1.25);
        p.text(l, { x: pt.x, y: pt.y, size, color: rgb(0.2, 0.16, 0.04), rotate: fr.rot });
      });
      return;
    }
    case 'stamp': {
      const label = item.stampLabel || item.text || 'APPROUVÉ';
      p.rect({ x: box.x, y: box.y, w: box.w, h: box.h, fill: color, opacity: 0.12 });
      p.rect({ x: box.x, y: box.y, w: box.w, h: box.h, stroke: color, strokeWidth: 2.5 });
      const size = Math.max(11, Math.min(20, fr.h * 0.45));
      const pt = fr.at(10, fr.h * 0.66);
      p.text(label, { x: pt.x, y: pt.y, size, color, rotate: fr.rot, bold: true });
      return;
    }
    default:
      return;
  }
}

// ---------- Real PDF annotations ----------

export const ANNOTATION_SUBTYPES: Partial<Record<OverlayItem['kind'], string>> = {
  highlight: 'Highlight',
  rect: 'Square',
  ellipse: 'Circle',
  draw: 'Ink',
  arrow: 'Line',
  text: 'FreeText',
  note: 'FreeText',
  stamp: 'Stamp',
};

const FPDF_KEY = PDFName.of('FPDF');

export function addPdfAnnotation(
  doc: PDFDocument,
  page: PDFPage,
  item: OverlayItem,
  ops: OpsPainter,
  box: Box,
  rawW: number,
  rawH: number,
  rotDeg: number
) {
  const subtype = ANNOTATION_SUBTYPES[item.kind];
  const b = ops.bounds();
  if (!subtype || !b) return;
  const rect = b.map((v) => Math.round(v * 100) / 100) as [number, number, number, number];
  const ctx = doc.context;
  const ap = ctx.formXObject(ops.ops, { BBox: rect, Resources: ops.resources(doc) });
  const [r, g, bl] = hexToRgbTuple(item.color || '#1746d1');
  const map = (pt: { x: number; y: number }) => visualToPdfCoords(pt.x, pt.y, rawW, rawH, rotDeg);
  const contents = item.text || item.stampLabel || '';
  // Our own data, so F-pdf can turn the annotation back into an editable overlay
  const payload = JSON.stringify({ ...item, _rect: rect });

  const extra: Record<string, unknown> = {};
  if (subtype === 'Highlight') {
    extra.QuadPoints = [box.x, box.y + box.h, box.x + box.w, box.y + box.h, box.x, box.y, box.x + box.w, box.y];
  } else if (subtype === 'Square' || subtype === 'Circle') {
    extra.BS = { W: item.strokeWidth ?? 2 };
  } else if (subtype === 'Ink') {
    extra.InkList = [(item.points ?? []).flatMap((pt) => {
      const m = map(pt);
      return [m.x, m.y];
    })];
    extra.BS = { W: item.strokeWidth ?? 2.2 };
  } else if (subtype === 'Line' && item.points && item.points.length >= 2) {
    const s = map(item.points[0]);
    const e = map(item.points[item.points.length - 1]);
    extra.L = [s.x, s.y, e.x, e.y];
    extra.LE = ['None', 'OpenArrow'];
    extra.BS = { W: item.strokeWidth ?? 2.2 };
  } else if (subtype === 'FreeText') {
    const size = item.kind === 'note' ? 9.5 : (item.fontSize ?? 13);
    extra.DA = PDFString.of(`/F1 ${size} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${bl.toFixed(3)} rg`);
  }

  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: subtype,
    Rect: rect,
    C: [r, g, bl],
    F: 4, // print
    NM: PDFString.of(`fpdf-${item.id}`),
    T: PDFHexString.fromText(item.author || 'F-pdf'),
    M: PDFString.fromDate(new Date()),
    Contents: PDFHexString.fromText(contents),
    AP: { N: ctx.register(ap) },
    ...extra,
  });
  annot.set(FPDF_KEY, PDFHexString.fromText(payload));
  page.node.addAnnot(ctx.register(annot));
}

/**
 * Turns the annotations written by F-pdf back into editable overlays and removes them
 * from the document (they are written again on save). Annotations moved or edited in
 * another program, and annotations from other programs, are left untouched.
 */
export async function importFpdfAnnotations(
  bytes: Uint8Array
): Promise<{ bytes: Uint8Array; overlays: OverlayItem[] }> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    return { bytes, overlays: [] };
  }
  const overlays: OverlayItem[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const dict = annots.lookupMaybe(i, PDFDict);
      const data = dict?.lookup(FPDF_KEY);
      if (!dict || !(data instanceof PDFHexString || data instanceof PDFString)) continue;
      try {
        const parsed = JSON.parse(data.decodeText()) as OverlayItem & { _rect?: number[] };
        const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map((n) => Number(n.toString()));
        const unchanged =
          rect && parsed._rect && rect.length === 4 && rect.every((v, k) => Math.abs(v - parsed._rect![k]) < 0.6);
        if (!unchanged) continue; // edited elsewhere: keep it as a regular annotation
        delete parsed._rect;
        overlays.push({ ...parsed, pageIndex });
        annots.remove(i);
      } catch {
        // not ours / corrupted: leave as is
      }
    }
  });
  if (overlays.length === 0) return { bytes, overlays };
  return { bytes: await doc.save(), overlays };
}

// ---------- OCR text layer ----------

/** Invisible but selectable/searchable text placed over the recognized lines. */
export function drawOcrLayer(
  page: PDFPage,
  fonts: FontSet,
  item: OverlayItem,
  rawW: number,
  rawH: number,
  rotDeg: number
) {
  const font = fonts.regular;
  if (item.lines && item.lines.length) {
    for (const line of item.lines) {
      const text = fonts.clean(line.text.trim());
      if (!text) continue;
      const fr = makeFrame(line, rawW, rawH, rotDeg);
      const unitWidth = font.widthOfTextAtSize(text, 1) || 1;
      const size = Math.max(2, Math.min(fr.h * 0.9, fr.w / unitWidth));
      const pt = fr.at(0, fr.h * 0.8);
      page.drawText(text, { x: pt.x, y: pt.y, size, font, opacity: 0, rotate: degrees(fr.rot) });
    }
    return;
  }
  // Older layer format: plain text block from the top of the page
  const fr = makeFrame(item, rawW, rawH, rotDeg);
  const lines = fonts.clean(item.text || '').split('\n');
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    const pt = fr.at(2, 10 + i * 12);
    page.drawText(l, { x: pt.x, y: pt.y, size: 9, font, opacity: 0, rotate: degrees(fr.rot) });
  });
}

// ---------- Passwords ----------

export function isPasswordError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? '';
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return name === 'PasswordException' || /password/i.test(msg);
}

/** Opens a protected PDF with its password and returns an unprotected copy for editing. */
export async function decryptPdf(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { password, updateMetadata: false });
  // Objects are decrypted while parsing. Leftovers of the original file (old cross-reference
  // streams and the security dictionary) would make the copy look encrypted again: drop them.
  doc.context.trailerInfo.Encrypt = undefined;
  const typeKey = PDFName.of('Type');
  const filterKey = PDFName.of('Filter');
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
    if (!dict) continue;
    const isXref = dict.get(typeKey) === PDFName.of('XRef');
    const isSecurity = dict.get(filterKey) === PDFName.of('Standard') && dict.has(PDFName.of('O'));
    if (isXref || isSecurity) doc.context.delete(ref);
  }
  return doc.save();
}

/** Protects the PDF with AES-256 and the chosen permissions. */
export async function encryptPdf(bytes: Uint8Array, sec: PdfSecurity): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  doc.encrypt({
    userPassword: sec.userPassword,
    ownerPassword: sec.ownerPassword || sec.userPassword,
    permissions: {
      printing: sec.allowPrint ? 'highResolution' : false,
      copying: sec.allowCopy,
      modifying: sec.allowModify,
      annotating: sec.allowModify,
      documentAssembly: sec.allowModify,
      fillingForms: true,
      contentAccessibility: true,
    },
  });
  return doc.save();
}
