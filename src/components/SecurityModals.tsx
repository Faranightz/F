import React, { useEffect, useState } from 'react';
import { Lock, LockOpen, X } from 'lucide-react';
import type { PdfSecurity } from '../types/pdf';

/** Asked when opening a password-protected PDF. */
export const PasswordPromptModal: React.FC<{
  fileName: string;
  error?: string;
  onSubmit: (password: string | null) => void;
}> = ({ fileName, error, onSubmit }) => {
  const [password, setPassword] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSubmit(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSubmit]);

  return (
    <div className="modal-backdrop">
      <form
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pw-modal-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) onSubmit(password);
        }}
      >
        <div className="modal-header">
          <div className="modal-title-row">
            <Lock size={18} className="accent-icon" />
            <h2 id="pw-modal-title">Document protégé</h2>
          </div>
          <button type="button" className="icon-btn" onClick={() => onSubmit(null)} aria-label="Annuler">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <p>
            « {fileName} » est protégé par un mot de passe. Saisissez-le pour l’ouvrir.
          </p>
          {error && <div className="alert-error">{error}</div>}
          <label className="field-label">
            Mot de passe
            <input
              type="password"
              className="text-input"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
          </label>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={() => onSubmit(null)}>
            Annuler
          </button>
          <button type="submit" className="btn-primary" disabled={!password}>
            Ouvrir
          </button>
        </div>
      </form>
    </div>
  );
};

/** Sets or removes the password protection applied when the document is saved. */
export const SecurityModal: React.FC<{
  current: PdfSecurity | null;
  onApply: (sec: PdfSecurity | null) => void;
  onClose: () => void;
}> = ({ current, onApply, onClose }) => {
  const [userPassword, setUserPassword] = useState(current?.userPassword ?? '');
  const [confirm, setConfirm] = useState(current?.userPassword ?? '');
  const [ownerPassword, setOwnerPassword] = useState(current?.ownerPassword ?? '');
  const [allowPrint, setAllowPrint] = useState(current?.allowPrint ?? true);
  const [allowCopy, setAllowCopy] = useState(current?.allowCopy ?? false);
  const [allowModify, setAllowModify] = useState(current?.allowModify ?? false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (userPassword.length < 4) return setError('Le mot de passe doit contenir au moins 4 caractères.');
    if (userPassword !== confirm) return setError('Les deux mots de passe ne correspondent pas.');
    if (ownerPassword && ownerPassword === userPassword) {
      return setError('Le mot de passe propriétaire doit être différent du mot de passe d’ouverture.');
    }
    onApply({ userPassword, ownerPassword, allowPrint, allowCopy, allowModify });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sec-modal-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-header">
          <div className="modal-title-row">
            <Lock size={18} className="accent-icon" />
            <h2 id="sec-modal-title">Protéger par mot de passe</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fermer">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="alert-info">
            Chiffrement AES-256, appliqué à l’enregistrement du PDF. Sans le mot de passe, le
            document ne peut pas être ouvert. Notez-le : il ne peut pas être retrouvé.
          </div>
          {error && <div className="alert-error">{error}</div>}
          <div className="form-grid-2">
            <label className="field-label">
              Mot de passe d’ouverture
              <input type="password" className="text-input" value={userPassword} autoComplete="new-password" onChange={(e) => setUserPassword(e.target.value)} />
            </label>
            <label className="field-label">
              Confirmer
              <input type="password" className="text-input" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
            </label>
          </div>
          <label className="field-label">
            Mot de passe propriétaire (facultatif)
            <input
              type="password"
              className="text-input"
              value={ownerPassword}
              autoComplete="new-password"
              placeholder="Donne tous les droits ; les restrictions ci-dessous s’appliquent aux autres"
              onChange={(e) => setOwnerPassword(e.target.value)}
            />
          </label>
          <fieldset className="permissions-fieldset">
            <legend>Autorisations avec le mot de passe d’ouverture</legend>
            <label className="ribbon-toggle">
              <input type="checkbox" checked={allowPrint} onChange={(e) => setAllowPrint(e.target.checked)} />
              <span>Impression</span>
            </label>
            <label className="ribbon-toggle">
              <input type="checkbox" checked={allowCopy} onChange={(e) => setAllowCopy(e.target.checked)} />
              <span>Copie du texte</span>
            </label>
            <label className="ribbon-toggle">
              <input type="checkbox" checked={allowModify} onChange={(e) => setAllowModify(e.target.checked)} />
              <span>Modification et annotations</span>
            </label>
            {!ownerPassword && (
              <small>Sans mot de passe propriétaire, ces restrictions sont facilement contournables.</small>
            )}
          </fieldset>
        </div>
        <div className="modal-footer">
          {current && (
            <button type="button" className="btn-secondary" onClick={() => onApply(null)}>
              <LockOpen size={15} /> Retirer la protection
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="btn-primary">
            Appliquer
          </button>
        </div>
      </form>
    </div>
  );
};
