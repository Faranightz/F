// In-place text editing of a page content stream, the way desktop PDF editors do it:
// the text-showing operators of an edited line are rewritten, so the new text keeps the
// document's own font, size, colour and spacing, and the old text is really gone.
//
// - The new text is encoded with the original font when every character exists in it
//   (embedded fonts are often subsets). Otherwise a matching standard font (serif / sans /
//   mono, bold, italic) or DejaVu (non-Latin text) takes over, only for that text.
// - Glyph widths are read from the fonts, so every removed operator is replaced by an exact
//   move: the rest of the page never shifts.
// - Anything not understood (inline images, Type3 or unusual CMaps...) leaves the stream
//   untouched and the caller falls back to drawing the text on top.
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  StandardFonts,
  StandardFontEmbedder,
  decodePDFRawStream,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
  type PDFRef,
} from '@cantoo/pdf-lib';

// ---------- Matrices ----------

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (m1: Matrix, m2: Matrix): Matrix => [
  m1[0] * m2[0] + m1[1] * m2[2],
  m1[0] * m2[1] + m1[1] * m2[3],
  m1[2] * m2[0] + m1[3] * m2[2],
  m1[2] * m2[1] + m1[3] * m2[3],
  m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
  m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
];
const fmt = (n: number) => (Math.abs(n) < 1e-9 ? '0' : String(Math.round(n * 10000) / 10000));

// ---------- Lexer ----------

interface Token {
  kind: 'num' | 'op' | 'str' | 'name' | 'other';
  value: string;
  start: number;
  end: number;
}

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const DELIMS = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

function tokenize(s: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (isWhite(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === 0x25) {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
      continue;
    }
    if (c === 0x28) {
      let depth = 0;
      for (; i < n; i++) {
        const ch = s[i];
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) {
          i++;
          break;
        }
      }
      if (depth !== 0) return null;
      tokens.push({ kind: 'str', value: s.slice(start, i), start, end: i });
      continue;
    }
    if (c === 0x3c && s[i + 1] === '<') {
      tokens.push({ kind: 'other', value: '<<', start, end: i + 2 });
      i += 2;
      continue;
    }
    if (c === 0x3e && s[i + 1] === '>') {
      tokens.push({ kind: 'other', value: '>>', start, end: i + 2 });
      i += 2;
      continue;
    }
    if (c === 0x3c) {
      const close = s.indexOf('>', i);
      if (close < 0) return null;
      i = close + 1;
      tokens.push({ kind: 'str', value: s.slice(start, i), start, end: i });
      continue;
    }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      tokens.push({ kind: 'other', value: s[i], start, end: i + 1 });
      i++;
      continue;
    }
    if (c === 0x2f) {
      i++;
      while (i < n && !isWhite(s.charCodeAt(i)) && !DELIMS.has(s.charCodeAt(i))) i++;
      tokens.push({ kind: 'name', value: s.slice(start + 1, i), start, end: i });
      continue;
    }
    while (i < n && !isWhite(s.charCodeAt(i)) && !DELIMS.has(s.charCodeAt(i))) i++;
    if (i === start) return null;
    const value = s.slice(start, i);
    if (value === 'BI') return null; // inline image (binary data)
    const kind = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(value) ? 'num' : /^(true|false|null)$/.test(value) ? 'other' : 'op';
    tokens.push({ kind, value, start, end: i });
  }
  return tokens;
}

/** Bytes of a (literal) or <hex> string token. */
function stringBytes(tok: string): number[] {
  if (tok.startsWith('<')) {
    const hex = tok.slice(1, -1).replace(/\s+/g, '');
    const out: number[] = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt((hex[i] + (hex[i + 1] ?? '0')), 16));
    return out;
  }
  const body = tok.slice(1, -1);
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      out.push(body.charCodeAt(i) & 0xff);
      continue;
    }
    const nx = body[++i];
    if (nx === undefined) break;
    const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
    if (nx in map) out.push(map[nx]);
    else if (nx === '\r' || nx === '\n') {
      if (nx === '\r' && body[i + 1] === '\n') i++;
    } else if (/[0-7]/.test(nx)) {
      let oct = nx;
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) oct += body[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else out.push(nx.charCodeAt(0) & 0xff);
  }
  return out;
}

// ---------- Fonts of the page ----------

// Windows-1252 bytes 0x80-0x9F -> Unicode
const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

interface FontInfo {
  resourceName: string;
  twoByte: boolean;
  widths: Map<number, number>; // code -> width (1/1000 text space)
  defaultWidth: number | null; // null: unknown widths -> positions cannot be followed
  toUnicode: Map<number, string>;
  fromUnicode: Map<string, number>;
  style: { serif: boolean; mono: boolean; bold: boolean; italic: boolean };
}

function num(obj: unknown): number | null {
  return obj instanceof PDFNumber ? obj.asNumber() : null;
}

function parseCMapHex(h: string): number {
  return parseInt(h, 16);
}

function utf16HexToString(h: string): string {
  if (h.length <= 2) return h ? String.fromCharCode(parseInt(h, 16)) : '';
  let s = '';
  for (let i = 0; i + 3 < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  return s;
}

function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const blocks = (re: RegExp) => [...text.matchAll(re)].map((m) => m[1]);
  for (const block of blocks(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseCMapHex(m[1]), utf16HexToString(m[2]));
    }
  }
  for (const block of blocks(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const lo = parseCMapHex(m[1]);
      const hi = parseCMapHex(m[2]);
      if (hi - lo > 0xffff) continue;
      if (m[3].startsWith('[')) {
        const items = [...m[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => x[1]);
        items.forEach((d, k) => map.set(lo + k, utf16HexToString(d)));
      } else {
        const dst = m[3].slice(1, -1);
        const base = parseInt(dst.slice(-4), 16);
        const prefix = dst.length > 4 ? utf16HexToString(dst.slice(0, -4)) : '';
        for (let code = lo; code <= hi; code++) map.set(code, prefix + String.fromCharCode(base + code - lo));
      }
    }
  }
  return map;
}

function streamText(doc: PDFDocument, obj: unknown): string | null {
  const st = obj instanceof PDFRawStream ? obj : doc.context.lookup(obj as PDFRef);
  if (!(st instanceof PDFRawStream)) return null;
  try {
    return bytesToLatin1(decodePDFRawStream(st).decode());
  } catch {
    return null;
  }
}

function loadFontInfo(doc: PDFDocument, resourceName: string, dict: PDFDict): FontInfo | null {
  const subtype = dict.lookup(PDFName.of('Subtype'));
  if (subtype === PDFName.of('Type3')) return null;
  const isType0 = subtype === PDFName.of('Type0');
  const widths = new Map<number, number>();
  let defaultWidth: number | null = null;
  let descriptorDict: PDFDict | undefined;
  const baseFont = String(dict.lookup(PDFName.of('BaseFont')) ?? '');

  if (isType0) {
    const enc = dict.lookup(PDFName.of('Encoding'));
    if (enc !== PDFName.of('Identity-H')) return null; // other CMaps not handled
    const desc = dict.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
    descriptorDict = desc.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    defaultWidth = num(desc.lookup(PDFName.of('DW'))) ?? 1000;
    const w = desc.lookupMaybe(PDFName.of('W'), PDFArray);
    if (w) {
      const arr = w.asArray().map((o) => doc.context.lookup(o));
      for (let i = 0; i < arr.length; ) {
        const first = num(arr[i]);
        const next = arr[i + 1];
        if (first === null) break;
        if (next instanceof PDFArray) {
          next.asArray().forEach((v, k) => {
            const wv = num(doc.context.lookup(v));
            if (wv !== null) widths.set(first + k, wv);
          });
          i += 2;
        } else {
          const last = num(next);
          const wv = num(arr[i + 2]);
          if (last === null || wv === null) break;
          for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, wv);
          i += 3;
        }
      }
    }
  } else {
    descriptorDict = dict.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    const firstChar = num(dict.lookup(PDFName.of('FirstChar')));
    const w = dict.lookupMaybe(PDFName.of('Widths'), PDFArray);
    if (firstChar !== null && w) {
      w.asArray().forEach((v, k) => {
        const wv = num(doc.context.lookup(v));
        if (wv !== null) widths.set(firstChar + k, wv);
      });
      defaultWidth = num(descriptorDict?.lookup(PDFName.of('MissingWidth'))) ?? 0;
    }
  }

  const toUnicode = new Map<number, string>();
  const tu = dict.get(PDFName.of('ToUnicode'));
  const tuText = tu ? streamText(doc, tu) : null;
  if (tuText) for (const [k, v] of parseToUnicode(tuText)) toUnicode.set(k, v);
  if (!isType0 && toUnicode.size === 0) {
    const enc = dict.lookup(PDFName.of('Encoding'));
    const isWinAnsi =
      enc === PDFName.of('WinAnsiEncoding') ||
      (enc instanceof PDFDict &&
        enc.lookup(PDFName.of('BaseEncoding')) === PDFName.of('WinAnsiEncoding') &&
        !enc.has(PDFName.of('Differences')));
    if (isWinAnsi) {
      for (let c = 32; c < 256; c++) {
        const u = c >= 0x80 && c <= 0x9f ? CP1252_HIGH[c - 0x80] : c;
        if (u) toUnicode.set(c, String.fromCharCode(u));
      }
    }
  }
  // Standard 14 fonts are often used without /Widths: take their metrics from the AFM data
  if (!isType0 && widths.size === 0) {
    const std = standardFontName(baseFont);
    if (std) {
      if (toUnicode.size === 0) {
        for (let c = 32; c < 127; c++) toUnicode.set(c, String.fromCharCode(c));
      }
      const embedder = StandardFontEmbedder.for(std as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);
      for (const [code, u] of toUnicode) {
        try {
          widths.set(code, embedder.widthOfTextAtSize(u, 1000));
        } catch {
          // character outside the font encoding
        }
      }
      defaultWidth = 0;
    }
  }

  const fromUnicode = new Map<string, number>();
  for (const [code, u] of toUnicode) {
    if (u.length === 1 && !fromUnicode.has(u)) fromUnicode.set(u, code);
  }

  const flags = num(descriptorDict?.lookup(PDFName.of('Flags'))) ?? 0;
  const lower = baseFont.toLowerCase();
  const style = {
    mono: (flags & 1) !== 0 || /courier|mono|consol/.test(lower),
    serif: (flags & 2) !== 0 || /times|serif|georgia|garamond|cambria|roman/.test(lower.replace('sans', '')),
    italic: (flags & 64) !== 0 || /italic|oblique/.test(lower),
    bold: (flags & 262144) !== 0 || /bold|black|heavy|semibold|demi/.test(lower),
  };
  if (/sans/.test(lower)) style.serif = false;
  return { resourceName, twoByte: isType0, widths, defaultWidth, toUnicode, fromUnicode, style };
}

/** Maps a BaseFont name to one of the standard 14 fonts (Arial is metric-compatible with Helvetica). */
function standardFontName(baseFont: string): StandardFonts | null {
  const name = baseFont.replace(/^\/?([A-Z]{6}\+)?/, '').replace(/MT$|PSMT$/, '');
  const lower = name.toLowerCase();
  const bold = /bold/.test(lower);
  const italic = /italic|oblique/.test(lower);
  if (/^(helvetica|arial)/.test(lower)) {
    return bold && italic
      ? StandardFonts.HelveticaBoldOblique
      : bold
        ? StandardFonts.HelveticaBold
        : italic
          ? StandardFonts.HelveticaOblique
          : StandardFonts.Helvetica;
  }
  if (/^times/.test(lower)) {
    return bold && italic
      ? StandardFonts.TimesRomanBoldItalic
      : bold
        ? StandardFonts.TimesRomanBold
        : italic
          ? StandardFonts.TimesRomanItalic
          : StandardFonts.TimesRoman;
  }
  if (/^courier/.test(lower)) {
    return bold && italic
      ? StandardFonts.CourierBoldOblique
      : bold
        ? StandardFonts.CourierBold
        : italic
          ? StandardFonts.CourierOblique
          : StandardFonts.Courier;
  }
  return null;
}

function pageFonts(doc: PDFDocument, page: PDFPage): Map<string, FontInfo | null> {
  const out = new Map<string, FontInfo | null>();
  const res = page.node.Resources();
  const fonts = res?.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fonts) return out;
  for (const [key, ref] of fonts.entries()) {
    const dict = doc.context.lookup(ref);
    const name = key.asString().slice(1);
    try {
      out.set(name, dict instanceof PDFDict ? loadFontInfo(doc, name, dict) : null);
    } catch {
      out.set(name, null);
    }
  }
  return out;
}

const codesOf = (bytes: number[], twoByte: boolean) => {
  if (!twoByte) return bytes;
  const codes: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) codes.push((bytes[i] << 8) | bytes[i + 1]);
  return codes;
};

// ---------- Editing ----------

export interface RawBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextEdit {
  box: RawBox; // raw PDF coordinates of the original line
  text: string; // new text (may contain line breaks)
  sizeRatio: number; // new size / original size (1 = unchanged)
  forceBold: boolean | null; // null = keep the original weight
  color: [number, number, number] | null; // null = keep the original colour
}

export interface EditResult {
  replaced: boolean; // rewritten in place (nothing else to draw)
  removedAll: boolean; // old text entirely removed (no white cover needed)
  style: FontInfo['style'] | null; // style of the original font (for a fallback drawing)
}

export interface FallbackFonts {
  get: (style: FontInfo['style'], text: string) => Promise<PDFFont | null>;
}

interface ShowOp {
  start: number; // start offset of operands
  end: number; // end offset of operator
  opName: string;
  x: number;
  y: number; // user-space start point
  advance: number | null; // horizontal advance in text space units (null = unknown)
  font: FontInfo | null;
  fontName: string;
  fontSize: number;
  th: number; // horizontal scaling (Tz/100)
  tm: Matrix; // text matrix at start
  tlm: Matrix; // line matrix at start
  fill: string; // operators that restore the current fill colour
  rest: string; // for ' and ": operators to keep (T*, Tw, Tc)
}

function analyse(content: string, fonts: Map<string, FontInfo | null>) {
  const tokens = tokenize(content);
  if (!tokens) return null;
  const shows: ShowOp[] = [];
  let ctm: Matrix = IDENTITY;
  const stack: Array<{ ctm: Matrix; fill: string; font: string; size: number; tc: number; tw: number; th: number; tl: number }> = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let posKnown = false;
  let fontName = '';
  let font: FontInfo | null = null;
  let fontSize = 0;
  let tc = 0;
  let tw = 0;
  let th = 1;
  let tl = 0;
  let fillCs = '';
  let fill = '0 g';
  let operandStart = -1;
  let operands: Token[] = [];

  // Horizontal advance of a show operator (TJ arrays mix strings and position numbers)
  const advanceOf = (items: Token[]): number | null => {
    if (!font || font.defaultWidth === null) return null;
    let tx = 0;
    for (const t of items) {
      tx += t.kind === 'num' ? (-Number(t.value) / 1000) * fontSize * th : stringAdvance(stringBytes(t.value));
    }
    return tx;
  };
  const stringAdvance = (bytes: number[]) => {
    let tx = 0;
    for (const code of codesOf(bytes, font!.twoByte)) {
      const w0 = (font!.widths.get(code) ?? font!.defaultWidth ?? 0) / 1000;
      const wordSpace = !font!.twoByte && code === 32 ? tw : 0;
      tx += (w0 * fontSize + tc + wordSpace) * th;
    }
    return tx;
  };
  const translate = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
    posKnown = true;
  };
  const show = (start: number, end: number, opName: string, items: Token[], rest: string) => {
    const m = mul(tm, ctm);
    const adv = advanceOf(items);
    shows.push({
      start,
      end,
      opName,
      x: posKnown ? m[4] : NaN,
      y: posKnown ? m[5] : NaN,
      advance: posKnown ? adv : null,
      font,
      fontName,
      fontSize,
      th,
      tm,
      tlm,
      fill: `${fillCs}${fill}`,
      rest,
    });
    if (posKnown && adv !== null) tm = mul([1, 0, 0, 1, adv, 0], tm);
    else posKnown = false;
  };

  for (const t of tokens) {
    if (t.kind !== 'op') {
      if (operandStart < 0) operandStart = t.start;
      operands.push(t);
      continue;
    }
    const start = operandStart >= 0 ? operandStart : t.start;
    const nums = operands.filter((o) => o.kind === 'num').map((o) => Number(o.value));
    const last = (k: number) => nums.slice(-k);
    switch (t.value) {
      case 'q':
        stack.push({ ctm, fill: `${fillCs}|${fill}`, font: fontName, size: fontSize, tc, tw, th, tl });
        break;
      case 'Q': {
        const st = stack.pop();
        if (st) {
          ctm = st.ctm;
          [fillCs, fill] = st.fill.split('|') as [string, string];
          fontName = st.font;
          font = fonts.get(fontName) ?? null;
          fontSize = st.size;
          tc = st.tc;
          tw = st.tw;
          th = st.th;
          tl = st.tl;
        }
        break;
      }
      case 'cm':
        if (nums.length >= 6) ctm = mul(last(6) as Matrix, ctm);
        break;
      case 'BT':
        tm = tlm = IDENTITY;
        posKnown = true;
        break;
      case 'ET':
        posKnown = false;
        break;
      case 'Tf': {
        const nameTok = operands.find((o) => o.kind === 'name');
        fontName = nameTok?.value ?? '';
        font = fonts.get(fontName) ?? null;
        fontSize = nums[nums.length - 1] ?? fontSize;
        break;
      }
      case 'Tc':
        tc = nums[0] ?? 0;
        break;
      case 'Tw':
        tw = nums[0] ?? 0;
        break;
      case 'Tz':
        th = (nums[0] ?? 100) / 100;
        break;
      case 'TL':
        tl = nums[0] ?? tl;
        break;
      case 'Td':
        translate(nums[0] ?? 0, nums[1] ?? 0);
        break;
      case 'TD':
        tl = -(nums[1] ?? 0);
        translate(nums[0] ?? 0, nums[1] ?? 0);
        break;
      case 'Tm':
        if (nums.length >= 6) {
          tm = tlm = last(6) as Matrix;
          posKnown = true;
        }
        break;
      case 'T*':
        translate(0, -tl);
        break;
      case 'Tj':
        show(start, t.end, 'Tj', operands.filter((o) => o.kind === 'str'), '');
        break;
      case 'TJ':
        show(start, t.end, 'TJ', operands.filter((o) => o.kind === 'str' || o.kind === 'num'), '');
        break;
      case "'":
        translate(0, -tl);
        show(start, t.end, "'", operands.filter((o) => o.kind === 'str'), 'T*');
        break;
      case '"': {
        const [aw, ac] = nums;
        tw = aw ?? tw;
        tc = ac ?? tc;
        translate(0, -tl);
        show(start, t.end, '"', operands.filter((o) => o.kind === 'str'), `${fmt(tw)} Tw ${fmt(tc)} Tc T*`);
        break;
      }
      // Fill colour (to restore it after a recoloured edit)
      case 'g':
      case 'rg':
      case 'k':
        fillCs = '';
        fill = content.slice(start, t.end);
        break;
      case 'cs':
        fillCs = `${content.slice(start, t.end)} `;
        break;
      case 'sc':
      case 'scn':
        fill = content.slice(start, t.end);
        break;
      default:
        break;
    }
    operandStart = -1;
    operands = [];
  }
  return shows;
}

const toHex = (codes: number[], twoByte: boolean) =>
  `<${codes.map((c) => c.toString(16).padStart(twoByte ? 4 : 2, '0')).join('')}>`;

/** Encodes text with a font of the page, or null if a character is missing from it. */
function encodeWithFont(font: FontInfo, text: string): { hex: string; widths: number } | null {
  const codes: number[] = [];
  let widths = 0;
  for (const ch of text) {
    const code = font.fromUnicode.get(ch);
    if (code === undefined) return null;
    const w = font.widths.get(code);
    if (w === undefined && font.twoByte) return null; // glyph absent from the subset
    widths += w ?? font.defaultWidth ?? 0;
    codes.push(code);
  }
  return { hex: toHex(codes, font.twoByte), widths };
}

/**
 * Rewrites the edited lines of a page in place. Returns one result per edit.
 */
export async function editPageText(
  doc: PDFDocument,
  page: PDFPage,
  edits: TextEdit[],
  fallback: FallbackFonts
): Promise<EditResult[]> {
  const none = edits.map(() => ({ replaced: false, removedAll: false, style: null }));
  try {
    const contents = page.node.Contents();
    if (!contents) return none;
    const streams =
      contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
    if (!streams.every((st) => st instanceof PDFRawStream)) return none;
    const content = (streams as PDFRawStream[]).map((st) => bytesToLatin1(decodePDFRawStream(st).decode())).join('\n');
    const fonts = pageFonts(doc, page);
    const shows = analyse(content, fonts);
    if (!shows) return none;

    const inBox = (s: ShowOp, b: RawBox) =>
      Number.isFinite(s.x) && s.x >= b.x - 3 && s.x <= b.x + b.w && s.y >= b.y - 3 && s.y <= b.y + b.h + 3;
    const replacements = new Map<ShowOp, string>();
    const results: EditResult[] = [];
    const extraFonts = new Map<PDFFont, string>();
    let fontCounter = 0;
    const resourceFor = (pdfFont: PDFFont) => {
      if (!extraFonts.has(pdfFont)) {
        let name = '';
        const existing = new Set(fonts.keys());
        do {
          name = `FpdfE${++fontCounter}`;
        } while (existing.has(name));
        extraFonts.set(pdfFont, name);
      }
      return extraFonts.get(pdfFont)!;
    };

    for (const edit of edits) {
      const line = shows.filter((s) => inBox(s, edit.box) && !replacements.has(s));
      if (line.length === 0) {
        results.push({ replaced: false, removedAll: false, style: null });
        continue;
      }
      line.sort((a, b) => a.start - b.start);
      const first = line[0];
      // Every operator must have a known advance to be replaced by an exact move
      if (line.some((s) => s.advance === null || !s.font)) {
        results.push({ replaced: false, removedAll: false, style: first.font?.style ?? null });
        continue;
      }
      const style = { ...first.font!.style, bold: edit.forceBold ?? first.font!.style.bold };
      const size = first.fontSize * edit.sizeRatio;
      const lines = edit.text.replace(/\r/g, '').split('\n');

      // Fonts, run by run (like Foxit): the document's own font for every character it holds,
      // a matching substitute only for the missing characters (or the whole line when the
      // weight was changed)
      const orig = first.font!;
      const keepWeight = edit.forceBold === null || edit.forceBold === orig.style.bold;
      const inOriginal = (ch: string) => keepWeight && encodeWithFont(orig, ch) !== null;
      const missing = [...lines.join('')].filter((ch) => !inOriginal(ch)).join('');
      const sub = missing ? await fallback.get(style, missing) : null;
      if (missing && !sub) {
        results.push({ replaced: false, removedAll: false, style });
        continue;
      }
      const subRes = sub ? resourceFor(sub) : '';
      const origTf = `/${first.fontName} ${fmt(size)} Tf`;
      // Encodes one line: operators + advance (text space units)
      const encodeLine = (t: string) => {
        const runs: Array<{ original: boolean; text: string }> = [];
        for (const ch of t) {
          const original = inOriginal(ch);
          const last = runs[runs.length - 1];
          if (last && last.original === original) last.text += ch;
          else runs.push({ original, text: ch });
        }
        let ops = '';
        let adv = 0;
        let current = Math.abs(size - first.fontSize) > 1e-6 ? '' : 'orig';
        for (const run of runs) {
          if (run.original) {
            if (current !== 'orig') ops += `${origTf} `;
            current = 'orig';
            const e = encodeWithFont(orig, run.text)!;
            ops += `${e.hex} Tj `;
            adv += (e.widths / 1000) * size * first.th;
          } else {
            if (current !== 'sub') ops += `/${subRes} ${fmt(size)} Tf `;
            current = 'sub';
            ops += `${sub!.encodeText(run.text).toString()} Tj `;
            adv += sub!.widthOfTextAtSize(run.text, size) * first.th;
          }
        }
        return { ops: ops.trim(), adv, switched: current !== 'orig' || Math.abs(size - first.fontSize) > 1e-6 };
      };
      const restoreFont = ` /${first.fontName} ${fmt(first.fontSize)} Tf`;
      const colour = edit.color ? `${edit.color.map(fmt).join(' ')} rg ` : '';
      const restoreColour = edit.color ? ` ${first.fill}` : '';

      // Text-space unit of the line, to turn advances into TJ moves
      const unit = (adv: number) => fmt((-adv * 1000) / (first.fontSize * first.th || 1));
      const tlm = first.tlm;
      const offset = tlm[0] !== 0 ? (first.tm[4] - tlm[4]) / tlm[0] : NaN;
      const multi = lines.length > 1 && Number.isFinite(offset);
      const firstLine = encodeLine(multi ? lines[0] : lines.join(' '));
      let out = `${first.rest ? `${first.rest} ` : ''}${colour}${firstLine.ops}`;
      if (multi) {
        // Extra lines below, then back to the original line state
        const lead = size * 1.25;
        lines.slice(1).forEach((l, k) => {
          const m = mul([1, 0, 0, 1, 0, -lead * (k + 1)], first.tm);
          out += ` ${m.map(fmt).join(' ')} Tm ${encodeLine(l).ops}`;
        });
        out += `${restoreFont}${restoreColour} ${tlm.map(fmt).join(' ')} Tm [${unit(offset + first.advance!)}] TJ`;
      } else {
        out += `${firstLine.switched ? restoreFont : ''}${restoreColour} [${unit(first.advance! - firstLine.adv)}] TJ`;
      }      replacements.set(first, out);
      for (const s of line.slice(1)) {
        replacements.set(s, `${s.rest ? `${s.rest} ` : ''}[${unit(s.advance!)}] TJ`);
      }
      results.push({ replaced: true, removedAll: true, style });
    }

    if (replacements.size === 0) return results;
    let out = '';
    let last = 0;
    for (const [s, rep] of [...replacements].sort((a, b) => a[0].start - b[0].start)) {
      out += content.slice(last, s.start) + rep;
      last = s.end;
    }
    out += content.slice(last);

    // Register the substitute fonts in the page resources
    if (extraFonts.size) {
      // Copy the resources so dictionaries shared with other pages are left untouched
      const res = (page.node.Resources() ?? doc.context.obj({})).clone(doc.context);
      let fontDict = res.lookupMaybe(PDFName.of('Font'), PDFDict);
      if (!fontDict) {
        fontDict = doc.context.obj({});
        res.set(PDFName.of('Font'), fontDict);
      } else {
        fontDict = fontDict.clone(doc.context);
        res.set(PDFName.of('Font'), fontDict);
      }
      for (const [f, name] of extraFonts) fontDict.set(PDFName.of(name), f.ref);
      page.node.set(PDFName.of('Resources'), res);
    }
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(latin1ToBytes(out))));
    return results;
  } catch {
    return none;
  }
}

/** Standard-font substitutes matching the original style (used when glyphs are missing). */
export function standardFallbackFonts(doc: PDFDocument, unicodeFont: () => Promise<PDFFont | null>): FallbackFonts {
  const cache = new Map<string, PDFFont>();
  return {
    async get(style, text) {
      const latin = [...text].every((ch) => {
        const cp = ch.codePointAt(0) ?? 0;
        return cp === 10 || (cp >= 32 && cp < 0x17f) || '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.includes(ch);
      });
      if (!latin) return unicodeFont();
      const family = style.mono ? 'Courier' : style.serif ? 'Times' : 'Helvetica';
      const key = `${family}-${style.bold}-${style.italic}`;
      if (!cache.has(key)) {
        const map: Record<string, StandardFonts> = {
          'Courier-false-false': StandardFonts.Courier,
          'Courier-true-false': StandardFonts.CourierBold,
          'Courier-false-true': StandardFonts.CourierOblique,
          'Courier-true-true': StandardFonts.CourierBoldOblique,
          'Times-false-false': StandardFonts.TimesRoman,
          'Times-true-false': StandardFonts.TimesRomanBold,
          'Times-false-true': StandardFonts.TimesRomanItalic,
          'Times-true-true': StandardFonts.TimesRomanBoldItalic,
          'Helvetica-false-false': StandardFonts.Helvetica,
          'Helvetica-true-false': StandardFonts.HelveticaBold,
          'Helvetica-false-true': StandardFonts.HelveticaOblique,
          'Helvetica-true-true': StandardFonts.HelveticaBoldOblique,
        };
        cache.set(key, await doc.embedFont(map[key]));
      }
      return cache.get(key)!;
    },
  };
}

// ---------- Byte helpers ----------

function bytesToLatin1(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}
function latin1ToBytes(s: string) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

