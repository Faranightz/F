import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  PageSizes,
  PDFName,
  type PDFFont,
  type PDFForm,
} from '@cantoo/pdf-lib';
import type {
  BakeOptions,
  HeaderFooterConfig,
  OutlineEntry,
  OverlayItem,
  Point,
  SearchMatch,
  WatermarkConfig,
} from '../types/pdf';
import {
  ANNOTATION_SUBTYPES,
  OpsPainter,
  PagePainter,
  addPdfAnnotation,
  drawOcrLayer,
  embedUnicodeFonts,
  encryptPdf,
  hexToRgbTuple,
  makeFrame,
  paintOverlay,
  toWinAnsiSafe,
  visualRectToPdfBox,
  visualToPdfCoords,
} from './pdfDraw';
import { editPageText, standardFallbackFonts, type EditResult } from './contentEdit';

export { toWinAnsiSafe };

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

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
    color: rgb(0.09, 0.275, 0.82),
  });

  p1.drawText('F-pdf — ÉDITEUR PDF WINDOWS', {
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
    color: rgb(0.91, 0.93, 0.99),
  });

  let y = height - 165;
  p1.drawText('1. Bienvenue dans F-pdf', {
    x: 48,
    y,
    size: 15,
    font: helveticaBold,
    color: rgb(0.12, 0.14, 0.17),
  });

  y -= 28;
  const lines1 = [
    'Ce document de démonstration multi-pages vous permet de tester immédiatement',
    'toutes les fonctionnalités de F-pdf directement depuis le ruban :',
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
    color: rgb(0.96, 0.97, 0.99),
    borderColor: rgb(0.09, 0.275, 0.82),
    borderWidth: 1.2,
  });
  p1.drawText('Astuce rapide :', {
    x: 64,
    y: y - 34,
    size: 11,
    font: helveticaBold,
    color: rgb(0.09, 0.275, 0.82),
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
          ? rgb(0.063, 0.13, 0.227)
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

export async function loadPdfWithTask(bytes: Uint8Array, password?: string): Promise<{
  task: pdfjsLib.PDFDocumentLoadingTask;
  doc: pdfjsLib.PDFDocumentProxy;
}> {
  const copy = new Uint8Array(bytes);
  // fontExtraProperties: keeps the real font names (bold/italic detection, Word export)
  const task = pdfjsLib.getDocument({ data: copy, fontExtraProperties: true, ...(password ? { password } : {}) });
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
  purgeMetadata = false,
  options: BakeOptions = { flattenAnnotations: false, security: null }
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(sourceBytes);
  const allText = [
    watermark.enabled ? watermark.text : '',
    headerFooter.enabled
      ? [headerFooter.headerLeft, headerFooter.headerRight, headerFooter.footerLeft, headerFooter.footerRight].join(' ')
      : '',
    ...overlays.map((o) => `${o.text ?? ''} ${o.stampLabel ?? ''} ${(o.lines ?? []).map((l) => l.text).join(' ')}`),
  ].join(' ');
  const fonts = await embedUnicodeFonts(pdfDoc, allText);
  // Substitute fonts for edited lines whose characters are missing from the original font
  let unicodeFont: Promise<PDFFont | null> | null = null;
  const substitutes = standardFallbackFonts(pdfDoc, () => {
    unicodeFont ??= embedUnicodeFonts(pdfDoc, 'Ж').then((f) => (f.isUnicode ? f.regular : null));
    return unicodeFont;
  });
  const form = pdfDoc.getForm();
  const pages = pdfDoc.getPages();
  const totalPages = pages.length;

  if (purgeMetadata) {
    // Remove the XMP metadata stream too (it can hold author, tool and history)
    pdfDoc.catalog.delete(PDFName.of('Metadata'));
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
    const pagePainter = new PagePainter(page, fonts);

    // Edited lines of the original text: rewritten in place in the page content, with the
    // document's own font (before anything else is drawn on the page)
    const coverItems = overlays.filter((o) => o.pageIndex === pageIndex && o.kind === 'text' && o.cover);
    const coverResults = new Map<string, EditResult>();
    if (coverItems.length) {
      const results = await editPageText(
        pdfDoc,
        page,
        coverItems.map((o) => {
          const origin = o.origin ?? { fontSize: o.fontSize ?? 12, bold: !!o.bold, color: o.color };
          const recoloured = o.color.toLowerCase() !== origin.color.toLowerCase();
          return {
            box: visualRectToPdfBox(o.x, o.y, o.w, o.h, width, height, rotDeg),
            text: o.text ?? '',
            sizeRatio: (o.fontSize ?? origin.fontSize) / (origin.fontSize || 1),
            forceBold: !!o.bold !== origin.bold ? !!o.bold : null,
            color: recoloured ? hexToRgbTuple(o.color) : null,
          };
        }),
        substitutes
      );
      coverItems.forEach((o, k) => coverResults.set(o.id, results[k]));
    }

    // 1. Watermark (rotation-aware centering)
    if (watermark.enabled && watermark.text.trim()) {
      const [r, g, b] = hexToRgbTuple(watermark.color);
      const wmText = fonts.clean(watermark.text, true);
      const wmSize = watermark.fontSize || 48;
      const textWidth = fonts.bold.widthOfTextAtSize(wmText, wmSize);
      const totalAngleDeg = (watermark.angle || 45) + rotDeg;
      const rad = (totalAngleDeg * Math.PI) / 180;
      page.drawText(wmText, {
        x: width / 2 - (textWidth / 2) * Math.cos(rad),
        y: height / 2 - (textWidth / 2) * Math.sin(rad),
        size: wmSize,
        font: fonts.bold,
        color: rgb(r, g, b),
        opacity: Math.max(0.05, Math.min(1, watermark.opacity)),
        rotate: degrees(totalAngleDeg),
      });
    }

    // 2. Header & Footer (rotation-aware)
    if (headerFooter.enabled) {
      const format = (tpl: string) =>
        tpl.replace(/\{page\}/gi, String(pageIndex + 1)).replace(/\{total\}/gi, String(totalPages));
      const metaColor = rgb(0.35, 0.38, 0.42);
      const slots: Array<[string, number, number]> = [
        [headerFooter.headerLeft, 0.05, 0.03],
        [headerFooter.headerRight, 0.75, 0.03],
        [headerFooter.footerLeft, 0.05, 0.97],
        [headerFooter.footerRight, 0.78, 0.97],
      ];
      for (const [tpl, nx, ny] of slots) {
        if (!tpl) continue;
        const pt = visualToPdfCoords(nx, ny, width, height, rotDeg);
        pagePainter.text(format(tpl), { x: pt.x, y: pt.y, size: 9, color: metaColor, rotate: rotDeg });
      }
    }

    // 3. Page Overlays
    const pageOverlays = overlays.filter((o) => o.pageIndex === pageIndex);
    for (const item of pageOverlays) {
      // Visual-only Yousign placement guide is not baked into the PDF document
      if (item.kind === 'yousign-zone' || item.kind === 'cert-zone') continue;

      const box = visualRectToPdfBox(item.x, item.y, item.w, item.h, width, height, rotDeg);
      const { x: px, y: py, w: pw, h: ph } = box;
      const fr = makeFrame(item, width, height, rotDeg);

      if (item.kind === 'redact') {
        page.drawRectangle({ x: px, y: py, width: pw, height: ph, color: rgb(0, 0, 0), opacity: 1 });
        continue;
      }

      if (item.kind === 'ocr-layer') {
        drawOcrLayer(page, fonts, item, width, height, rotDeg);
        continue;
      }

      if ((item.kind === 'image' || item.kind === 'signature') && item.imageDataUrl) {
        const decoded = decodeSafeImageDataUrl(item.imageDataUrl);
        if (decoded) {
          const img =
            decoded.format === 'png'
              ? await pdfDoc.embedPng(decoded.bytes)
              : await pdfDoc.embedJpg(decoded.bytes);
          // Anchor = visual bottom-left corner, drawn rotated so it looks upright
          const anchor = fr.at(0, fr.h);
          page.drawImage(img, { x: anchor.x, y: anchor.y, width: fr.w, height: fr.h, rotate: degrees(rotDeg) });
        }
        continue;
      }

      if (item.kind === 'form-text') {
        fieldCounter += 1;
        const tf = form.createTextField(uniqueFieldName(form, `f_text_${pageIndex + 1}_${fieldCounter}`));
        if (item.text) tf.setText(item.text);
        tf.addToPage(page, {
          x: px,
          y: py,
          width: Math.max(30, pw),
          height: Math.max(16, ph),
          borderColor: rgb(0.09, 0.275, 0.82),
          backgroundColor: rgb(0.96, 0.97, 0.99),
          borderWidth: 1,
        });
        if (fonts.isUnicode) tf.updateAppearances(fonts.regular);
        continue;
      }

      if (item.kind === 'form-checkbox') {
        fieldCounter += 1;
        const cb = form.createCheckBox(uniqueFieldName(form, `f_check_${pageIndex + 1}_${fieldCounter}`));
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
        continue;
      }

      // Edited original text
      if (item.kind === 'text' && item.cover) {
        const res = coverResults.get(item.id);
        if (res?.replaced) continue; // rewritten in place with the document's font
        // Rare fallback (unusual font): hide the old line, draw the text in a matching font
        if (!res?.removedAll) {
          page.drawRectangle({ x: px - 1, y: py - 1, width: pw + 2, height: ph + 2, color: rgb(1, 1, 1) });
        }
        const style = res?.style ?? { serif: false, mono: false, bold: !!item.bold, italic: false };
        const font = (await substitutes.get({ ...style, bold: !!item.bold }, item.text ?? '')) ?? fonts.regular;
        const size = item.fontSize ?? 12;
        const [r, g, b] = hexToRgbTuple(item.color || '#000000');
        (item.text ?? '').split('\n').forEach((l, i) => {
          const pt = fr.at(0, size * 0.95 + i * size * 1.25);
          const clean = font === fonts.regular ? fonts.clean(l) : l;
          try {
            page.drawText(clean, { x: pt.x, y: pt.y, size, font, color: rgb(r, g, b), rotate: degrees(fr.rot) });
          } catch {
            page.drawText(fonts.clean(l), { x: pt.x, y: pt.y, size, font: fonts.regular, color: rgb(r, g, b), rotate: degrees(fr.rot) });
          }
        });
        continue;
      }

      // Comment-type overlays: real PDF annotations (editable in Acrobat/Foxit) or flattened
      if (!options.flattenAnnotations && ANNOTATION_SUBTYPES[item.kind]) {
        const ops = new OpsPainter(fonts);
        paintOverlay(ops, item, fr, box, width, height, rotDeg);
        addPdfAnnotation(pdfDoc, page, item, ops, box, width, height, rotDeg);
      } else {
        paintOverlay(pagePainter, item, fr, box, width, height, rotDeg);
      }
    }
  }

  let outBytes: Uint8Array = await pdfDoc.save();

  // True redaction: a black box alone leaves the hidden text extractable.
  // Pages holding a redaction are flattened to an image so nothing remains underneath.
  const redactedPages = [
    ...new Set(overlays.filter((o) => o.kind === 'redact').map((o) => o.pageIndex)),
  ].filter((i) => i >= 0 && i < totalPages);
  if (redactedPages.length > 0) {
    outBytes = await flattenPagesToImages(outBytes, redactedPages);
  }

  if (options.security && options.security.userPassword) {
    outBytes = await encryptPdf(outBytes, options.security);
  }
  return outBytes;
}

function uniqueFieldName(form: PDFForm, base: string): string {
  let name = base;
  let n = 1;
  while (form.getFieldMaybe(name)) {
    n += 1;
    name = `${base}_${n}`;
  }
  return name;
}

const REDACTION_RENDER_SCALE = 2.5; // about 180 DPI

/**
 * Replaces each listed page by a rasterized copy (same visual size).
 * The original content streams, text, annotations and form widgets of those pages are dropped.
 */
export async function flattenPagesToImages(
  pdfBytes: Uint8Array,
  pageIndices: number[]
): Promise<Uint8Array> {
  const { task, doc: proxy } = await loadPdfWithTask(pdfBytes);
  try {
    const out = await PDFDocument.load(pdfBytes);
    const form = out.getForm();
    for (const pageIndex of [...pageIndices].sort((a, b) => a - b)) {
      const page = await proxy.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: REDACTION_RENDER_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Contexte canvas indisponible pour le caviardage.');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Échec du caviardage.'))),
          'image/jpeg',
          0.9
        )
      );
      const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));

      // Remove form fields whose widgets live on this page (otherwise they stay orphaned)
      const oldPage = out.getPage(pageIndex);
      for (const field of form.getFields()) {
        if (field.acroField.getWidgets().some((w) => w.P() === oldPage.ref)) {
          form.removeField(field);
        }
      }

      const w = viewport.width / REDACTION_RENDER_SCALE;
      const h = viewport.height / REDACTION_RENDER_SCALE;
      out.removePage(pageIndex);
      const newPage = out.insertPage(pageIndex, [w, h]);
      newPage.drawImage(jpg, { x: 0, y: 0, width: w, height: h });
    }
    return await out.save();
  } finally {
    await task.destroy();
  }
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

/**
 * Draws the visible part of a digital signature (name, date, reason) in its zone and returns
 * the zone rectangle in raw PDF coordinates, for the signature widget.
 */
export async function drawCertificateAppearance(
  sourceBytes: Uint8Array,
  zone: { pageIndex: number; x: number; y: number; w: number; h: number },
  lines: { name: string; details: string[] }
): Promise<{ bytes: Uint8Array; rect: [number, number, number, number] }> {
  const pdfDoc = await PDFDocument.load(sourceBytes);
  const page = pdfDoc.getPage(Math.min(zone.pageIndex, pdfDoc.getPageCount() - 1));
  const { width, height } = page.getSize();
  const rotDeg = ((page.getRotation().angle % 360) + 360) % 360;
  const fonts = await embedUnicodeFonts(pdfDoc, `${lines.name} ${lines.details.join(' ')}`);
  const box = visualRectToPdfBox(zone.x, zone.y, zone.w, zone.h, width, height, rotDeg);
  const fr = makeFrame(zone, width, height, rotDeg);
  const blue = rgb(0.09, 0.275, 0.82);
  page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, color: rgb(0.91, 0.93, 0.99), borderColor: blue, borderWidth: 1 });
  // Text sized to fit the zone (one line each, never wrapped over the next one)
  const fit = (text: string, font: PDFFont, wanted: number) =>
    Math.max(4, Math.min(wanted, (fr.w - 12) / Math.max(1, font.widthOfTextAtSize(text, 1))));
  const name = fonts.clean(lines.name, true);
  const nameSize = fit(name, fonts.bold, Math.max(7, Math.min(13, fr.h * 0.24)));
  const details = lines.details.map((d) => fonts.clean(d));
  const detailSize = Math.min(...details.map((d) => fit(d, fonts.regular, Math.max(5.5, Math.min(8.5, fr.h * 0.15)))), 8.5);
  const at = fr.at(6, 4 + nameSize);
  page.drawText(name, {
    x: at.x,
    y: at.y,
    size: nameSize,
    font: fonts.bold,
    color: blue,
    rotate: degrees(rotDeg),
  });
  details.forEach((d, i) => {
    const p = fr.at(6, 6 + nameSize + (i + 1) * detailSize * 1.3);
    page.drawText(d, {
      x: p.x,
      y: p.y,
      size: detailSize,
      font: fonts.regular,
      color: rgb(0.063, 0.13, 0.227),
      rotate: degrees(rotDeg),
    });
  });
  return { bytes: await pdfDoc.save(), rect: [box.x, box.y, box.x + box.w, box.y + box.h] };
}