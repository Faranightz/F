import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Crosshair,
  Download,
  ExternalLink,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import type { YousignPlacedZone } from '../types/pdf';
import {
  createAndSendYousignRequest,
  downloadSignedYousignPdf,
  isSafeHttpsUrl,
  loadYousignConfigState,
  loadYousignHistory,
  refreshYousignStatus,
  saveYousignConfigState,
  saveYousignHistory,
  type YousignConfigState,
  type YousignEnv,
  type YousignRequestRecord,
  type YousignSignatureLevel,
  type YousignSignerInput,
} from '../utils/yousign';

interface YousignModalProps {
  isOpen: boolean;
  onClose: () => void;
  documentName: string;
  numPages: number;
  currentPage: number;
  placedZone: YousignPlacedZone | null;
  onRequestVisualPlacement: () => void;
  getBakedPdfBytes: () => Promise<Uint8Array>;
  onOpenSignedPdf: (name: string, bytes: Uint8Array) => void;
  onApplyDemoYousignStamp: (signerName: string, email: string) => void;
}

export const YousignModal: React.FC<YousignModalProps> = ({
  isOpen,
  onClose,
  documentName,
  numPages,
  currentPage,
  placedZone,
  onRequestVisualPlacement,
  getBakedPdfBytes,
  onOpenSignedPdf,
  onApplyDemoYousignStamp,
}) => {
  const [tab, setTab] = useState<'send' | 'history' | 'settings'>('send');
  const [config, setConfig] = useState<YousignConfigState>({ env: 'demo', hasApiKey: false });
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [history, setHistory] = useState<YousignRequestRecord[]>(() => loadYousignHistory());

  const [requestName, setRequestName] = useState(
    () => `Signature — ${documentName.replace(/\.pdf$/i, '')}`
  );
  const [deliveryMode, setDeliveryMode] = useState<'email' | 'none'>('email');
  const [signers, setSigners] = useState<YousignSignerInput[]>(() => [
    {
      id: crypto.randomUUID(),
      firstName: 'Camille',
      lastName: 'Martin',
      email: 'camille.martin@exemple.fr',
      phoneNumber: '',
      page: placedZone?.page ?? currentPage,
      x: placedZone?.x ?? 75,
      y: placedZone?.y ?? 620,
      width: placedZone?.width ?? 200,
      height: placedZone?.height ?? 60,
      signatureLevel: 'electronic_signature',
    },
  ]);

  const [busy, setBusy] = useState(false);
  const [stepMsg, setStepMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    loadYousignConfigState()
      .then((cfg) => {
        if (!cancelled) setConfig(cfg);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const updateSigner = (id: string, patch: Partial<YousignSignerInput>) => {
    setSigners((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const addSigner = () => {
    setSigners((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        firstName: '',
        lastName: '',
        email: '',
        phoneNumber: '',
        page: currentPage,
        x: 75,
        y: 540,
        width: 200,
        height: 60,
        signatureLevel: 'electronic_signature',
      },
    ]);
  };

  const removeSigner = (id: string) => {
    if (signers.length <= 1) return;
    setSigners((prev) => prev.filter((s) => s.id !== id));
  };

  const handleSaveConfig = async () => {
    setError(null);
    try {
      const saved = await saveYousignConfigState({
        env: config.env,
        apiKey: apiKeyInput.trim() || undefined,
      });
      setConfig(saved);
      setApiKeyInput('');
      setStepMsg(
        window.fDesktop?.isElectron
          ? 'Configuration Yousign chiffrée (Windows DPAPI) et enregistrée.'
          : 'Environnement enregistré pour cette session.'
      );
      setTimeout(() => setStepMsg(''), 2800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors de la sauvegarde.');
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    for (const s of signers) {
      if (!s.firstName.trim() || !s.lastName.trim() || !s.email.trim()) {
        setError('Veuillez remplir le prénom, le nom et l’adresse e-mail de chaque signataire.');
        return;
      }
    }
    setBusy(true);
    try {
      setStepMsg('Préparation du document PDF avec vos modifications…');
      const pdfBytes = await getBakedPdfBytes();
      const record = await createAndSendYousignRequest({
        env: config.env,
        requestName: requestName.trim() || documentName,
        pdfFilename: documentName,
        pdfBytes,
        signers,
        deliveryMode,
        onStep: setStepMsg,
      });
      const updated = [record, ...history];
      setHistory(updated);
      saveYousignHistory(updated);
      if (config.env === 'demo' && signers[0]) {
        onApplyDemoYousignStamp(
          `${signers[0].firstName} ${signers[0].lastName}`,
          signers[0].email
        );
      }
      setStepMsg('');
      setTab('history');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors de l’envoi Yousign.');
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async (rec: YousignRequestRecord) => {
    setError(null);
    try {
      const refreshed = await refreshYousignStatus(config.env, rec);
      const next = history.map((h) => (h.id === rec.id ? refreshed : h));
      setHistory(next);
      saveYousignHistory(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors du rafraîchissement.');
    }
  };

  const handleDownloadSigned = async (rec: YousignRequestRecord) => {
    setError(null);
    try {
      if (rec.env === 'demo') {
        const bytes = await getBakedPdfBytes();
        onOpenSignedPdf(`${rec.name} (Signé Yousign).pdf`, bytes);
        onClose();
        return;
      }
      const bytes = await downloadSignedYousignPdf(config.env, rec);
      onOpenSignedPdf(`${rec.name} (Signé Yousign).pdf`, bytes);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Téléchargement impossible.');
    }
  };

  const handleOpenExternal = (url: string) => {
    if (!isSafeHttpsUrl(url)) return;
    if (window.fDesktop?.isElectron) {
      window.fDesktop.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const copyLink = (link: string, key: string) => {
    navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopiedId(key);
        setTimeout(() => setCopiedId(null), 1800);
      })
      .catch(() => {
        setError('Accès au presse-papiers refusé.');
      });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card modal-card-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="yousign-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title-row">
            <ShieldCheck size={20} className="yousign-brand-icon" />
            <div>
              <h2 id="yousign-modal-title">Yousign — Signature électronique eIDAS</h2>
              <span className="modal-subtitle">
                Mode actif :{' '}
                <strong>
                  {config.env === 'demo'
                    ? 'Démo locale (sans clé API)'
                    : config.env === 'sandbox'
                      ? 'Sandbox API v3 (DPAPI)'
                      : 'Production API v3 (DPAPI)'}
                </strong>
              </span>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer la fenêtre Yousign">
            <X size={18} />
          </button>
        </div>

        <div className="modal-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'send'}
            className={`modal-tab ${tab === 'send' ? 'active' : ''}`}
            onClick={() => setTab('send')}
          >
            Nouvelle demande
          </button>
          <button
            role="tab"
            aria-selected={tab === 'history'}
            className={`modal-tab ${tab === 'history' ? 'active' : ''}`}
            onClick={() => setTab('history')}
          >
            Suivi ({history.length})
          </button>
          <button
            role="tab"
            aria-selected={tab === 'settings'}
            className={`modal-tab ${tab === 'settings' ? 'active' : ''}`}
            onClick={() => setTab('settings')}
          >
            Connexion API Yousign
          </button>
        </div>

        <div className="modal-body">
          {error && (
            <div className="alert-error" role="alert">
              {error}
            </div>
          )}
          {stepMsg && (
            <div className="alert-info" role="status">
              {stepMsg}
            </div>
          )}

          {tab === 'send' && (
            <form onSubmit={handleSend} className="form-stack">
              <div className="form-grid-2">
                <label className="field-label">
                  Nom de la demande
                  <input
                    className="text-input"
                    value={requestName}
                    onChange={(e) => setRequestName(e.target.value)}
                    required
                  />
                </label>
                <label className="field-label">
                  Mode d’invitation
                  <select
                    className="text-input"
                    value={deliveryMode}
                    onChange={(e) => setDeliveryMode(e.target.value as 'email' | 'none')}
                  >
                    <option value="email">Envoi automatique par e-mail Yousign</option>
                    <option value="none">Lien de signature direct (sans e-mail)</option>
                  </select>
                </label>
              </div>

              <div className="section-header-row">
                <h3>Signataires ({signers.length})</h3>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={onRequestVisualPlacement}
                    title="Cliquer/glisser directement sur le PDF pour positionner la zone Yousign"
                  >
                    <Crosshair size={14} /> Placer visuellement sur le PDF
                  </button>
                  <button type="button" className="btn-secondary btn-sm" onClick={addSigner}>
                    <Plus size={14} /> Ajouter un signataire
                  </button>
                </div>
              </div>

              {placedZone && (
                <div className="alert-info" role="status">
                  Zone placée visuellement : Page {placedZone.page} — X:{placedZone.x}, Y:
                  {placedZone.y} ({placedZone.width}×{placedZone.height} px à 72 DPI)
                </div>
              )}

              <div className="signer-list">
                {signers.map((signer, index) => {
                  const needsPhone =
                    signer.signatureLevel === 'advanced_electronic_signature' ||
                    signer.signatureLevel === 'qualified_electronic_signature';
                  return (
                    <div key={signer.id} className="signer-card">
                      <div className="signer-card-header">
                        <strong>Signataire #{index + 1}</strong>
                        {signers.length > 1 && (
                          <button
                            type="button"
                            className="icon-btn danger"
                            onClick={() => removeSigner(signer.id)}
                            aria-label={`Supprimer le signataire ${index + 1}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                      <div className="form-grid-3">
                        <label className="field-label">
                          Prénom
                          <input
                            className="text-input"
                            value={signer.firstName}
                            onChange={(e) => updateSigner(signer.id, { firstName: e.target.value })}
                            placeholder="Prénom"
                            required
                          />
                        </label>
                        <label className="field-label">
                          Nom
                          <input
                            className="text-input"
                            value={signer.lastName}
                            onChange={(e) => updateSigner(signer.id, { lastName: e.target.value })}
                            placeholder="Nom"
                            required
                          />
                        </label>
                        <label className="field-label">
                          E-mail
                          <input
                            type="email"
                            className="text-input"
                            value={signer.email}
                            onChange={(e) => updateSigner(signer.id, { email: e.target.value })}
                            placeholder="prenom.nom@entreprise.fr"
                            required
                          />
                        </label>
                      </div>
                      <div className="form-grid-3">
                        <label className="field-label">
                          Niveau eIDAS
                          <select
                            className="text-input"
                            value={signer.signatureLevel}
                            onChange={(e) =>
                              updateSigner(signer.id, {
                                signatureLevel: e.target.value as YousignSignatureLevel,
                              })
                            }
                          >
                            <option value="electronic_signature">Simple (SES)</option>
                            <option value="advanced_electronic_signature">
                              Avancée (AES + OTP SMS)
                            </option>
                            <option value="qualified_electronic_signature">
                              Qualifiée (QES + OTP SMS)
                            </option>
                          </select>
                        </label>
                        <label className="field-label">
                          Téléphone E.164 {needsPhone ? '(requis)' : '(optionnel)'}
                          <input
                            type="tel"
                            className="text-input"
                            value={signer.phoneNumber || ''}
                            onChange={(e) =>
                              updateSigner(signer.id, { phoneNumber: e.target.value })
                            }
                            placeholder="+33612345678"
                            required={needsPhone}
                          />
                        </label>
                        <label className="field-label">
                          Page (1–{numPages})
                          <input
                            type="number"
                            min={1}
                            max={numPages}
                            className="text-input"
                            value={signer.page}
                            onChange={(e) =>
                              updateSigner(signer.id, {
                                page: Math.max(1, Math.min(numPages, Number(e.target.value) || 1)),
                              })
                            }
                          />
                        </label>
                      </div>
                      <div className="form-grid-2">
                        <label className="field-label">
                          Position X (px à 72 DPI, haut-gauche)
                          <input
                            type="number"
                            min={0}
                            className="text-input"
                            value={signer.x}
                            onChange={(e) => updateSigner(signer.id, { x: Number(e.target.value) })}
                          />
                        </label>
                        <label className="field-label">
                          Position Y (px à 72 DPI, haut-gauche)
                          <input
                            type="number"
                            min={0}
                            className="text-input"
                            value={signer.y}
                            onChange={(e) => updateSigner(signer.id, { y: Number(e.target.value) })}
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={onClose}>
                  Annuler
                </button>
                <button type="submit" className="btn-yousign" disabled={busy}>
                  <Send size={15} />
                  {busy
                    ? 'Envoi vers Yousign…'
                    : config.env === 'demo'
                      ? 'Simuler l’envoi Yousign'
                      : 'Envoyer pour signature (Yousign)'}
                </button>
              </div>
            </form>
          )}

          {tab === 'history' && (
            <div className="history-list">
              {history.length === 0 ? (
                <div className="empty-state">
                  <ShieldCheck size={36} />
                  <p>Aucune demande de signature Yousign envoyée pour l’instant.</p>
                </div>
              ) : (
                history.map((rec) => (
                  <div key={rec.id} className="history-card">
                    <div className="history-card-top">
                      <div>
                        <strong>{rec.name}</strong>
                        <div className="history-meta">
                          ID : <code>{rec.id}</code> · {rec.env.toUpperCase()} ·{' '}
                          {new Date(rec.createdAt).toLocaleString('fr-FR')}
                        </div>
                      </div>
                      <span className={`status-badge status-${rec.status}`}>
                        {rec.status === 'done'
                          ? 'Signé'
                          : rec.status === 'ongoing'
                            ? 'En attente'
                            : rec.status}
                      </span>
                    </div>

                    <div className="history-signers">
                      {rec.signers.map((s, idx) => (
                        <div key={idx} className="history-signer-row">
                          <span>
                            {s.name} ({s.email}) — <em>{s.status}</em>
                          </span>
                          {isSafeHttpsUrl(s.signatureLink) && (
                            <div className="inline-actions">
                              <button
                                className="btn-ghost btn-xs"
                                onClick={() => copyLink(s.signatureLink!, `${rec.id}-${idx}`)}
                              >
                                {copiedId === `${rec.id}-${idx}` ? (
                                  <>
                                    <CheckCircle2 size={13} /> Copié
                                  </>
                                ) : (
                                  <>
                                    <Copy size={13} /> Copier le lien
                                  </>
                                )}
                              </button>
                              {rec.env !== 'demo' && (
                                <button
                                  type="button"
                                  className="btn-ghost btn-xs"
                                  onClick={() => handleOpenExternal(s.signatureLink!)}
                                >
                                  <ExternalLink size={13} /> Ouvrir
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="history-actions">
                      <button
                        className="btn-secondary btn-sm"
                        onClick={() => handleRefresh(rec)}
                      >
                        <RefreshCw size={13} /> Rafraîchir le statut
                      </button>
                      <button
                        className="btn-primary btn-sm"
                        onClick={() => handleDownloadSigned(rec)}
                      >
                        <Download size={13} /> Ouvrir le PDF signé
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div className="form-stack">
              <label className="field-label">
                Environnement Yousign
                <select
                  className="text-input"
                  value={config.env}
                  onChange={(e) =>
                    setConfig({ ...config, env: e.target.value as YousignEnv })
                  }
                >
                  <option value="demo">Mode Démo local (tester sans clé API)</option>
                  <option value="sandbox">Yousign Sandbox (api-sandbox.yousign.app/v3)</option>
                  <option value="production">Yousign Production (api.yousign.app/v3)</option>
                </select>
              </label>

              {config.env !== 'demo' && (
                <>
                  {window.fDesktop?.isElectron ? (
                    <label className="field-label">
                      Clé API Yousign v3{' '}
                      {config.hasApiKey ? '(déjà enregistrée et chiffrée)' : '(requise)'}
                      <input
                        type="password"
                        className="text-input"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder={
                          config.hasApiKey
                            ? 'Laissez vide pour conserver la clé chiffrée actuelle'
                            : 'Collez votre clé API Yousign…'
                        }
                      />
                    </label>
                  ) : (
                    <div className="alert-info">
                      En aperçu web, aucune clé API n’est stockée dans le navigateur (sécurité &
                      CORS). Lancez l’application Windows <strong>F</strong> pour enregistrer votre
                      clé Yousign de façon chiffrée (Windows DPAPI) et envoyer de vraies demandes.
                    </div>
                  )}
                </>
              )}

              <p className="helper-note">
                Sous Windows (Electron), votre clé API est chiffrée par le système via{' '}
                <code>safeStorage</code> (DPAPI) et ne quitte jamais le processus principal.
              </p>

              <div className="modal-footer">
                <button type="button" className="btn-primary" onClick={handleSaveConfig}>
                  Enregistrer la configuration
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
