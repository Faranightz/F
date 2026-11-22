import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { FileBadge, GripHorizontal, ShieldCheck, Trash2 } from 'lucide-react';
import type {
  ActiveTool,
  HeaderFooterConfig,
  OverlayItem,
  Point,
  StampPreset,
  WatermarkConfig,
  YousignPlacedZone,
} from '../types/pdf';

interface PageCanvasProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageNumber: number; // 1-based
  numPages: number;
  zoom: number;
  activeTool: ActiveTool;
  toolColor: string;
  strokeWidth: number;
  fontSize: number;
  stampPreset: StampPreset;
  pendingImageDataUrl: string | null;
  pendingSignatureDataUrl: string | null;
  overlays: OverlayItem[];
  selectedId: string | null;
  watermark: WatermarkConfig;
  headerFooter: HeaderFooterConfig;
  onSelectOverlay: (id: string | null) => void;
  onBeforeMutate: () => void;
  onAddOverlay: (item: OverlayItem) => void;
  onUpdateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
  onDeleteOverlay: (id: string) => void;
  onYousignZonePlaced?: (zone: YousignPlacedZone) => void;
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void;
  onToast?: (message: string) => void;
  onCertZonePlaced?: (zone: OverlayItem) => void;
}

export const PageCanvas: React.FC<PageCanvasProps> = ({
  pdfDoc,
  pageNumber,
  numPages,
  zoom,
  activeTool,
  toolColor,
  strokeWidth,
  fontSize,
  stampPreset,
  pendingImageDataUrl,
  pendingSignatureDataUrl,
  overlays,
  selectedId,
  watermark,
  headerFooter,
  onSelectOverlay,
  onBeforeMutate,
  onAddOverlay,
  onUpdateOverlay,
  onDeleteOverlay,
  onYousignZonePlaced,
  onCanvasReady,
  onToast,
  onCertZonePlaced,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onCanvasReadyRef = useRef(onCanvasReady);

  useEffect(() => {
    onCanvasReadyRef.current = onCanvasReady;
  }, [onCanvasReady]);

  const [pageSize, setPageSize] = useState({ width: 595, height: 842 });
  const [basePagePts, setBasePagePts] = useState({ width: 595, height: 842 });
  const [draftItem, setDraftItem] = useState<OverlayItem | null>(null);

  const interactionRef = useRef<
    | {
        mode: 'move';
        id: string;
        startX: number;
        startY: number;
        origX: number;
        origY: number;
        origPoints?: Point[];
      }
    | {
        mode: 'resize';
        id: string;
        startX: number;
        startY: number;
        origW: number;
        origH: number;
      }
    | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;

    async function render() {
      if (!pdfDoc || !canvasRef.current) return;
      const safePage = Math.max(1, Math.min(pageNumber, pdfDoc.numPages));
      const page = await pdfDoc.getPage(safePage);
      if (cancelled) return;

      const baseVp = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: zoom });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setPageSize({ width: viewport.width, height: viewport.height });
      setBasePagePts({ width: baseVp.width, height: baseVp.height });

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderTask = page.render({ canvasContext: ctx, viewport, canvas });
      try {
        await renderTask.promise;
        if (!cancelled) onCanvasReadyRef.current?.(canvas);
      } catch {
        // Render cancelled on rapid zoom/page switch
      }
    }

    render();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDoc, pageNumber, zoom]);

  const toNormalized = (clientX: number, clientY: number): Point => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  };

  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (activeTool === 'select' || activeTool === 'hand') {
      if (e.target === containerRef.current || e.target === canvasRef.current) {
        onSelectOverlay(null);
      }
      return;
    }

    const pt = toNormalized(e.clientX, e.clientY);
    const pageIndex = pageNumber - 1;
    const now = new Date().toISOString();

    if (activeTool === 'edit-text') {
      // Find the text line under the click, then cover it with an editable copy
      void (async () => {
        if (!pdfDoc) return;
        const page = await pdfDoc.getPage(pageNumber);
        const vp = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        type Piece = { s: string; left: number; top: number; right: number; bottom: number; size: number; bold: boolean; fontName: string };
        const pieces: Piece[] = [];
        for (const it of content.items) {
          if (!('str' in it) || !it.str.trim()) continue;
          const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
          const size = Math.hypot(tx[2], tx[3]);
          const left = tx[4];
          const bottom = tx[5] + size * 0.22;
          const fontInfo = content.styles[it.fontName];
          pieces.push({
            s: it.str,
            left,
            top: tx[5] - size * 0.95,
            right: left + it.width * vp.scale,
            bottom,
            size,
            bold: /bold|black|heavy/i.test(`${it.fontName} ${fontInfo?.fontFamily ?? ''}`),
            fontName: it.fontName,
          });
        }
        const px = pt.x * vp.width;
        const py = pt.y * vp.height;
        const hit = pieces.find((p) => px >= p.left - 2 && px <= p.right + 2 && py >= p.top - 2 && py <= p.bottom + 2);
        if (!hit) {
          onToast?.('Aucun texte à cet endroit. Cliquez directement sur une ligne de texte.');
          return;
        }
        // Whole line = pieces sharing the same baseline
        const line = pieces
          .filter((p) => Math.abs(p.bottom - hit.bottom) < hit.size * 0.35)
          .sort((a, b) => a.left - b.left);
        let text = '';
        let end = -Infinity;
        for (const p of line) {
          if (text && p.left - end > p.size * 0.2 && !text.endsWith(' ') && !p.s.startsWith(' ')) text += ' ';
          text += p.s;
          end = p.right;
        }
        const left = Math.min(...line.map((p) => p.left));
        const right = Math.max(...line.map((p) => p.right));
        const top = Math.min(...line.map((p) => p.top));
        const bottom = Math.max(...line.map((p) => p.bottom));
        // Text colour: the most saturated/dark pixel of the line on the rendered page
        let color = '#000000';
        const cv = canvasRef.current;
        const ctx2 = cv?.getContext('2d', { willReadFrequently: true });
        if (cv && ctx2) {
          const sx = cv.width / vp.width;
          const sy = cv.height / vp.height;
          const rx = Math.max(0, Math.floor(left * sx));
          const ry = Math.max(0, Math.floor(top * sy));
          const rw = Math.max(1, Math.min(cv.width - rx, Math.ceil((right - left) * sx)));
          const rh = Math.max(1, Math.min(cv.height - ry, Math.ceil((bottom - top) * sy)));
          try {
            const data = ctx2.getImageData(rx, ry, rw, rh).data;
            let best = 0;
            for (let k = 0; k < data.length; k += 4) {
              const dist = 765 - (data[k] + data[k + 1] + data[k + 2]);
              if (dist > best) {
                best = dist;
                color = `#${[data[k], data[k + 1], data[k + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
              }
            }
            // Near-black anti-aliasing noise: treat as pure black
            if (best > 700) color = '#000000';
          } catch {
            // canvas not readable: keep black
          }
        }
        const family = content.styles[hit.fontName]?.fontFamily ?? 'sans-serif';
        const item: OverlayItem = {
          id: crypto.randomUUID(),
          pageIndex,
          kind: 'text',
          cover: true,
          x: Math.max(0, left / vp.width - 0.002),
          y: Math.max(0, top / vp.height - 0.002),
          w: Math.min(1, (right - left) / vp.width + 0.03),
          h: Math.min(1, (bottom - top) / vp.height + 0.004),
          color,
          fontSize: Math.round(hit.size * 10) / 10,
          bold: hit.bold,
          text: text.trim(),
          origin: { fontSize: Math.round(hit.size * 10) / 10, bold: hit.bold, color },
          cssFont: `"${hit.fontName}", ${family}`,
          createdAt: now,
        };
        onAddOverlay(item);
        onSelectOverlay(item.id);
      })();
      return;
    }

    if (activeTool === 'text') {
      const item: OverlayItem = {
        id: crypto.randomUUID(),
        pageIndex,
        kind: 'text',
        x: pt.x,
        y: pt.y,
        w: 0.34,
        h: 0.06,
        color: toolColor,
        fontSize,
        text: 'Nouveau texte',
        createdAt: now,
      };
      onAddOverlay(item);
      onSelectOverlay(item.id);
      return;
    }

    if (activeTool === 'note') {
      const item: OverlayItem = {
        id: crypto.randomUUID(),
        pageIndex,
        kind: 'note',
        x: pt.x,
        y: pt.y,
        w: 0.25,
        h: 0.1,
        color: '#b45309',
        text: 'Note de révision…',
        author: 'Utilisateur',
        createdAt: now,
      };
      onAddOverlay(item);
      onSelectOverlay(item.id);
      return;
    }

    if (activeTool === 'stamp') {
      const stampColorMap: Record<StampPreset, string> = {
        APPROUVÉ: '#15803d',
        CONFIDENTIEL: '#b91c1c',
        BROUILLON: '#475569',
        URGENT: '#dc2626',
        SIGNÉ: '#1d4ed8',
        RÉVISÉ: '#b45309',
      };
      const item: OverlayItem = {
        id: crypto.randomUUID(),
        pageIndex,
        kind: 'stamp',
        x: Math.max(0, pt.x - 0.12),
        y: Math.max(0, pt.y - 0.03),
        w: 0.24,
        h: 0.06,
        color: stampColorMap[stampPreset],
        stampLabel: stampPreset,
        createdAt: now,
      };
      onAddOverlay(item);
      onSelectOverlay(item.id);
      return;
    }

    if (activeTool === 'form-text') {
      const item: OverlayItem = {
        id: crypto.randomUUID(),
        pageIndex,
        kind: 'form-text',
        x: pt.x,
        y: pt.y,
        w: 0.32,
        h: 0.038,
        color: '#2563eb',
        fontSize: 12,
        text: '',
        createdAt: now,
      };
      onAddOverlay(item);
      onSelectOverlay(item.id);
      return;
    }

    if (activeTool === 'form-checkbox') {
      const item: OverlayItem = {
        id: crypto.randomUUID(),
        pageIndex,
        kind: 'form-checkbox',
        x: pt.x,
        y: pt.y,
        w: 0.03,
        h: 0.022,
        color: '#1746d1',
        checked: true,
        createdAt: now,
      };
      onAddOverlay(item);
      onSelectOverlay(item.id);
      return;
    }

    if (activeTool === 'image' && pendingImageDataUrl) {
      const item: OverlayItem = {
        id: crypto.randomUUID(),
        pageIndex,
        kind: 'image',
        x: Math.max(0, pt.x - 0.14),
        y: Math.max(0, pt.y - 0.09),
        w: 0.28,
        h: 0.18,
        color: '#000000',
        imageDataUrl: pendingImageDataUrl,
        createdAt: now,
      };
      onAddOverlay(item);
      onSelectOverlay(item.id);
      return;
    }

    if (activeTool === 'signature' && pendingSignatureDataUrl) {
      const item: OverlayItem = {
        id: crypto.randomUUID(),
        pageIndex,
        kind: 'signature',
        x: Math.max(0, pt.x - 0.14),
        y: Math.max(0, pt.y - 0.045),
        w: 0.28,
        h: 0.09,
        color: '#112244',
        imageDataUrl: pendingSignatureDataUrl,
        createdAt: now,
      };
      onAddOverlay(item);
      onSelectOverlay(item.id);
      return;
    }

    if (activeTool === 'cert-zone') {
      // Visible digital signature: one zone per document (a new one replaces the old)
      const w = 0.34;
      const h = 0.09;
      const item: OverlayItem = {
        id: crypto.randomUUID(),
        pageIndex,
        kind: 'cert-zone',
        x: Math.max(0, Math.min(1 - w, pt.x - w / 2)),
        y: Math.max(0, Math.min(1 - h, pt.y - h / 2)),
        w,
        h,
        color: '#1746d1',
        createdAt: now,
      };
      onAddOverlay(item);
      onSelectOverlay(item.id);
      onCertZonePlaced?.(item);
      return;
    }

    if (activeTool === 'yousign-zone') {
      const w = 0.32;
      const h = 0.075;
      const x = Math.max(0, Math.min(1 - w, pt.x - w / 2));
      const y = Math.max(0, Math.min(1 - h, pt.y - h / 2));
      const item: OverlayItem = {
        id: crypto.randomUUID(),
        pageIndex,
        kind: 'yousign-zone',
        x,
        y,
        w,
        h,
        color: '#10213a',
        text: 'Zone Signature Yousign',
        createdAt: now,
      };
      onAddOverlay(item);
      onSelectOverlay(item.id);
      onYousignZonePlaced?.({
        page: pageNumber,
        x: Math.round(x * basePagePts.width),
        y: Math.round(y * basePagePts.height),
        width: Math.max(80, Math.round(w * basePagePts.width)),
        height: Math.max(40, Math.round(h * basePagePts.height)),
      });
      return;
    }

    // Drag-to-create tools: highlight, draw, rect, ellipse, arrow, redact
    e.currentTarget.setPointerCapture(e.pointerId);
    const id = crypto.randomUUID();
    if (activeTool === 'draw' || activeTool === 'arrow') {
      setDraftItem({
        id,
        pageIndex,
        kind: activeTool,
        x: pt.x,
        y: pt.y,
        w: 0,
        h: 0,
        color: toolColor,
        strokeWidth,
        points: [pt],
        createdAt: now,
      });
    } else if (
      activeTool === 'highlight' ||
      activeTool === 'rect' ||
      activeTool === 'ellipse' ||
      activeTool === 'redact'
    ) {
      setDraftItem({
        id,
        pageIndex,
        kind: activeTool,
        x: pt.x,
        y: pt.y,
        w: 0.001,
        h: 0.001,
        color: activeTool === 'redact' ? '#000000' : toolColor,
        strokeWidth,
        opacity: activeTool === 'highlight' ? 0.36 : 1,
        createdAt: now,
      });
    }
  };

  const handleStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = interactionRef.current;
    if (active) {
      const pt = toNormalized(e.clientX, e.clientY);
      if (active.mode === 'move') {
        const dx = pt.x - active.startX;
        const dy = pt.y - active.startY;
        if (active.origPoints) {
          onUpdateOverlay(active.id, {
            points: active.origPoints.map((p) => ({
              x: Math.max(0, Math.min(1, p.x + dx)),
              y: Math.max(0, Math.min(1, p.y + dy)),
            })),
          });
        } else {
          onUpdateOverlay(active.id, {
            x: Math.max(0, Math.min(0.96, active.origX + dx)),
            y: Math.max(0, Math.min(0.96, active.origY + dy)),
          });
        }
      } else if (active.mode === 'resize') {
        onUpdateOverlay(active.id, {
          w: Math.max(0.03, Math.min(0.95, active.origW + (pt.x - active.startX))),
          h: Math.max(0.02, Math.min(0.95, active.origH + (pt.y - active.startY))),
        });
      }
      return;
    }

    if (!draftItem) return;
    const pt = toNormalized(e.clientX, e.clientY);
    if (draftItem.kind === 'draw') {
      setDraftItem((prev) =>
        prev ? { ...prev, points: [...(prev.points || []), pt] } : null
      );
    } else if (draftItem.kind === 'arrow') {
      setDraftItem((prev) =>
        prev && prev.points ? { ...prev, points: [prev.points[0], pt] } : null
      );
    } else {
      setDraftItem((prev) =>
        prev ? { ...prev, w: pt.x - prev.x, h: pt.y - prev.y } : null
      );
    }
  };

  const handleStagePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (containerRef.current?.hasPointerCapture(e.pointerId)) {
      containerRef.current.releasePointerCapture(e.pointerId);
    }
    if (interactionRef.current) {
      interactionRef.current = null;
      return;
    }
    if (!draftItem) return;
    let finalItem = draftItem;
    if (
      finalItem.kind === 'highlight' ||
      finalItem.kind === 'rect' ||
      finalItem.kind === 'ellipse' ||
      finalItem.kind === 'redact'
    ) {
      const nx = finalItem.w < 0 ? finalItem.x + finalItem.w : finalItem.x;
      const ny = finalItem.h < 0 ? finalItem.y + finalItem.h : finalItem.y;
      const nw = Math.abs(finalItem.w);
      const nh = Math.abs(finalItem.h);
      if (nw > 0.008 && nh > 0.008) {
        finalItem = { ...finalItem, x: nx, y: ny, w: nw, h: nh };
        onAddOverlay(finalItem);
        onSelectOverlay(finalItem.id);
      }
    } else if (
      (finalItem.kind === 'draw' || finalItem.kind === 'arrow') &&
      finalItem.points &&
      finalItem.points.length >= 2
    ) {
      onAddOverlay(finalItem);
      onSelectOverlay(finalItem.id);
    }
    setDraftItem(null);
  };

  const startMoveOverlay = (
    e: React.PointerEvent,
    item: OverlayItem,
    forceHandle = false
  ) => {
    if (activeTool !== 'select') return;
    const targetTag = (e.target as HTMLElement)?.tagName;
    if (!forceHandle && (targetTag === 'TEXTAREA' || targetTag === 'INPUT')) {
      onSelectOverlay(item.id);
      return;
    }
    e.stopPropagation();
    onSelectOverlay(item.id);
    onBeforeMutate();
    try {
      containerRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture unsupported
    }
    const pt = toNormalized(e.clientX, e.clientY);
    interactionRef.current = {
      mode: 'move',
      id: item.id,
      startX: pt.x,
      startY: pt.y,
      origX: item.x,
      origY: item.y,
      origPoints: item.points ? item.points.map((p) => ({ ...p })) : undefined,
    };
  };

  const startResizeOverlay = (e: React.PointerEvent, item: OverlayItem) => {
    e.stopPropagation();
    onSelectOverlay(item.id);
    onBeforeMutate();
    try {
      containerRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    const pt = toNormalized(e.clientX, e.clientY);
    interactionRef.current = {
      mode: 'resize',
      id: item.id,
      startX: pt.x,
      startY: pt.y,
      origW: item.w,
      origH: item.h,
    };
  };

  const pageOverlays = overlays.filter((o) => o.pageIndex === pageNumber - 1);
  const svgKinds = ['highlight', 'draw', 'rect', 'ellipse', 'arrow', 'redact'];
  const allSvgItems = [
    ...pageOverlays.filter((o) => svgKinds.includes(o.kind)),
    ...(draftItem ? [draftItem] : []),
  ];

  // Compute floating delete button position for selected SVG overlay
  const selectedSvgItem = pageOverlays.find(
    (o) => o.id === selectedId && svgKinds.includes(o.kind)
  );
  let selectedSvgDeletePos: { left: number; top: number } | null = null;
  if (selectedSvgItem) {
    if (selectedSvgItem.points && selectedSvgItem.points.length > 0) {
      const maxX = Math.max(...selectedSvgItem.points.map((p) => p.x));
      const minY = Math.min(...selectedSvgItem.points.map((p) => p.y));
      selectedSvgDeletePos = {
        left: Math.min(pageSize.width - 12, maxX * pageSize.width),
        top: Math.max(12, minY * pageSize.height),
      };
    } else {
      selectedSvgDeletePos = {
        left: Math.min(pageSize.width - 12, (selectedSvgItem.x + selectedSvgItem.w) * pageSize.width),
        top: Math.max(12, selectedSvgItem.y * pageSize.height),
      };
    }
  }

  const formatMeta = (tpl: string) =>
    tpl
      .replace(/\{page\}/gi, String(pageNumber))
      .replace(/\{total\}/gi, String(numPages));

  const cursorClass =
    activeTool === 'hand'
      ? 'cursor-grab'
      : activeTool === 'select'
        ? 'cursor-default'
        : 'cursor-crosshair';

  return (
    <div
      ref={containerRef}
      className={`pdf-page-sheet ${cursorClass}`}
      style={{ width: pageSize.width, height: pageSize.height }}
      onPointerDown={handleStagePointerDown}
      onPointerMove={handleStagePointerMove}
      onPointerUp={handleStagePointerUp}
    >
      <canvas ref={canvasRef} className="pdf-render-canvas" />

      {watermark.enabled && watermark.text.trim() && (
        <div
          className="pdf-watermark-preview"
          style={{
            color: watermark.color,
            opacity: watermark.opacity,
            fontSize: `${Math.max(16, watermark.fontSize * zoom)}px`,
            transform: `translate(-50%, -50%) rotate(${-watermark.angle}deg)`,
          }}
        >
          {watermark.text}
        </div>
      )}

      {headerFooter.enabled && (
        <>
          <div className="pdf-hf-bar pdf-hf-top">
            <span>{formatMeta(headerFooter.headerLeft)}</span>
            <span>{formatMeta(headerFooter.headerRight)}</span>
          </div>
          <div className="pdf-hf-bar pdf-hf-bottom">
            <span>{formatMeta(headerFooter.footerLeft)}</span>
            <span>{formatMeta(headerFooter.footerRight)}</span>
          </div>
        </>
      )}

      {/* Vector SVG Layer */}
      <svg
        className="pdf-svg-layer"
        viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
        width={pageSize.width}
        height={pageSize.height}
      >
        <defs>
          <marker
            id="f-arrowhead"
            markerWidth="10"
            markerHeight="7"
            refX="9"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill="context-stroke" />
          </marker>
        </defs>
        {allSvgItems.map((item) => {
          const isSelected = item.id === selectedId;
          const nx = item.w < 0 ? item.x + item.w : item.x;
          const ny = item.h < 0 ? item.y + item.h : item.y;
          const nw = Math.abs(item.w) * pageSize.width;
          const nh = Math.abs(item.h) * pageSize.height;
          const px = nx * pageSize.width;
          const py = ny * pageSize.height;

          if (item.kind === 'redact') {
            return (
              <rect
                key={item.id}
                x={px}
                y={py}
                width={nw}
                height={nh}
                fill="#000000"
                stroke={isSelected ? '#1746d1' : 'none'}
                strokeWidth={isSelected ? 2 : 0}
                style={{
                  pointerEvents: activeTool === 'select' ? 'all' : 'none',
                  cursor: activeTool === 'select' ? 'move' : 'default',
                }}
                onPointerDown={(e) => startMoveOverlay(e, item, true)}
              />
            );
          }

          if (item.kind === 'highlight') {
            return (
              <rect
                key={item.id}
                x={px}
                y={py}
                width={nw}
                height={nh}
                fill={item.color}
                fillOpacity={item.opacity ?? 0.36}
                stroke={isSelected ? '#1746d1' : 'none'}
                strokeWidth={isSelected ? 1.5 : 0}
                style={{
                  pointerEvents: activeTool === 'select' ? 'all' : 'none',
                  cursor: activeTool === 'select' ? 'move' : 'default',
                }}
                onPointerDown={(e) => startMoveOverlay(e, item, true)}
              />
            );
          }

          if (item.kind === 'rect') {
            return (
              <rect
                key={item.id}
                x={px}
                y={py}
                width={nw}
                height={nh}
                fill="transparent"
                stroke={item.color}
                strokeWidth={(item.strokeWidth ?? 2) * zoom}
                strokeDasharray={isSelected ? '5 3' : undefined}
                style={{
                  pointerEvents: activeTool === 'select' ? 'stroke' : 'none',
                  cursor: activeTool === 'select' ? 'move' : 'default',
                }}
                onPointerDown={(e) => startMoveOverlay(e, item, true)}
              />
            );
          }

          if (item.kind === 'ellipse') {
            return (
              <ellipse
                key={item.id}
                cx={px + nw / 2}
                cy={py + nh / 2}
                rx={nw / 2}
                ry={nh / 2}
                fill="transparent"
                stroke={item.color}
                strokeWidth={(item.strokeWidth ?? 2) * zoom}
                strokeDasharray={isSelected ? '5 3' : undefined}
                style={{
                  pointerEvents: activeTool === 'select' ? 'stroke' : 'none',
                  cursor: activeTool === 'select' ? 'move' : 'default',
                }}
                onPointerDown={(e) => startMoveOverlay(e, item, true)}
              />
            );
          }

          if (item.kind === 'draw' && item.points && item.points.length > 1) {
            const d = item.points
              .map(
                (p, i) =>
                  `${i === 0 ? 'M' : 'L'} ${p.x * pageSize.width} ${p.y * pageSize.height}`
              )
              .join(' ');
            return (
              <path
                key={item.id}
                d={d}
                fill="none"
                stroke={item.color}
                strokeWidth={((item.strokeWidth ?? 2.2) + (isSelected ? 1.2 : 0)) * zoom}
                strokeDasharray={isSelected ? '6 3' : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  pointerEvents: activeTool === 'select' ? 'stroke' : 'none',
                  cursor: activeTool === 'select' ? 'move' : 'default',
                }}
                onPointerDown={(e) => startMoveOverlay(e, item, true)}
              />
            );
          }

          if (item.kind === 'arrow' && item.points && item.points.length >= 2) {
            const p0 = item.points[0];
            const p1 = item.points[item.points.length - 1];
            return (
              <line
                key={item.id}
                x1={p0.x * pageSize.width}
                y1={p0.y * pageSize.height}
                x2={p1.x * pageSize.width}
                y2={p1.y * pageSize.height}
                stroke={item.color}
                strokeWidth={((item.strokeWidth ?? 2.2) + (isSelected ? 1.2 : 0)) * zoom}
                strokeDasharray={isSelected ? '6 3' : undefined}
                markerEnd="url(#f-arrowhead)"
                style={{
                  pointerEvents: activeTool === 'select' ? 'stroke' : 'none',
                  cursor: activeTool === 'select' ? 'move' : 'default',
                }}
                onPointerDown={(e) => startMoveOverlay(e, item, true)}
              />
            );
          }
          return null;
        })}
      </svg>

      {/* Floating delete button for selected SVG overlay */}
      {selectedSvgItem && selectedSvgDeletePos && (
        <button
          type="button"
          className="overlay-delete-pill"
          style={{
            left: selectedSvgDeletePos.left - 11,
            top: selectedSvgDeletePos.top - 11,
            right: 'auto',
          }}
          onClick={(e) => {
            e.stopPropagation();
            onDeleteOverlay(selectedSvgItem.id);
          }}
          title="Supprimer la forme sélectionnée"
          aria-label="Supprimer la forme sélectionnée"
        >
          <Trash2 size={12} />
        </button>
      )}

      {/* Interactive HTML Layer */}
      {pageOverlays
        .filter((o) => !svgKinds.includes(o.kind))
        .map((item) => {
          const isSelected = item.id === selectedId;
          const style: React.CSSProperties = {
            left: `${item.x * 100}%`,
            top: `${item.y * 100}%`,
            width: `${item.w * 100}%`,
            height: `${item.h * 100}%`,
          };

          return (
            <div
              key={item.id}
              className={`overlay-box overlay-${item.kind} ${isSelected ? 'selected' : ''}`}
              style={style}
              onPointerDown={(e) => startMoveOverlay(e, item, false)}
              onClick={(e) => {
                e.stopPropagation();
                onSelectOverlay(item.id);
              }}
            >
              {isSelected && (
                <>
                  <button
                    type="button"
                    className="overlay-drag-handle"
                    onPointerDown={(e) => startMoveOverlay(e, item, true)}
                    title="Déplacer l’élément"
                    aria-label="Déplacer l’élément"
                  >
                    <GripHorizontal size={12} />
                  </button>
                  <button
                    type="button"
                    className="overlay-delete-pill"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteOverlay(item.id);
                    }}
                    title="Supprimer l’élément"
                    aria-label="Supprimer l’élément"
                  >
                    <Trash2 size={12} />
                  </button>
                  <div
                    className="overlay-resize-handle"
                    onPointerDown={(e) => startResizeOverlay(e, item)}
                    title="Redimensionner"
                  />
                </>
              )}

              {item.kind === 'text' && (
                <textarea
                  className="overlay-text-input"
                  aria-label="Zone de texte PDF"
                  value={item.text || ''}
                  onFocus={onBeforeMutate}
                  onChange={(e) => onUpdateOverlay(item.id, { text: e.target.value })}
                  style={{
                    color: item.color,
                    // Edited line: shown in the document's own font, over the original
                    // (the page keeps no white box once saved)
                    background: item.cover ? 'var(--edit-surface, #ffffff)' : undefined,
                    fontFamily: item.cover && item.cssFont ? item.cssFont : undefined,
                    padding: item.cover ? '0 0 0 1px' : undefined,
                    lineHeight: item.cover ? 1.15 : undefined,
                    fontSize: `${(item.fontSize ?? 13) * zoom}px`,
                    fontWeight: item.cover && item.origin && item.bold === item.origin.bold ? undefined : item.bold ? 700 : 400,
                  }}
                />
              )}

              {item.kind === 'ocr-layer' && (
                <div className="overlay-ocr-pill" title="Couche texte OCR invisible injectée à l’export PDF">
                  Couche OCR invisible active ({(item.text || '').length} car.)
                </div>
              )}

              {item.kind === 'cert-zone' && (
                <div className="overlay-cert-zone">
                  <FileBadge size={14} />
                  <span>Signature numérique</span>
                </div>
              )}

              {item.kind === 'yousign-zone' && (
                <div className="overlay-yousign-zone">
                  <ShieldCheck size={14} />
                  <span>Zone Yousign (p.{pageNumber})</span>
                </div>
              )}

              {item.kind === 'note' && (
                <div className="overlay-sticky-note">
                  <div
                    className="sticky-note-head"
                    onPointerDown={(e) => startMoveOverlay(e, item, true)}
                  >
                    Note
                  </div>
                  <textarea
                    aria-label="Contenu de la note"
                    value={item.text || ''}
                    onFocus={onBeforeMutate}
                    onChange={(e) => onUpdateOverlay(item.id, { text: e.target.value })}
                  />
                </div>
              )}

              {item.kind === 'stamp' && (
                <div
                  className="overlay-stamp-badge"
                  style={{ borderColor: item.color, color: item.color }}
                >
                  {item.stampLabel || item.text || 'APPROUVÉ'}
                </div>
              )}

              {(item.kind === 'image' || item.kind === 'signature') &&
                item.imageDataUrl && (
                  <img
                    src={item.imageDataUrl}
                    alt={item.kind === 'signature' ? 'Signature' : 'Image insérée'}
                    className="overlay-img"
                    draggable={false}
                  />
                )}

              {item.kind === 'form-text' && (
                <input
                  type="text"
                  className="overlay-form-input"
                  placeholder="Champ texte AcroForm…"
                  aria-label="Champ de formulaire texte"
                  value={item.text || ''}
                  onFocus={onBeforeMutate}
                  onChange={(e) => onUpdateOverlay(item.id, { text: e.target.value })}
                />
              )}

              {item.kind === 'form-checkbox' && (
                <label
                  className="overlay-checkbox-wrap"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    aria-label="Case à cocher"
                    checked={Boolean(item.checked)}
                    onChange={(e) => {
                      onBeforeMutate();
                      onUpdateOverlay(item.id, { checked: e.target.checked });
                    }}
                  />
                </label>
              )}
            </div>
          );
        })}
    </div>
  );
};
