// Document-level tools: text lines per page, Word export, document comparison.
import type * as pdfjsLib from 'pdfjs-dist';

export interface TextLine {
  text: string;
  size: number; // font size in points
}

/** Rebuilds the text lines of each page from PDF.js text items (same baseline = same line). */
export async function extractPageLines(pdf: pdfjsLib.PDFDocumentProxy): Promise<TextLine[][]> {
  const pages: TextLine[][] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const rows: Array<{ y: number; x: number; size: number; parts: Array<{ x: number; s: string; w: number }> }> = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str) continue;
      const [, , c, d, x, y] = item.transform as number[];
      const size = Math.hypot(c, d) || 10;
      let row = rows.find((r) => Math.abs(r.y - y) < size * 0.4);
      if (!row) {
        row = { y, x, size, parts: [] };
        rows.push(row);
      }
      row.parts.push({ x, s: item.str, w: item.width });
      row.size = Math.max(row.size, size);
    }
    rows.sort((a, b) => b.y - a.y);
    pages.push(
      rows
        .map((r) => {
          const parts = r.parts.sort((a, b) => a.x - b.x);
          let text = '';
          let end = -Infinity;
          for (const p of parts) {
            if (text && p.x - end > r.size * 0.2 && !text.endsWith(' ') && !p.s.startsWith(' ')) text += ' ';
            text += p.s;
            end = p.x + p.w;
          }
          return { text: text.replace(/\s+/g, ' ').trim(), size: Math.round(r.size) };
        })
        .filter((l) => l.text)
    );
  }
  return pages;
}

export type DiffOp = { type: 'same' | 'added' | 'removed'; text: string };

/** Line diff (longest common subsequence). Inputs are bounded per page. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    // Too large for the table: report as full replacement
    return [...a.map((text) => ({ type: 'removed' as const, text })), ...b.map((text) => ({ type: 'added' as const, text }))];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'removed', text: a[i++] });
    } else {
      ops.push({ type: 'added', text: b[j++] });
    }
  }
  while (i < n) ops.push({ type: 'removed', text: a[i++] });
  while (j < m) ops.push({ type: 'added', text: b[j++] });
  return ops;
}

export interface PageComparison {
  page: number; // 1-based
  ops: DiffOp[];
  changes: number;
}

/** Compares two documents page by page (text only). */
export async function comparePdfDocuments(
  base: pdfjsLib.PDFDocumentProxy,
  other: pdfjsLib.PDFDocumentProxy
): Promise<PageComparison[]> {
  const [a, b] = await Promise.all([extractPageLines(base), extractPageLines(other)]);
  const total = Math.max(a.length, b.length);
  const result: PageComparison[] = [];
  for (let p = 0; p < total; p++) {
    const ops = diffLines((a[p] ?? []).map((l) => l.text), (b[p] ?? []).map((l) => l.text));
    result.push({ page: p + 1, ops, changes: ops.filter((o) => o.type !== 'same').length });
  }
  return result;
}
