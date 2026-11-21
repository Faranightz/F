import React, { useEffect, useRef, useState } from 'react';
import { Check, Eraser, PenTool, Type, Upload, X } from 'lucide-react';
import type { SavedSignature } from '../types/pdf';
import { normalizeImageFileToDataUrl } from '../utils/pdfEngine';

const MAX_SIG_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB

interface SignatureModalProps {
  isOpen: boolean;
  onClose: () => void;
  savedSignatures: SavedSignature[];
  onSelectSignature: (dataUrl: string, label: string) => void;
  onDeleteSaved: (id: string) => void;
}

export const SignatureModal: React.FC<SignatureModalProps> = ({
  isOpen,
  onClose,
  savedSignatures,
  onSelectSignature,
  onDeleteSaved,
}) => {
  const [mode, setMode] = useState<'draw' | 'type' | 'upload'>('draw');
  const [typedText, setTypedText] = useState('Camille Martin');
  const [inkColor, setInkColor] = useState('#112244');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const [hasStroke, setHasStroke] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || mode !== 'draw') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, [isOpen, mode]);

  if (!isOpen) return null;

  const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * e.currentTarget.width,
      y: ((e.clientY - rect.top) / rect.height) * e.currentTarget.height,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const p = getPos(e);
    ctx.strokeStyle = inkColor;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    setHasStroke(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const p = getPos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };

  const onPointerUp = () => {
    drawingRef.current = false;
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasStroke(false);
  };

  const confirmDrawn = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasStroke) return;
    onSelectSignature(canvas.toDataURL('image/png'), 'Signature manuscrite');
    setHasStroke(false);
    onClose();
  };

  const confirmTyped = () => {
    if (!typedText.trim()) return;
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 140;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = inkColor;
    ctx.font = 'italic 600 54px "Segoe Script", "Brush Script MT", Georgia, cursive';
    ctx.textBaseline = 'middle';
    ctx.fillText(typedText.trim(), 24, 74);
    onSelectSignature(canvas.toDataURL('image/png'), typedText.trim());
    onClose();
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_SIG_IMAGE_BYTES) {
      setUploadError('L’image dépasse 2 Mo. Veuillez choisir un fichier plus léger.');
      e.target.value = '';
      return;
    }
    try {
      const safeDataUrl = await normalizeImageFileToDataUrl(file);
      onSelectSignature(safeDataUrl, file.name);
      onClose();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Format image non supporté.');
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sig-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title-row">
            <PenTool size={18} className="accent-icon" />
            <h2 id="sig-modal-title">Créer ou choisir une signature</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer la fenêtre de signature">
            <X size={18} />
          </button>
        </div>

        <div className="modal-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={mode === 'draw'}
            className={`modal-tab ${mode === 'draw' ? 'active' : ''}`}
            onClick={() => {
              setMode('draw');
              setHasStroke(false);
            }}
          >
            <PenTool size={14} /> Dessiner
          </button>
          <button
            role="tab"
            aria-selected={mode === 'type'}
            className={`modal-tab ${mode === 'type' ? 'active' : ''}`}
            onClick={() => setMode('type')}
          >
            <Type size={14} /> Taper
          </button>
          <button
            role="tab"
            aria-selected={mode === 'upload'}
            className={`modal-tab ${mode === 'upload' ? 'active' : ''}`}
            onClick={() => setMode('upload')}
          >
            <Upload size={14} /> Importer image
          </button>
        </div>

        <div className="modal-body">
          <div className="color-row">
            <span>Couleur d’encre :</span>
            {['#112244', '#0f172a', '#1d4ed8', '#b91c1c'].map((c) => (
              <button
                key={c}
                type="button"
                className={`color-dot ${inkColor === c ? 'selected' : ''}`}
                style={{ backgroundColor: c }}
                onClick={() => setInkColor(c)}
                aria-label={`Couleur d’encre ${c}`}
              />
            ))}
          </div>

          {uploadError && (
            <div className="alert-error" role="alert">
              {uploadError}
            </div>
          )}

          {mode === 'draw' && (
            <div className="sig-pad-wrap">
              <canvas
                ref={canvasRef}
                width={520}
                height={180}
                className="sig-pad-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
              />
              <div className="sig-pad-actions">
                <button type="button" className="btn-secondary btn-sm" onClick={clearCanvas}>
                  <Eraser size={14} /> Effacer
                </button>
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={!hasStroke}
                  onClick={confirmDrawn}
                >
                  <Check size={14} /> Utiliser cette signature
                </button>
              </div>
            </div>
          )}

          {mode === 'type' && (
            <div className="form-stack">
              <input
                className="text-input"
                value={typedText}
                onChange={(e) => setTypedText(e.target.value)}
                placeholder="Votre nom complet…"
                aria-label="Nom à calligraphier"
              />
              <div className="sig-type-preview" style={{ color: inkColor }}>
                {typedText || 'Aperçu signature'}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-primary" onClick={confirmTyped}>
                  <Check size={14} /> Utiliser cette signature
                </button>
              </div>
            </div>
          )}

          {mode === 'upload' && (
            <label className="upload-dropzone">
              <Upload size={26} />
              <span>Cliquez pour importer une image PNG / JPG / WebP (max 2 Mo)</span>
              <input type="file" accept="image/*" hidden onChange={handleUpload} />
            </label>
          )}

          {savedSignatures.length > 0 && (
            <div className="saved-sig-section">
              <h3>Signatures enregistrées</h3>
              <div className="saved-sig-grid">
                {savedSignatures.map((sig) => (
                  <div key={sig.id} className="saved-sig-item">
                    <button
                      type="button"
                      className="saved-sig-btn"
                      onClick={() => {
                        onSelectSignature(sig.dataUrl, sig.label);
                        onClose();
                      }}
                    >
                      <img src={sig.dataUrl} alt={sig.label} />
                      <span>{sig.label}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      onClick={() => onDeleteSaved(sig.id)}
                      aria-label={`Supprimer ${sig.label}`}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
