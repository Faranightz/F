import React, { useEffect, useState } from 'react';
import { FileBadge, FileKey2, KeyRound, MapPin, X } from 'lucide-react';
import type { CertificateInfo, CertificateRef } from '../types/pdf';

export interface CertSignRequest {
  cert: CertificateRef;
  password: string;
  info: CertificateInfo;
  reason: string;
  location: string;
  contact: string;
  visible: boolean;
}

/**
 * Digital signature with a certificate (.pfx / .p12), like "Sign with a digital ID"
 * in Foxit / Acrobat. The certificate file and its private key stay in the main process.
 */
export const CertSignModal: React.FC<{
  hasZone: boolean;
  zonePage: number | null;
  busy: boolean;
  error: string | null;
  initial: Partial<CertSignRequest> | null;
  onPlaceZone: (draft: Partial<CertSignRequest>) => void;
  onSign: (req: CertSignRequest) => void;
  onClose: () => void;
}> = ({ hasZone, zonePage, busy, error: outerError, initial, onPlaceZone, onSign, onClose }) => {
  const api = window.fDesktop?.certificates;
  const [cert, setCert] = useState<CertificateRef | null>(initial?.cert ?? null);
  const [password, setPassword] = useState(initial?.password ?? '');
  const [info, setInfo] = useState<CertificateInfo | null>(initial?.info ?? null);
  const [reason, setReason] = useState(initial?.reason ?? 'J’approuve ce document');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [contact, setContact] = useState(initial?.contact ?? '');
  const [visible, setVisible] = useState(initial?.visible ?? true);
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState({ name: '', email: '', organization: '', password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const draft = (): Partial<CertSignRequest> => ({ cert: cert ?? undefined, password, info: info ?? undefined, reason, location, contact, visible });

  const choose = async () => {
    setError(null);
    const ref = await api?.choose();
    if (ref) {
      setCert(ref);
      setInfo(null);
      setPassword('');
    }
  };

  const check = async () => {
    if (!api || !cert) return;
    setError(null);
    setWorking(true);
    try {
      setInfo(await api.inspect(cert.id, password));
    } catch (e) {
      setInfo(null);
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Certificat illisible.');
    } finally {
      setWorking(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!api) return;
    setError(null);
    if (!newId.name.trim()) return setError('Indiquez le nom du signataire.');
    if (newId.password.length < 6) return setError('Mot de passe : 6 caractères minimum.');
    if (newId.password !== newId.confirm) return setError('Les deux mots de passe ne correspondent pas.');
    setWorking(true);
    try {
      const ref = await api.create({ name: newId.name, email: newId.email, organization: newId.organization, password: newId.password });
      if (ref) {
        setCert(ref);
        setPassword(newId.password);
        setInfo(await api.inspect(ref.id, newId.password));
        setCreating(false);
        setContact(newId.email);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Création impossible.');
    } finally {
      setWorking(false);
    }
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('fr-FR');
  const canSign = !!cert && !!info && info.valid && (!visible || hasZone) && !busy;

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal-card modal-card-lg" role="dialog" aria-modal="true" aria-labelledby="cert-modal-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-row">
            <FileBadge size={18} className="accent-icon" />
            <div>
              <h2 id="cert-modal-title">Signature numérique par certificat</h2>
              <div className="modal-subtitle">Certificat personnel (.pfx / .p12) · compatible Acrobat et Foxit</div>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Fermer">
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {!api && (
            <div className="alert-info">
              La signature par certificat est disponible dans l’application Windows F-pdf (le certificat et sa clé
              privée ne quittent jamais votre ordinateur).
            </div>
          )}
          {(error || outerError) && <div className="alert-error">{error || outerError}</div>}

          {api && !creating && (
            <>
              <div className="cert-actions">
                <button type="button" className="btn-secondary" onClick={choose} disabled={working || busy}>
                  <FileKey2 size={15} /> {cert ? `Certificat : ${cert.fileName}` : 'Choisir mon certificat (.pfx / .p12)'}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setCreating(true)} disabled={working || busy}>
                  <KeyRound size={15} /> Créer mon ID numérique
                </button>
              </div>
              {cert && (
                <div className="form-grid-2">
                  <label className="field-label">
                    Mot de passe du certificat
                    <input
                      type="password"
                      className="text-input"
                      value={password}
                      autoComplete="off"
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setInfo(null);
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && check()}
                    />
                  </label>
                  <div className="field-label">
                    &nbsp;
                    <button type="button" className="btn-secondary" onClick={check} disabled={!password || working}>
                      Vérifier le certificat
                    </button>
                  </div>
                </div>
              )}
              {info && (
                <div className={`cert-info ${!info.valid || info.selfSigned ? 'warning' : ''}`}>
                  <strong>{info.name}</strong>
                  {info.organization ? ` — ${info.organization}` : ''}
                  {info.email ? ` · ${info.email}` : ''}
                  <br />
                  Émis par : {info.selfSigned ? 'vous-même (ID numérique personnel)' : info.issuer} · valide du{' '}
                  {fmtDate(info.validFrom)} au {fmtDate(info.validTo)}
                  {!info.valid && (
                    <>
                      <br />
                      <strong>Certificat expiré ou pas encore valide : signature impossible.</strong>
                    </>
                  )}
                  {info.valid && info.selfSigned && (
                    <>
                      <br />
                      ID personnel : la signature garantit que le document n’a pas été modifié. Pour une valeur
                      légale renforcée (eIDAS), utilisez un certificat délivré par une autorité de confiance, ou Yousign.
                    </>
                  )}
                </div>
              )}

              <div className="form-grid-2">
                <label className="field-label">
                  Motif
                  <input className="text-input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
                </label>
                <label className="field-label">
                  Lieu
                  <input className="text-input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Montpellier" maxLength={200} />
                </label>
              </div>
              <label className="field-label">
                Contact (facultatif)
                <input className="text-input" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={200} />
              </label>

              <label className="ribbon-toggle">
                <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
                <span>Signature visible sur la page</span>
              </label>
              {visible && (
                <div className="cert-actions">
                  <button type="button" className="btn-secondary" onClick={() => onPlaceZone(draft())} disabled={busy}>
                    <MapPin size={15} /> {hasZone ? `Déplacer la zone (page ${zonePage})` : 'Placer la signature sur la page'}
                  </button>
                </div>
              )}
              <div className="alert-info">
                La signature est appliquée à une copie enregistrée du document. Ne modifiez plus ce fichier ensuite :
                toute modification invalide la signature.
              </div>
            </>
          )}

          {api && creating && (
            <form onSubmit={create}>
              <div className="alert-info">
                Crée un certificat personnel protégé par mot de passe (RSA 2048, valable 3 ans), enregistré dans un
                fichier .pfx que vous gardez. Il sert ensuite à signer vos documents.
              </div>
              <div className="form-grid-2">
                <label className="field-label">
                  Nom et prénom
                  <input className="text-input" value={newId.name} onChange={(e) => setNewId({ ...newId, name: e.target.value })} required />
                </label>
                <label className="field-label">
                  E-mail
                  <input type="email" className="text-input" value={newId.email} onChange={(e) => setNewId({ ...newId, email: e.target.value })} />
                </label>
              </div>
              <label className="field-label">
                Entreprise (facultatif)
                <input className="text-input" value={newId.organization} onChange={(e) => setNewId({ ...newId, organization: e.target.value })} />
              </label>
              <div className="form-grid-2">
                <label className="field-label">
                  Mot de passe
                  <input type="password" className="text-input" autoComplete="new-password" value={newId.password} onChange={(e) => setNewId({ ...newId, password: e.target.value })} />
                </label>
                <label className="field-label">
                  Confirmer
                  <input type="password" className="text-input" autoComplete="new-password" value={newId.confirm} onChange={(e) => setNewId({ ...newId, confirm: e.target.value })} />
                </label>
              </div>
              <div className="cert-actions">
                <button type="button" className="btn-secondary" onClick={() => setCreating(false)} disabled={working}>
                  Retour
                </button>
                <button type="submit" className="btn-primary" disabled={working}>
                  {working ? 'Création…' : 'Créer et enregistrer mon ID'}
                </button>
              </div>
            </form>
          )}
        </div>

        {api && !creating && (
          <div className="modal-footer">
            <button className="btn-secondary" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button
              className="btn-primary"
              disabled={!canSign}
              title={visible && !hasZone ? 'Placez d’abord la signature sur la page' : undefined}
              onClick={() => cert && info && onSign({ cert, password, info, reason, location, contact, visible })}
            >
              <FileBadge size={15} /> {busy ? 'Signature…' : 'Signer et enregistrer'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
