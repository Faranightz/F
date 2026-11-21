import React, { useEffect, useRef, useState } from 'react';
import type * as pdfjsLib from 'pdfjs-dist';
import {
  Copy,
  FilePlus2,
  FolderPlus,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
} from 'lucide-react';

interface OrganizeViewProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  numPages: number;
  onRotate: (pageIndex: number, deg: number) => void;
  onDelete: (pageIndex: number) => void;
  onDuplicate: (pageIndex: number) => void;
  onInsertBlank: (afterIndex: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onExtractSelected: (indices: number[]) => void;
  onMergePdfFile: (file: File) => void;
  onOpenPage: (pageNumber: number) => void;
}

const GridPageCard: React.FC<{
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageIndex: number;
  selected: boolean;
  onToggleSelect: () => void;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onOpen: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}> = ({
  pdfDoc,
  pageIndex,
  selected,
  onToggleSelect,
  onRotateLeft,
  onRotateRight,
  onDuplicate,
  onDelete,
  onOpen,
  onDragStart,
  onDrop,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: pdfjsLib.RenderTask | null = null;
    async function render() {
      if (!pdfDoc || !canvasRef.current) return;
      if (pageIndex + 1 > pdfDoc.numPages) return;
      const page = await pdfDoc.getPage(pageIndex + 1);
      if (cancelled) return;
      const vp = page.getViewport({ scale: 0.36 });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      canvas.width = vp.width;
      canvas.height = vp.height;
      task = page.render({ canvasContext: ctx, viewport: vp, canvas });
      try {
        await task.promise;
      } catch {
        // cancelled
      }
    }
    render();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdfDoc, pageIndex]);

  return (
    <div
      className={`org-card ${selected ? 'selected' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="org-card-top">
        <label className="org-check">
          <input type="checkbox" checked={selected} onChange={onToggleSelect} />
          <span>Page {pageIndex + 1}</span>
        </label>
        <div className="org-card-actions">
          <button title="Pivoter -90°" onClick={onRotateLeft}>
            <RotateCcw size={13} />
          </button>
          <button title="Pivoter +90°" onClick={onRotateRight}>
            <RotateCw size={13} />
          </button>
          <button title="Dupliquer" onClick={onDuplicate}>
            <Copy size={13} />
          </button>
          <button className="danger" title="Supprimer" onClick={onDelete}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className="org-canvas-wrap" onDoubleClick={onOpen} title="Double-clic pour éditer">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
};

export const OrganizeView: React.FC<OrganizeViewProps> = ({
  pdfDoc,
  numPages,
  onRotate,
  onDelete,
  onDuplicate,
  onInsertBlank,
  onReorder,
  onExtractSelected,
  onMergePdfFile,
  onOpenPage,
}) => {
  const [selected, setSelected] = useState<number[]>([]);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const toggle = (idx: number) => {
    setSelected((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx].sort((a, b) => a - b)
    );
  };

  return (
    <div className="organize-view">
      <div className="organize-toolbar">
        <div className="organize-info">
          <strong>Organisateur de pages</strong> — Glissez-déposez les pages pour les réordonner,
          ou cochez plusieurs pages pour les extraire.
        </div>
        <div className="organize-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={() => onInsertBlank(numPages - 1)}
          >
            <FilePlus2 size={14} /> Insérer page vierge
          </button>
          <label className="btn-secondary btn-sm">
            <FolderPlus size={14} /> Fusionner un PDF…
            <input
              type="file"
              accept="application/pdf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onMergePdfFile(f);
                e.target.value = '';
              }}
            />
          </label>
          <button
            className="btn-primary btn-sm"
            disabled={selected.length === 0}
            onClick={() => {
              onExtractSelected(selected);
              setSelected([]);
            }}
          >
            <Scissors size={14} /> Extraire / Diviser ({selected.length})
          </button>
        </div>
      </div>

      <div className="organize-grid">
        {Array.from({ length: numPages }, (_, i) => (
          <GridPageCard
            key={`${i}-${numPages}`}
            pdfDoc={pdfDoc}
            pageIndex={i}
            selected={selected.includes(i)}
            onToggleSelect={() => toggle(i)}
            onRotateLeft={() => onRotate(i, -90)}
            onRotateRight={() => onRotate(i, 90)}
            onDuplicate={() => onDuplicate(i)}
            onDelete={() => onDelete(i)}
            onOpen={() => onOpenPage(i + 1)}
            onDragStart={() => setDragFrom(i)}
            onDrop={() => {
              if (dragFrom !== null && dragFrom !== i) {
                onReorder(dragFrom, i);
              }
              setDragFrom(null);
            }}
          />
        ))}
      </div>
    </div>
  );
};
