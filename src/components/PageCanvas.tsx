import React, { useEffect, useRef, useState } from 'react';
import type * as pdfjsLib from 'pdfjs-dist';
import { GripHorizontal, Trash2 } from 'lucide-react';
import type {
  ActiveTool,
  HeaderFooterConfig,
  OverlayItem,
  Point,
  StampPreset,
  WatermarkConfig,
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
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void;
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
  onCanvasReady,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onCanvasReadyRef = useRef(onCanvasReady);
  onCanvasReadyRef.current = onCanvasReady;

  const [pageSize, setPageSize] = useState({ width: 595, height: 842 });
  const [draftItem, setDraftItem] = useState<OverlayItem | null>(null);

  const interactionRef = useRef<
    | {
        mode: 'move';
        id: string;
        startX: number;
        startY: number;
        origX: number;
        origY: number;
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

  // Render PDF page ONLY when pdfDoc, pageNumber, or zoom changes (no render loop!)
  useEffect(() => {
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;

    async function render() {
      if (!pdfDoc || !canvasRef.current) return;
      const safePage = Math.max(1, Math.min(pageNumber, pdfDoc.numPages));
      const page = await pdfDoc.getPage(safePage);
      if (cancelled) return;

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
        color: '#c2410c',
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

    // Drag-to-create vector tools
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
      activeTool === 'ellipse'
    ) {
      setDraftItem({
        id,
        pageIndex,
        kind: activeTool,
        x: pt.x,
        y: pt.y,
        w: 0.001,
        h: 0.001,
        color: toolColor,
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
        onUpdateOverlay(active.id, {
          x: Math.max(0, Math.min(0.96, active.origX + (pt.x - active.startX))),
          y: Math.max(0, Math.min(0.96, active.origY + (pt.y - active.startY))),
        });
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

  const handleStagePointerUp = () => {
    if (interactionRef.current) {
      interactionRef.current = null;
      return;
    }
    if (!draftItem) return;
    let finalItem = draftItem;
    if (
      finalItem.kind === 'highlight' ||
      finalItem.kind === 'rect' ||
      finalItem.kind === 'ellipse'
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
      return; // Allow normal text selection/editing inside inputs
    }
    e.stopPropagation();
    onSelectOverlay(item.id);
    onBeforeMutate();
    const pt = toNormalized(e.clientX, e.clientY);
    interactionRef.current = {
      mode: 'move',
      id: item.id,
      startX: pt.x,
      startY: pt.y,
      origX: item.x,
      origY: item.y,
    };
  };

  const startResizeOverlay = (e: React.PointerEvent, item: OverlayItem) => {
    e.stopPropagation();
    onSelectOverlay(item.id);
    onBeforeMutate();
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
  const allSvgItems = [
    ...pageOverlays.filter((o) =>
      ['highlight', 'draw', 'rect', 'ellipse', 'arrow'].includes(o.kind)
    ),
    ...(draftItem ? [draftItem] : []),
  ];

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

      {/* Live Watermark preview */}
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

      {/* Live Header / Footer preview */}
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
                stroke={isSelected ? '#c2410c' : 'none'}
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
                strokeWidth={(item.strokeWidth ?? 2.2) * zoom}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ pointerEvents: activeTool === 'select' ? 'stroke' : 'none' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectOverlay(item.id);
                }}
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
                strokeWidth={(item.strokeWidth ?? 2.2) * zoom}
                markerEnd="url(#f-arrowhead)"
                style={{ pointerEvents: activeTool === 'select' ? 'stroke' : 'none' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectOverlay(item.id);
                }}
              />
            );
          }
          return null;
        })}
      </svg>

      {/* Interactive HTML Layer */}
      {pageOverlays
        .filter(
          (o) => !['highlight', 'draw', 'rect', 'ellipse', 'arrow'].includes(o.kind)
        )
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
                    fontSize: `${(item.fontSize ?? 13) * zoom}px`,
                    fontWeight: item.bold ? 700 : 400,
                  }}
                />
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
                  placeholder="Champ texte…"
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
