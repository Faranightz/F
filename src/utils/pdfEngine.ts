import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  PageSizes,
} from 'pdf-lib';
import type {
  HeaderFooterConfig,
  OutlineEntry,
  OverlayItem,
  Point,
  SearchMatch,
  WatermarkConfig,
} from '../types/pdf';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// Safe WinAnsi encoder: preserves all French/European WinAnsi characters (éèêëàâäîïôöùûüçœŒ€«»’—–…)
// and replaces unsupported Unicode symbols without crashing pdf-lib.
const WINANSI_EXTENDED = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function toWinAnsiSafe(input: string): string {
  const normalized = input
    .replace(/\ufb01/g, 'fi')
    .replace(/\ufb02/g, 'fl')
    .replace(/\u00a0/g, ' ')
    .replace(/[✓✔]/g, '[v]')
    .replace(/[✗✘]/g, '[x]')
    .replace(/→/g, '->')
    .replace(/←/g, '<-')
    .replace(/≠/g, '!=')
    .replace(/≤/g, '<=')
    .replace(/≥/g, '>=');

  let out = '';
  for (const ch of normalized) {
    const cp = ch.codePointAt(0) ?? 32;
    if (
      cp === 10 ||
      cp === 13 ||
      (cp >= 0x20 && cp <= 0x7e) ||
      (cp >= 0xa0 && cp <= 0xff) ||
      WINANSI_EXTENDED.has(cp)
    ) {
      out += ch;
    } else {
      const stripped = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      if (stripped && stripped.charCodeAt(0) >= 0x20 && stripped.charCodeAt(0) <= 0x7e) {
        out += stripped;
      }
    }
  }
  return out;
}

const SAFE_IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;

function decodeSafeImageDataUrl(
  dataUrl: string
): { format: 'png' | 'jpeg'; bytes: Uint8Array } | null {
  const match = SAFE_IMAGE_DATA_URL_RE.exec(dataUrl.trim());
  if (!match) return null;
  const format = match[1] as 'png' | 'jpeg';
  const b64 = match[2];
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { format, bytes };
}

/**
 * Ensures any uploaded image (PNG, JPEG, WebP, GIF, BMP) is converted to a safe
 * data:image/png;base64 or data:image/jpeg;base64 URL so it never silently fails on PDF export.
 */
export async function normalizeImageFileToDataUrl(file: File): Promise<string> {
  if (file.type === 'image/png' || file.type === 'image/jpeg') {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('Lecture image impossible.'));
      reader.onerror = () => reject(new Error('Erreur de lecture du fichier image.'));
      reader.readAsDataURL(file);
    });
  }
  if (!file.type.startsWith('image/')) {
    throw new Error('Format non pris en charge. Choisissez une image PNG ou JPEG.');
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Image corrompue ou non supportée.'));
      el.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 400;
    canvas.height = img.naturalHeight || 200;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Contexte canvas indisponible.');
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0');
  const num = parseInt(full, 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  return [r, g, b];
}

// Convert normalized visual coordinates (top-left origin 0..1) into raw PDF page coordinates
// respecting page rotation (0, 90, 180, 270).
function visualToPdfCoords(
  nx: number,
  ny: number,
  rawW: number,
  rawH: number,
  rotDeg: number
): { x: number; y: number } {
  const r = ((rotDeg % 360) + 360) % 360;
  if (r === 90) {
    return { x: ny * rawW, y: nx * rawH };
  }
  if (r === 180) {
    return { x: (1 - nx) * rawW, y: ny * rawH };
  }
  if (r === 270) {
    return { x: (1 - ny) * rawW, y: (1 - nx) * rawH };
  }
  return { x: nx * rawW, y: (1 - ny) * rawH };
}

function visualRectToPdfBox(
  nx: number,
  ny: number,
  nw: number,
  nh: number,
  rawW: number,
  rawH: number,
  rotDeg: number
): { x: number; y: number; w: number; h: number } {
  const p1 = visualToPdfCoords(nx, ny, rawW, rawH, rotDeg);
  const p2 = visualToPdfCoords(nx + nw, ny + nh, rawW, rawH, rotDeg);
  const x = Math.min(p1.x, p2.x);
  const y = Math.min(p1.y, p2.y);
  const w = Math.abs(p2.x - p1.x);
  const h = Math.abs(p2.y - p1.y);
  return { x, y, w, h };
}

/**
 * Rotate existing normalized overlays on a page when the user rotates that page (±90°).
 */
export function rotateOverlaysForPage(
  overlays: OverlayItem[],
  pageIndex: number,
  deltaDegrees: number
): OverlayItem[] {
  const d = ((deltaDegrees % 360) + 360) % 360;
  if (d === 0) return overlays;

  const rotPt = (p: Point): Point => {
    if (d === 90) return { x: 1 - p.y, y: p.x };
    if (d === 270) return { x: p.y, y: 1 - p.x };
    if (d === 180) return { x: 1 - p.x, y: 1 - p.y };
    return p;
  };

  return overlays.map((item) => {
    if (item.pageIndex !== pageIndex) return item;
    const pts = item.points ? item.points.map(rotPt) : undefined;
    const c1 = rotPt({ x: item.x, y: item.y });
    const c2 = rotPt({ x: item.x + item.w, y: item.y + item.h });
    return {
      ...item,
      x: Math.min(c1.x, c2.x),
      y: Math.min(c1.y, c2.y),
      w: Math.abs(c2.x - c1.x),
      h: Math.abs(c2.y - c1.y),
      points: pts,
    };
  });
}

export async function createSamplePdf(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Page 1
  const p1 = pdfDoc.addPage(PageSizes.A4);
  const { width, height } = p1.getSize();

  p1.drawRectangle({
    x: 0,
    y: height - 115,
    width,
    height: 115,
    color: rgb(0.76, 0.25, 0.05),
  });

  p1.drawText('F — ÉDITEUR PDF WINDOWS', {
    x: 48,
    y: height - 54,
    size: 24,
    font: helveticaBold,
    color: rgb(1, 1, 1),
  });
  p1.drawText('Guide de démarrage et document de démonstration interactif', {
    x: 48,
    y: height - 82,
    size: 12,
    font: helvetica,
    color: rgb(1, 0.94, 0.88),
  });

  let y = height - 165;
  p1.drawText('1. Bienvenue dans F', {
    x: 48,
    y,
    size: 15,
    font: helveticaBold,
    color: rgb(0.12, 0.14, 0.17),
  });

  y -= 28;
  const lines1 = [
    'Ce document de démonstration multi-pages vous permet de tester immédiatement',
    'toutes les fonctionnalités de F directement depuis le ruban :',
    '',
    '  • Onglet Accueil : zoom Ctrl+Molette, main (pan), rotation, recherche plein texte.',
    '  • Onglet Commentaire : surlignage, stylo, formes, notes adhésives, tampons.',
    '  • Onglet Éditer : texte, images, caviardage, filigrane, en-têtes & purge métadonnées.',
    '  • Onglet Organiser : fusionner, diviser, extraire, pivoter, réordonner les pages.',
    '  • Onglet Formulaire & Signer : AcroForm natifs, signature locale & Yousign eIDAS.',
    '  • Onglet Convertir & OCR : OCR local + couche texte invisible et export PNG/JPEG/TXT.',
  ];
  for (const line of lines1) {
    p1.drawText(toWinAnsiSafe(line), {
      x: 48,
      y,
      size: 11,
      font: helvetica,
      color: rgb(0.22, 0.25, 0.3),
    });
    y -= 20;
  }

  p1.drawRectangle({
    x: 48,
    y: y - 90,
    width: width - 96,
    height: 78,
    color: rgb(0.99, 0.96, 0.92),
    borderColor: rgb(0.76, 0.25, 0.05),
    borderWidth: 1.2,
  });
  p1.drawText('Astuce rapide :', {
    x: 64,
    y: y - 34,
    size: 11,
    font: helveticaBold,
    color: rgb(0.76, 0.25, 0.05),
  });
  p1.drawText(
    'Glissez-déposez un fichier .pdf dans la fenêtre ou utilisez Ctrl+S pour enregistrer',
    {
      x: 64,
      y: y - 54,
      size: 10.5,
      font: helvetica,
      color: rgb(0.22, 0.25, 0.3),
    }
  );
  p1.drawText(
    'avec vos champs AcroForm interactifs, caviardages, signatures et couche OCR.',
    {
      x: 64,
      y: y - 70,
      size: 10.5,
      font: helvetica,
      color: rgb(0.22, 0.25, 0.3),
    }
  );

  // Page 2
  const p2 = pdfDoc.addPage(PageSizes.A4);
  p2.drawText('2. Zone de test : Contrat, Formulaire AcroForm & Yousign', {
    x: 48,
    y: height - 64,
    size: 15,
    font: helveticaBold,
    color: rgb(0.12, 0.14, 0.17),
  });
  p2.drawLine({
    start: { x: 48, y: height - 76 },
    end: { x: width - 48, y: height - 76 },
    thickness: 1,
    color: rgb(0.85, 0.87, 0.9),
  });

  const fields = [
    'Nom complet du signataire :',
    'Entreprise / Organisation :',
    'Adresse e-mail professionnelle :',
    'Date de validation :',
  ];
  let fy = height - 120;
  for (const label of fields) {
    p2.drawText(label, {
      x: 48,
      y: fy,
      size: 11,
      font: helveticaBold,
      color: rgb(0.2, 0.23, 0.28),
    });
    p2.drawRectangle({
      x: 230,
      y: fy - 6,
      width: 310,
      height: 24,
      borderColor: rgb(0.7, 0.74, 0.8),
      borderWidth: 1,
      color: rgb(0.98, 0.99, 1),
    });
    fy -= 44;
  }

  p2.drawText('Validation et approbation :', {
    x: 48,
    y: fy - 18,
    size: 12,
    font: helveticaBold,
    color: rgb(0.12, 0.14, 0.17),
  });
  p2.drawRectangle({
    x: 48,
    y: fy - 135,
    width: 240,
    height: 100,
    borderColor: rgb(0.7, 0.74, 0.8),
    borderWidth: 1,
    color: rgb(0.99, 0.99, 0.99),
  });
  p2.drawText('Zone de signature (locale ou Yousign)', {
    x: 76,
    y: fy - 125,
    size: 9.5,
    font: helvetica,
    color: rgb(0.5, 0.54, 0.6),
  });

  p2.drawRectangle({
    x: 310,
    y: fy - 135,
    width: 230,
    height: 100,
    borderColor: rgb(0.7, 0.74, 0.8),
    borderWidth: 1,
    color: rgb(0.99, 0.99, 0.99),
  });
  p2.drawText('Zone de tampon officiel', {
    x: 368,
    y: fy - 125,
    size: 9.5,
    font: helvetica,
    color: rgb(0.5, 0.54, 0.6),
  });

  // Page 3
  const p3 = pdfDoc.addPage(PageSizes.A4);
  p3.drawText('3. Organisation des pages & Reconnaissance OCR', {
    x: 48,
    y: height - 64,
    size: 16,
    font: helveticaBold,
    color: rgb(0.12, 0.14, 0.17),
  });
  p3.drawText(
    'Utilisez l’onglet Organiser pour réordonner, pivoter, dupliquer, diviser ou fusionner',
    {
      x: 48,
      y: height - 102,
      size: 11,
      font: helvetica,
      color: rgb(0.22, 0.25, 0.3),
    }
  );
  p3.drawText(
    'des documents PDF. L’onglet Convertir & OCR utilise un moteur WASM local sécurisé.',
    {
      x: 48,
      y: height - 122,
      size: 11,
      font: helvetica,
      color: rgb(0.22, 0.25, 0.3),
    }
  );

  const rows = [
    ['Module', 'Moteur utilisé', 'Statut'],
    ['Rendu & Zoom HiDPI', 'PDF.js (Web Worker local)', 'Actif'],
    ['Édition, AcroForm & Caviardage', 'pdf-lib (natif)', 'Actif'],
    ['Signature eIDAS', 'Yousign API v3 (DPAPI / Démo)', 'Actif'],
    ['OCR (FR / EN)', 'Tesseract.js (worker/WASM local)', 'Actif'],
    ['Build Windows (.exe)', 'Electron + icône + .pdf', 'Prêt'],
  ];
  let ty = height - 175;
  rows.forEach((row, idx) => {
    p3.drawRectangle({
      x: 48,
      y: ty - 8,
      width: width - 96,
      height: 28,
      color:
        idx === 0
          ? rgb(0.15, 0.18, 0.22)
          : idx % 2 === 0
            ? rgb(0.96, 0.97, 0.98)
            : rgb(1, 1, 1),
      borderColor: rgb(0.85, 0.87, 0.9),
      borderWidth: 0.7,
    });
    const textColor = idx === 0 ? rgb(1, 1, 1) : rgb(0.18, 0.21, 0.25);
    const font = idx === 0 ? helveticaBold : helvetica;
    p3.drawText(toWinAnsiSafe(row[0]), { x: 58, y: ty + 2, size: 10, font, color: textColor });
    p3.drawText(toWinAnsiSafe(row[1]), { x: 240, y: ty + 2, size: 10, font, color: textColor });
    p3.drawText(toWinAnsiSafe(row[2]), { x: 465, y: ty + 2, size: 10, font, color: textColor });
    ty -= 28;
  });

  return pdfDoc.save();
}

export async function createBlankPdf(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage(PageSizes.A4);
  return pdfDoc.save();
}

export async function loadPdfWithTask(bytes: Uint8Array): Promise<{
  task: pdfjsLib.PDFDocumentLoadingTask;
  doc: pdfjsLib.PDFDocumentProxy;
}> {
  const copy = new Uint8Array(bytes);
  const task = pdfjsLib.getDocument({ data: copy });
  const doc = await task.promise;
  return { task, doc };
}

export async function extractOutline(
  pdfProxy: pdfjsLib.PDFDocumentProxy
): Promise<OutlineEntry[]> {
  try {
    const raw = await pdfProxy.getOutline();
    if (!raw || raw.length === 0) {
      return Array.from({ length: pdfProxy.numPages }, (_, i) => ({
        title: `Page ${i + 1}`,
        pageIndex: i,
      }));
    }
    const entries: OutlineEntry[] = [];
    for (const item of raw) {
      let pageIndex = 0;
      if (typeof item.dest === 'string') {
        const dest = await pdfProxy.getDestination(item.dest);
        if (dest && dest[0]) {
          pageIndex = await pdfProxy.getPageIndex(dest[0] as never);
        }
      } else if (Array.isArray(item.dest) && item.dest[0]) {
        pageIndex = await pdfProxy.getPageIndex(item.dest[0] as never);
      }
      entries.push({ title: item.title || `Page ${pageIndex + 1}`, pageIndex });
    }
    return entries;
  } catch {
    return Array.from({ length: pdfProxy.numPages }, (_, i) => ({
      title: `Page ${i + 1}`,
      pageIndex: i,
    }));
  }
}

export async function searchPdfText(
  pdfProxy: pdfjsLib.PDFDocumentProxy,
  query: string
): Promise<SearchMatch[]> {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  const results: SearchMatch[] = [];
  for (let i = 1; i <= pdfProxy.numPages; i++) {
    const page = await pdfProxy.getPage(i);
    const content = await page.getTextContent();
    const fullText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    const lower = fullText.toLowerCase();
    const idx = lower.indexOf(trimmed);
    if (idx !== -1) {
      let count = 0;
      let pos = 0;
      while ((pos = lower.indexOf(trimmed, pos)) !== -1) {
        count++;
        pos += trimmed.length;
      }
      const start = Math.max(0, idx - 36);
      const end = Math.min(fullText.length, idx + trimmed.length + 54);
      const snippet =
        (start > 0 ? '…' : '') +
        fullText.slice(start, end).trim() +
        (end < fullText.length ? '…' : '');
      results.push({ pageIndex: i - 1, snippet, count });
    }
  }
  return results;
}

export async function extractAllText(
  pdfProxy: pdfjsLib.PDFDocumentProxy,
  overlays: OverlayItem[] = []
): Promise<string> {
  const chunks: string[] = [];
  for (let i = 1; i <= pdfProxy.numPages; i++) {
    const page = await pdfProxy.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ');
    const extraTexts = overlays
      .filter((o) => o.pageIndex === i - 1 && o.text)
      .map((o) => o.text)
      .join('\n');
    chunks.push(
      `--- Page ${i} ---\n${text}${extraTexts ? `\n[Annotations]\n${extraTexts}` : ''}`
    );
  }
  return chunks.join('\n\n');
}

export async function bakeEditsToPdf(
  sourceBytes: Uint8Array,
  overlays: OverlayItem[],
  watermark: WatermarkConfig,
  headerFooter: HeaderFooterConfig,
  purgeMetadata = false
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(sourceBytes);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const form = pdfDoc.getForm();
  const pages = pdfDoc.getPages();
  const totalPages = pages.length;

  if (purgeMetadata) {
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setCreator('');
    pdfDoc.setProducer('');
  }

  let fieldCounter = 0;

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const { width, height } = page.getSize();
    const rotDeg = ((page.getRotation().angle % 360) + 360) % 360;

    // 1. Watermark (rotation-aware centering)
    if (watermark.enabled && watermark.text.trim()) {
      const [r, g, b] = hexToRgbTuple(watermark.color);
      const wmText = toWinAnsiSafe(watermark.text);
      const wmSize = watermark.fontSize || 48;
      const textWidth = helveticaBold.widthOfTextAtSize(wmText, wmSize);
      const totalAngleDeg = (watermark.angle || 45) + rotDeg;
      const rad = (totalAngleDeg * Math.PI) / 180;
      const cx = width / 2;
      const cy = height / 2;
      page.drawText(wmText, {
        x: cx - (textWidth / 2) * Math.cos(rad),
        y: cy - (textWidth / 2) * Math.sin(rad),
        size: wmSize,
        font: helveticaBold,
        color: rgb(r, g, b),
        opacity: Math.max(0.05, Math.min(1, watermark.opacity)),
        rotate: degrees(totalAngleDeg),
      });
    }

    // 2. Header & Footer (rotation-aware)
    if (headerFooter.enabled) {
      const format = (tpl: string) =>
        toWinAnsiSafe(
          tpl
            .replace(/\{page\}/gi, String(pageIndex + 1))
            .replace(/\{total\}/gi, String(totalPages))
        );
      const metaColor = rgb(0.35, 0.38, 0.42);
      const rotOpt = rotDeg ? { rotate: degrees(rotDeg) } : {};
      if (headerFooter.headerLeft) {
        const pt = visualToPdfCoords(0.05, 0.03, width, height, rotDeg);
        page.drawText(format(headerFooter.headerLeft), {
          x: pt.x,
          y: pt.y,
          size: 9,
          font: helvetica,
          color: metaColor,
          ...rotOpt,
        });
      }
      if (headerFooter.headerRight) {
        const pt = visualToPdfCoords(0.75, 0.03, width, height, rotDeg);
        page.drawText(format(headerFooter.headerRight), {
          x: pt.x,
          y: pt.y,
          size: 9,
          font: helvetica,
          color: metaColor,
          ...rotOpt,
        });
      }
      if (headerFooter.footerLeft) {
        const pt = visualToPdfCoords(0.05, 0.97, width, height, rotDeg);
        page.drawText(format(headerFooter.footerLeft), {
          x: pt.x,
          y: pt.y,
          size: 9,
          font: helvetica,
          color: metaColor,
          ...rotOpt,
        });
      }
      if (headerFooter.footerRight) {
        const pt = visualToPdfCoords(0.78, 0.97, width, height, rotDeg);
        page.drawText(format(headerFooter.footerRight), {
          x: pt.x,
          y: pt.y,
          size: 9,
          font: helvetica,
          color: metaColor,
          ...rotOpt,
        });
      }
    }

    // 3. Page Overlays
    const pageOverlays = overlays.filter((o) => o.pageIndex === pageIndex);
    for (const item of pageOverlays) {
      // Visual-only Yousign placement guide is not baked into the PDF document
      if (item.kind === 'yousign-zone') continue;

      const [r, g, b] = hexToRgbTuple(item.color || '#c2410c');
      const box = visualRectToPdfBox(item.x, item.y, item.w, item.h, width, height, rotDeg);
      const { x: px, y: py, w: pw, h: ph } = box;
      const rotOpt = rotDeg ? { rotate: degrees(rotDeg) } : {};

      if (item.kind === 'redact') {
        page.drawRectangle({
          x: px,
          y: py,
          width: pw,
          height: ph,
          color: rgb(0, 0, 0),
          opacity: 1,
        });
      } else if (item.kind === 'ocr-layer' && item.text) {
        // Invisible searchable OCR text layer
        const safeText = toWinAnsiSafe(item.text);
        const lines = safeText.split('\n');
        let lineY = py + ph - 10;
        for (const l of lines) {
          if (l.trim()) {
            page.drawText(l, {
              x: px + 2,
              y: Math.max(10, lineY),
              size: 9,
              font: helvetica,
              color: rgb(0, 0, 0),
              opacity: 0,
              maxWidth: Math.max(40, pw - 4),
              ...rotOpt,
            });
          }
          lineY -= 12;
        }
      } else if (item.kind === 'highlight') {
        page.drawRectangle({
          x: px,
          y: py,
          width: pw,
          height: ph,
          color: rgb(r, g, b),
          opacity: item.opacity ?? 0.35,
        });
      } else if (item.kind === 'rect') {
        page.drawRectangle({
          x: px,
          y: py,
          width: pw,
          height: ph,
          borderColor: rgb(r, g, b),
          borderWidth: item.strokeWidth ?? 2,
          opacity: 0,
        });
      } else if (item.kind === 'ellipse') {
        page.drawEllipse({
          x: px + pw / 2,
          y: py + ph / 2,
          xScale: Math.max(1, pw / 2),
          yScale: Math.max(1, ph / 2),
          borderColor: rgb(r, g, b),
          borderWidth: item.strokeWidth ?? 2,
        });
      } else if (item.kind === 'draw' && item.points && item.points.length > 1) {
        for (let i = 1; i < item.points.length; i++) {
          const p0 = visualToPdfCoords(item.points[i - 1].x, item.points[i - 1].y, width, height, rotDeg);
          const p1 = visualToPdfCoords(item.points[i].x, item.points[i].y, width, height, rotDeg);
          page.drawLine({
            start: p0,
            end: p1,
            thickness: item.strokeWidth ?? 2.2,
            color: rgb(r, g, b),
          });
        }
      } else if (item.kind === 'arrow' && item.points && item.points.length >= 2) {
        const start = visualToPdfCoords(item.points[0].x, item.points[0].y, width, height, rotDeg);
        const end = visualToPdfCoords(
          item.points[item.points.length - 1].x,
          item.points[item.points.length - 1].y,
          width,
          height,
          rotDeg
        );
        page.drawLine({
          start,
          end,
          thickness: item.strokeWidth ?? 2.2,
          color: rgb(r, g, b),
        });
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const headLen = 11;
        page.drawLine({
          start: end,
          end: {
            x: end.x - headLen * Math.cos(angle - Math.PI / 6),
            y: end.y - headLen * Math.sin(angle - Math.PI / 6),
          },
          thickness: item.strokeWidth ?? 2.2,
          color: rgb(r, g, b),
        });
        page.drawLine({
          start: end,
          end: {
            x: end.x - headLen * Math.cos(angle + Math.PI / 6),
            y: end.y - headLen * Math.sin(angle + Math.PI / 6),
          },
          thickness: item.strokeWidth ?? 2.2,
          color: rgb(r, g, b),
        });
      } else if (item.kind === 'text') {
        const font = item.bold ? helveticaBold : helvetica;
        const size = item.fontSize ?? 13;
        const safeText = toWinAnsiSafe(item.text || '');
        const textLines = safeText.split('\n');
        let lineY = py + ph - size;
        for (const l of textLines) {
          page.drawText(l, {
            x: px + 2,
            y: lineY,
            size,
            font,
            color: rgb(r, g, b),
            maxWidth: Math.max(40, pw - 4),
            ...rotOpt,
          });
          lineY -= size * 1.3;
        }
      } else if (item.kind === 'note') {
        const noteW = Math.max(pw, 120);
        const noteH = Math.max(ph, 54);
        page.drawRectangle({
          x: px,
          y: py,
          width: noteW,
          height: noteH,
          color: rgb(1, 0.96, 0.72),
          borderColor: rgb(0.85, 0.65, 0.1),
          borderWidth: 1,
        });
        page.drawText(toWinAnsiSafe((item.text || 'Note').slice(0, 240)), {
          x: px + 6,
          y: py + noteH - 16,
          size: 9.5,
          font: helvetica,
          color: rgb(0.2, 0.16, 0.04),
          maxWidth: noteW - 12,
          ...rotOpt,
        });
      } else if (item.kind === 'stamp') {
        const label = toWinAnsiSafe(item.stampLabel || item.text || 'APPROUVÉ');
        page.drawRectangle({
          x: px,
          y: py,
          width: pw,
          height: ph,
          borderColor: rgb(r, g, b),
          borderWidth: 2.5,
          color: rgb(r, g, b),
          opacity: 0.12,
        });
        page.drawText(label, {
          x: px + 10,
          y: py + ph * 0.34,
          size: Math.max(11, Math.min(20, ph * 0.45)),
          font: helveticaBold,
          color: rgb(r, g, b),
          ...rotOpt,
        });
      } else if (
        (item.kind === 'image' || item.kind === 'signature') &&
        item.imageDataUrl
      ) {
        const decoded = decodeSafeImageDataUrl(item.imageDataUrl);
        if (decoded) {
          const img =
            decoded.format === 'png'
              ? await pdfDoc.embedPng(decoded.bytes)
              : await pdfDoc.embedJpg(decoded.bytes);
          page.drawImage(img, { x: px, y: py, width: pw, height: ph, ...rotOpt });
        }
      } else if (item.kind === 'form-text') {
        // Native interactive AcroForm text field!
        fieldCounter += 1;
        const tf = form.createTextField(`f_text_${pageIndex + 1}_${fieldCounter}`);
        if (item.text) tf.setText(toWinAnsiSafe(item.text));
        tf.addToPage(page, {
          x: px,
          y: py,
          width: Math.max(30, pw),
          height: Math.max(16, ph),
          borderColor: rgb(0.2, 0.45, 0.8),
          backgroundColor: rgb(0.96, 0.98, 1),
          borderWidth: 1,
        });
      } else if (item.kind === 'form-checkbox') {
        // Native interactive AcroForm checkbox!
        fieldCounter += 1;
        const cb = form.createCheckBox(`f_check_${pageIndex + 1}_${fieldCounter}`);
        cb.addToPage(page, {
          x: px,
          y: py,
          width: Math.max(12, pw),
          height: Math.max(12, ph),
          borderColor: rgb(0.25, 0.32, 0.42),
          backgroundColor: rgb(1, 1, 1),
          borderWidth: 1.2,
        });
        if (item.checked) cb.check();
      }
    }
  }

  return pdfDoc.save();
}

export async function renderBakedPageToBlob(
  bakedPdfBytes: Uint8Array,
  pageNumber: number,
  format: 'png' | 'jpeg',
  scale = 2
): Promise<Blob> {
  const { task, doc } = await loadPdfWithTask(bakedPdfBytes);
  try {
    const safePage = Math.max(1, Math.min(pageNumber, doc.numPages));
    const page = await doc.getPage(safePage);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Contexte canvas indisponible.');
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Échec de génération image.'))),
        mime,
        0.92
      );
    });
  } finally {
    await task.destroy();
  }
}

export async function rotatePdfPage(
  sourceBytes: Uint8Array,
  pageIndex: number,
  deltaDegrees: number
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(sourceBytes);
  const page = pdfDoc.getPage(pageIndex);
  const current = page.getRotation().angle;
  page.setRotation(degrees((current + deltaDegrees + 360) % 360));
  return pdfDoc.save();
}

export async function deletePdfPage(
  sourceBytes: Uint8Array,
  pageIndex: number
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(sourceBytes);
  if (pdfDoc.getPageCount() <= 1) return sourceBytes;
  pdfDoc.removePage(pageIndex);
  return pdfDoc.save();
}

export async function duplicatePdfPage(
  sourceBytes: Uint8Array,
  pageIndex: number
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(sourceBytes);
  const [copied] = await pdfDoc.copyPages(pdfDoc, [pageIndex]);
  pdfDoc.insertPage(pageIndex + 1, copied);
  return pdfDoc.save();
}

export async function insertBlankPdfPage(
  sourceBytes: Uint8Array,
  afterIndex: number
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(sourceBytes);
  pdfDoc.insertPage(afterIndex + 1, PageSizes.A4);
  return pdfDoc.save();
}

export async function reorderPdfPages(
  sourceBytes: Uint8Array,
  fromIndex: number,
  toIndex: number
): Promise<Uint8Array> {
  if (fromIndex === toIndex) return sourceBytes;
  const srcDoc = await PDFDocument.load(sourceBytes);
  const newDoc = await PDFDocument.create();
  const indices = Array.from({ length: srcDoc.getPageCount() }, (_, i) => i);
  const [moved] = indices.splice(fromIndex, 1);
  indices.splice(toIndex, 0, moved);
  const copied = await newDoc.copyPages(srcDoc, indices);
  copied.forEach((p) => newDoc.addPage(p));
  return newDoc.save();
}

export async function mergePdfDocuments(
  firstBytes: Uint8Array,
  secondBytes: Uint8Array
): Promise<Uint8Array> {
  const merged = await PDFDocument.load(firstBytes);
  const other = await PDFDocument.load(secondBytes);
  const copied = await merged.copyPages(other, other.getPageIndices());
  copied.forEach((p) => merged.addPage(p));
  return merged.save();
}

export async function extractPdfPages(
  sourceBytes: Uint8Array,
  pageIndices: number[]
): Promise<Uint8Array> {
  const src = await PDFDocument.load(sourceBytes);
  const out = await PDFDocument.create();
  const valid = pageIndices.filter((i) => i >= 0 && i < src.getPageCount());
  const copied = await out.copyPages(src, valid);
  copied.forEach((p) => out.addPage(p));
  return out.save();
}

export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
