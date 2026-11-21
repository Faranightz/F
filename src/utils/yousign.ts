export type YousignEnv = 'demo' | 'sandbox' | 'production';

export type YousignSignatureLevel =
  | 'electronic_signature'
  | 'advanced_electronic_signature'
  | 'qualified_electronic_signature';

export interface YousignSignerInput {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber?: string;
  page: number; // 1-based
  x: number;
  y: number;
  width: number;
  height: number;
  signatureLevel: YousignSignatureLevel;
}

export interface YousignRequestRecord {
  id: string;
  name: string;
  env: YousignEnv;
  status: 'draft' | 'ongoing' | 'done' | 'expired' | 'canceled';
  createdAt: string;
  documentId?: string;
  signers: Array<{
    name: string;
    email: string;
    status: string;
    signatureLink?: string;
  }>;
}

export interface YousignConfigState {
  env: YousignEnv;
  hasApiKey: boolean;
}

const STORAGE_KEY_HISTORY = 'f_yousign_history_v1';
const SESSION_KEY_ENV = 'f_yousign_web_env_v1';

export function isSafeHttpsUrl(raw?: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function loadYousignConfigState(): Promise<YousignConfigState> {
  if (window.fDesktop?.isElectron) {
    return window.fDesktop.yousign.getConfig();
  }
  const env = (sessionStorage.getItem(SESSION_KEY_ENV) as YousignEnv) || 'demo';
  return { env: env === 'sandbox' || env === 'production' ? env : 'demo', hasApiKey: false };
}

export async function saveYousignConfigState(params: {
  env: YousignEnv;
  apiKey?: string;
  clearKey?: boolean;
}): Promise<YousignConfigState> {
  if (window.fDesktop?.isElectron) {
    return window.fDesktop.yousign.saveConfig(params);
  }
  sessionStorage.setItem(SESSION_KEY_ENV, params.env);
  return { env: params.env, hasApiKey: false };
}

export function loadYousignHistory(): YousignRequestRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
    if (raw) return JSON.parse(raw) as YousignRequestRecord[];
  } catch {
    // ignore corrupted history
  }
  return [];
}

export function saveYousignHistory(records: YousignRequestRecord[]) {
  try {
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(records.slice(0, 50)));
  } catch {
    // ignore storage quota errors
  }
}

export async function createAndSendYousignRequest(params: {
  env: YousignEnv;
  requestName: string;
  pdfFilename: string;
  pdfBytes: Uint8Array;
  signers: YousignSignerInput[];
  deliveryMode: 'email' | 'none';
  onStep?: (msg: string) => void;
}): Promise<YousignRequestRecord> {
  const { env, requestName, pdfFilename, pdfBytes, signers, deliveryMode, onStep } = params;

  for (const s of signers) {
    const needsOtp =
      s.signatureLevel === 'advanced_electronic_signature' ||
      s.signatureLevel === 'qualified_electronic_signature';
    if (needsOtp && (!s.phoneNumber || !/^\+[1-9]\d{6,14}$/.test(s.phoneNumber.trim()))) {
      throw new Error(
        `Le niveau ${s.signatureLevel === 'qualified_electronic_signature' ? 'QES' : 'AES'} requiert un numéro de téléphone au format E.164 (ex. +33612345678) pour ${s.email}.`
      );
    }
  }

  if (env === 'demo') {
    onStep?.('Mode démo : préparation de la demande Yousign eIDAS…');
    await new Promise((r) => setTimeout(r, 350));
    onStep?.('Mode démo : placement des zones de signature et génération du dossier…');
    await new Promise((r) => setTimeout(r, 350));
    const fakeId = `ys-demo-${Math.random().toString(36).slice(2, 10)}`;
    return {
      id: fakeId,
      name: requestName,
      env: 'demo',
      status: 'ongoing',
      createdAt: new Date().toISOString(),
      documentId: `doc-${fakeId}`,
      signers: signers.map((s, idx) => ({
        name: `${s.firstName} ${s.lastName}`.trim(),
        email: s.email,
        status: 'notified',
        signatureLink: `https://yousign.app/signatures/${fakeId}?signer=${idx + 1}`,
      })),
    };
  }

  if (!window.fDesktop?.isElectron) {
    throw new Error(
      'Pour votre sécurité (stockage chiffré DPAPI et politique CORS de l’API Yousign v3), les envois réels Sandbox/Production s’effectuent depuis l’application Windows F. En aperçu web, utilisez le Mode Démo.'
    );
  }

  onStep?.('Envoi sécurisé vers l’API Yousign v3 via le processus principal Windows…');
  const res = await window.fDesktop.yousign.send({
    requestName,
    pdfFilename,
    pdfBytes,
    signers,
    deliveryMode,
  });
  return res as YousignRequestRecord;
}

export async function refreshYousignStatus(
  currentEnv: YousignEnv,
  record: YousignRequestRecord
): Promise<YousignRequestRecord> {
  if (record.env === 'demo') {
    return {
      ...record,
      status: 'done',
      signers: record.signers.map((s) => ({ ...s, status: 'signed' })),
    };
  }
  if (currentEnv !== record.env) {
    throw new Error(
      `Environnement actif (${currentEnv.toUpperCase()}) différent de la demande (${record.env.toUpperCase()}).`
    );
  }
  if (!window.fDesktop?.isElectron) {
    throw new Error('Le rafraîchissement réel nécessite l’application Windows F.');
  }
  const res = await window.fDesktop.yousign.status(record);
  return res as YousignRequestRecord;
}

export async function downloadSignedYousignPdf(
  currentEnv: YousignEnv,
  record: YousignRequestRecord
): Promise<Uint8Array> {
  if (currentEnv !== record.env) {
    throw new Error(
      `Environnement actif (${currentEnv.toUpperCase()}) différent de la demande (${record.env.toUpperCase()}).`
    );
  }
  if (!window.fDesktop?.isElectron) {
    throw new Error('Le téléchargement réel nécessite l’application Windows F.');
  }
  return window.fDesktop.yousign.download(record);
}
