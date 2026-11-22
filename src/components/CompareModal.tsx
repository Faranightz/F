import React, { useEffect, useState } from 'react';
import { GitCompare, X } from 'lucide-react';
import type { PageComparison } from '../utils/pdfTools';

/** Shows the text differences between the active document and another PDF, page by page. */
export const CompareModal: React.FC<{
  baseName: string;
  otherName: string;
  result: PageComparison[] | null;
  error: string | null;
  onClose: () => void;
}> = ({ baseName, otherName, result, error, onClose }) => {
  const [onlyChanged, setOnlyChanged] = useState(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const totalChanges = result?.reduce((s, p) => s + p.changes, 0) ?? 0;
  const pages = (result ?? []).filter((p) => !onlyChanged || p.changes > 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card modal-card-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cmp-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title-row">
            <GitCompare size={18} className="accent-icon" />
            <div>
              <h2 id="cmp-modal-title">Comparaison de documents</h2>
              <div className="modal-subtitle">
                <span className="diff-removed-chip">− {baseName}</span>{' '}
                <span className="diff-added-chip">+ {otherName}</span>
              </div>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer la comparaison">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body compare-body">
          {error && <div className="alert-error">{error}</div>}
          {!result && !error && <p>Comparaison en cours…</p>}
          {result && (
            <>
              <div className="compare-summary">
                <strong>
                  {totalChanges === 0
                    ? 'Aucune différence de texte.'
                    : `${totalChanges} ligne(s) différente(s) sur ${result.filter((p) => p.changes).length} page(s).`}
                </strong>
                <label className="ribbon-toggle">
                  <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
                  <span>Pages modifiées seulement</span>
                </label>
              </div>
              {pages.map((p) => (
                <section key={p.page} className="compare-page">
                  <h3>
                    Page {p.page} <small>({p.changes} différence(s))</small>
                  </h3>
                  <div className="compare-lines">
                    {p.ops.map((op, i) => (
                      <div key={i} className={`diff-line diff-${op.type}`}>
                        <span className="diff-sign" aria-hidden="true">
                          {op.type === 'added' ? '+' : op.type === 'removed' ? '−' : ' '}
                        </span>
                        <span className="visually-hidden">
                          {op.type === 'added' ? 'Ajouté : ' : op.type === 'removed' ? 'Supprimé : ' : ''}
                        </span>
                        {op.text}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
