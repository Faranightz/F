import React, { useEffect, useRef, useState } from 'react';
import type * as pdfjsLib from 'pdfjs-dist';
import {
  BookOpen,
  FileStack,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCw,
  Search,
  Trash2,
} from 'lucide-react';
import type {
  OutlineEntry,
  OverlayItem,
  SearchMatch,
  SidebarPanel,
} from '../types/pdf';

interface SidebarProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  numPages: number;
  currentPage: number;
  activePanel: SidebarPanel;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onChangePanel: (panel: SidebarPanel) => void;
  onSelectPage: (page: number) => void;
  onReorderPage: (fromIndex: number, toIndex: number) => void;
  onRotatePage: (pageIndex: number) => void;
  onDeletePage: (pageIndex: number) => void;
  outline: OutlineEntry[];
  overlays: OverlayItem[];
  onSelectOverlay: (item: OverlayItem) => void;
  onDeleteOverlay: (id: string) => void;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onRunSearch: () => void;
  searchResults: SearchMatch[];
  searching: boolean;
}

const PageThumbnail: React.FC<{
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageNumber: number;
  active: boolean;
  onSelect: () => void;
  onRotate: () => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}> = ({
  pdfDoc,
  pageNumber,
  active,
  onSelect,
  onRotate,
  onDelete,
  onDragStart,
  onDrop,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(pageNumber <= 8);

  useEffect(() => {
    if (visible || !cardRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' }
    );
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: pdfjsLib.RenderTask | null = null;
    async function renderThumb() {
      if (!pdfDoc || !canvasRef.current) return;
      if (pageNumber > pdfDoc.numPages) return;
      const page = await pdfDoc.getPage(pageNumber);
      if (cancelled) return;
      const vp = page.getViewport({ scale: 0.24 });
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
    renderThumb();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdfDoc, pageNumber, visible]);

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      aria-label={`Aller à la page ${pageNumber}`}
      aria-current={active ? 'page' : undefined}
      className={`thumb-card ${active ? 'active' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="thumb-canvas-wrap">
        <canvas ref={canvasRef} />
        <div className="thumb-hover-actions">
          <button
            type="button"
            className="thumb-mini-btn"
            title="Pivoter +90°"
            aria-label={`Pivoter la page ${pageNumber}`}
            onClick={(e) => {
              e.stopPropagation();
              onRotate();
            }}
          >
            <RotateCw size={12} />
          </button>
          <button
            type="button"
            className="thumb-mini-btn danger"
            title="Supprimer la page"
            aria-label={`Supprimer la page ${pageNumber}`}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <span className="thumb-label">Page {pageNumber}</span>
    </div>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  pdfDoc,
  numPages,
  currentPage,
  activePanel,
  collapsed,
  onToggleCollapsed,
  onChangePanel,
  onSelectPage,
  onReorderPage,
  onRotatePage,
  onDeletePage,
  outline,
  overlays,
  onSelectOverlay,
  onDeleteOverlay,
  searchQuery,
  onSearchQueryChange,
  onRunSearch,
  searchResults,
  searching,
}) => {
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  return (
    <aside className={`left-sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-rail">
        <button
          className="rail-btn"
          onClick={onToggleCollapsed}
          title={collapsed ? 'Déplier le panneau latéral' : 'Replier le panneau latéral'}
          aria-label={collapsed ? 'Déplier le panneau latéral' : 'Replier le panneau latéral'}
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
        <button
          className={`rail-btn ${!collapsed && activePanel === 'thumbnails' ? 'active' : ''}`}
          onClick={() => {
            onChangePanel('thumbnails');
            if (collapsed) onToggleCollapsed();
          }}
          title="Miniatures des pages"
          aria-label="Miniatures des pages"
        >
          <FileStack size={18} />
        </button>
        <button
          className={`rail-btn ${!collapsed && activePanel === 'outline' ? 'active' : ''}`}
          onClick={() => {
            onChangePanel('outline');
            if (collapsed) onToggleCollapsed();
          }}
          title="Signets / Plan"
          aria-label="Signets et plan du document"
        >
          <BookOpen size={18} />
        </button>
        <button
          className={`rail-btn ${!collapsed && activePanel === 'comments' ? 'active' : ''}`}
          onClick={() => {
            onChangePanel('comments');
            if (collapsed) onToggleCollapsed();
          }}
          title="Commentaires & annotations"
          aria-label="Liste des commentaires et annotations"
        >
          <MessageSquare size={18} />
          {overlays.length > 0 && <span className="rail-badge">{overlays.length}</span>}
        </button>
        <button
          className={`rail-btn ${!collapsed && activePanel === 'search' ? 'active' : ''}`}
          onClick={() => {
            onChangePanel('search');
            if (collapsed) onToggleCollapsed();
          }}
          title="Recherche plein texte"
          aria-label="Recherche plein texte"
        >
          <Search size={18} />
        </button>
      </div>

      {!collapsed && (
        <div className="sidebar-content">
          <div className="sidebar-header">
            {activePanel === 'thumbnails' && `Pages (${numPages})`}
            {activePanel === 'outline' && 'Signets / Plan'}
            {activePanel === 'comments' && `Annotations (${overlays.length})`}
            {activePanel === 'search' && 'Recherche'}
          </div>

          <div className="sidebar-scroll">
            {activePanel === 'thumbnails' && (
              <div className="thumb-list">
                {Array.from({ length: numPages }, (_, i) => (
                  <PageThumbnail
                    key={`${i}-${numPages}`}
                    pdfDoc={pdfDoc}
                    pageNumber={i + 1}
                    active={currentPage === i + 1}
                    onSelect={() => onSelectPage(i + 1)}
                    onRotate={() => onRotatePage(i)}
                    onDelete={() => onDeletePage(i)}
                    onDragStart={() => setDragFrom(i)}
                    onDrop={() => {
                      if (dragFrom !== null && dragFrom !== i) {
                        onReorderPage(dragFrom, i);
                      }
                      setDragFrom(null);
                    }}
                  />
                ))}
              </div>
            )}

            {activePanel === 'outline' && (
              <div className="outline-list">
                {outline.map((entry, idx) => (
                  <button
                    key={idx}
                    className={`outline-item ${currentPage === entry.pageIndex + 1 ? 'active' : ''}`}
                    onClick={() => onSelectPage(entry.pageIndex + 1)}
                  >
                    <span className="outline-title">{entry.title}</span>
                    <span className="outline-page">p.{entry.pageIndex + 1}</span>
                  </button>
                ))}
              </div>
            )}

            {activePanel === 'comments' && (
              <div className="comments-list">
                {overlays.length === 0 ? (
                  <p className="sidebar-empty">
                    Aucune annotation sur ce document. Utilisez les onglets Commentaire, Éditer ou
                    Formulaire pour ajouter des éléments.
                  </p>
                ) : (
                  overlays.map((item) => (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      className="comment-card"
                      onClick={() => onSelectOverlay(item)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectOverlay(item);
                        }
                      }}
                    >
                      <div className="comment-card-head">
                        <span
                          className="comment-dot"
                          style={{ backgroundColor: item.color }}
                        />
                        <strong>{item.kind.toUpperCase()}</strong>
                        <span className="comment-page">p.{item.pageIndex + 1}</span>
                        <button
                          className="icon-btn danger"
                          aria-label="Supprimer cette annotation"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteOverlay(item.id);
                          }}
                          title="Supprimer"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <p className="comment-preview">
                        {item.text || item.stampLabel || 'Élément graphique'}
                      </p>
                    </div>
                  ))
                )}
              </div>
            )}

            {activePanel === 'search' && (
              <div className="search-panel">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    onRunSearch();
                  }}
                  className="search-form"
                >
                  <input
                    className="text-input"
                    aria-label="Terme à rechercher dans le PDF"
                    value={searchQuery}
                    onChange={(e) => onSearchQueryChange(e.target.value)}
                    placeholder="Rechercher un mot…"
                  />
                  <button type="submit" className="btn-primary btn-sm" disabled={searching}>
                    {searching ? '…' : 'OK'}
                  </button>
                </form>
                <div className="search-results">
                  {searchResults.length === 0 && searchQuery.trim() !== '' && !searching && (
                    <p className="sidebar-empty">Aucun résultat trouvé.</p>
                  )}
                  {searchResults.map((match) => (
                    <button
                      key={match.pageIndex}
                      className="search-result-card"
                      onClick={() => onSelectPage(match.pageIndex + 1)}
                    >
                      <div className="search-result-head">
                        <strong>Page {match.pageIndex + 1}</strong>
                        <span>{match.count} occ.</span>
                      </div>
                      <p>{match.snippet}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
};
