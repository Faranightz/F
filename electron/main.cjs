const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');

const isDev = process.env.ELECTRON_DEV === '1';
const MAX_PDF_BYTES = 100 * 1024 * 1024; // 100 MB safety cap
const FETCH_TIMEOUT_MS = 30000;
const DIST_INDEX_URL = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;

let mainWindow = null;
let ephemeralYousignConfig = null; // In-memory fallback if OS DPAPI is unavailable

function assertMainSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Origine IPC non autorisée.');
  }
}

function getYousignConfigPath() {
  return path.join(app.getPath('userData'), 'f-yousign-config.enc');
}

// Validates a Yousign history record coming from the renderer before any network call
function assertYousignRecord(record) {
  if (
    !record ||
    (record.env !== 'sandbox' && record.env !== 'production') ||
    typeof record.id !== 'string' ||
    !/^[A-Za-z0-9-]{1,80}$/.test(record.id) ||
    (record.documentId !== undefined && !/^[A-Za-z0-9-]{1,80}$/.test(String(record.documentId)))
  ) {
    throw new Error('Demande Yousign invalide.');
  }
}

// Reads Yousign's error detail (never contains our API key) to give a useful message
async function yousignErrorDetail(res) {
  try {
    const data = await res.json();
    const detail = data?.detail || data?.message || data?.title;
    return detail ? ` — ${String(detail).slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

function getYousignBaseUrl(env) {
  return env === 'production'
    ? 'https://api.yousign.app/v3'
    : 'https://api-sandbox.yousign.app/v3';
}

async function readYousignSecretConfig() {
  if (!safeStorage.isEncryptionAvailable()) {
    return ephemeralYousignConfig || { env: 'demo', apiKey: '' };
  }
  const filePath = getYousignConfigPath();
  try {
    const raw = await fs.readFile(filePath);
    const jsonText = safeStorage.decryptString(raw);
    const parsed = JSON.parse(jsonText);
    return {
      env: parsed.env === 'production' || parsed.env === 'sandbox' ? parsed.env : 'demo',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    };
  } catch {
    return { env: 'demo', apiKey: '' };
  }
}

async function writeYousignSecretConfig(cfg) {
  const safeCfg = {
    env: cfg.env === 'production' || cfg.env === 'sandbox' ? cfg.env : 'demo',
    apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '',
  };
  if (!safeStorage.isEncryptionAvailable()) {
    // Never write plaintext API keys to disk: keep in-memory for this session only
    ephemeralYousignConfig = safeCfg;
    return { env: safeCfg.env, hasApiKey: Boolean(safeCfg.apiKey), ephemeral: true };
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(safeCfg));
  await fs.writeFile(getYousignConfigPath(), encrypted);
  return { env: safeCfg.env, hasApiKey: Boolean(safeCfg.apiKey), ephemeral: false };
}

function isAllowedExternalUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function extractPdfArg(argv) {
  return argv.find(
    (arg) => typeof arg === 'string' && !arg.startsWith('-') && arg.toLowerCase().endsWith('.pdf')
  );
}

async function sendPdfFileToWindow(filePath) {
  if (!filePath || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_PDF_BYTES) return;
    const buf = await fs.readFile(filePath);
    mainWindow.webContents.send('file:opened', {
      name: path.basename(filePath),
      bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    });
  } catch {
    // Ignore unreadable CLI argument
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: 'F-pdf',
    icon: path.join(__dirname, '../dist/icon.png'),
    backgroundColor: '#f5f7fc',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });

  Menu.setApplicationMenu(null);

  // Strictly restrict top-level navigation to app entrypoint only
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const allowedDev = isDev && targetUrl.startsWith('http://localhost:5173');
    const allowedProd = !isDev && (targetUrl === DIST_INDEX_URL || targetUrl.startsWith(`${DIST_INDEX_URL}#`));
    if (!allowedDev && !allowedProd) {
      event.preventDefault();
      if (isAllowedExternalUrl(targetUrl)) {
        shell.openExternal(targetUrl);
      }
    }
  });

  // The renderer blocks unload when a document is unsaved: ask the user what to do
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Quitter sans enregistrer', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      title: 'Modifications non enregistrées — F-pdf',
      message: 'Un ou plusieurs documents contiennent des modifications non enregistrées.',
      detail: 'Si vous quittez maintenant, ces modifications seront perdues.',
    });
    if (choice === 0) event.preventDefault(); // preventDefault here = allow closing
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.once('did-finish-load', () => {
    const initialPdf = extractPdfArg(process.argv.slice(1));
    if (initialPdf) {
      sendPdfFileToWindow(initialPdf);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single-instance lock for Windows .pdf file association double-clicks
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const pdfPath = extractPdfArg(commandLine.slice(1));
      if (pdfPath) sendPdfFileToWindow(pdfPath);
    }
  });
}

// Binary IPC: Open PDF
ipcMain.handle('dialog:openPdf', async (event) => {
  assertMainSender(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Ouvrir un document PDF — F-pdf',
    filters: [{ name: 'Documents PDF', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || result.filePaths.length === 0) return [];

  const loaded = [];
  for (const filePath of result.filePaths) {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_PDF_BYTES) {
      throw new Error(`Le fichier ${path.basename(filePath)} dépasse la limite de 100 Mo.`);
    }
    const buf = await fs.readFile(filePath);
    loaded.push({
      name: path.basename(filePath),
      bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    });
  }
  return loaded;
});

// Binary IPC: Save PDF
ipcMain.handle('dialog:savePdf', async (event, payload) => {
  assertMainSender(event);
  if (!payload || !(payload.bytes instanceof Uint8Array)) {
    throw new Error('Données PDF invalides.');
  }
  if (payload.bytes.byteLength === 0 || payload.bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error('Taille du document PDF hors limites.');
  }
  const safeBase = path
    .basename(String(payload.defaultName || 'document.pdf'))
    .replace(/[<>:"/\\|?*]/g, '_');
  const defaultPath = safeBase.toLowerCase().endsWith('.pdf') ? safeBase : `${safeBase}.pdf`;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Enregistrer le document PDF — F-pdf',
    defaultPath,
    filters: [{ name: 'Document PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { saved: false };

  await fs.writeFile(result.filePath, Buffer.from(payload.bytes));
  return { saved: true, filePath: path.basename(result.filePath) };
});

ipcMain.handle('shell:openExternal', async (event, url) => {
  assertMainSender(event);
  if (typeof url === 'string' && isAllowedExternalUrl(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

// Digital signature with a certificate (.pfx / .p12)
const signing = require('./signing.cjs');

ipcMain.handle('cert:choose', async (event) => {
  assertMainSender(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir un certificat de signature — F-pdf',
    filters: [{ name: 'Certificat (PKCS#12)', extensions: ['pfx', 'p12'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return signing.rememberCertificate(result.filePaths[0]);
});

ipcMain.handle('cert:inspect', async (event, id, password) => {
  assertMainSender(event);
  return signing.inspectCertificate(String(id), String(password ?? ''));
});

ipcMain.handle('cert:create', async (event, req) => {
  assertMainSender(event);
  const name = String(req?.name ?? '').trim().slice(0, 120);
  const password = String(req?.password ?? '');
  if (!name) throw new Error('Le nom est obligatoire.');
  if (password.length < 6) throw new Error('Le mot de passe doit contenir au moins 6 caractères.');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Enregistrer mon ID numérique — F-pdf',
    defaultPath: `${name.replace(/[<>:"/\\|?*]/g, '_')}.pfx`,
    filters: [{ name: 'Certificat (PKCS#12)', extensions: ['pfx'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const p12 = signing.createSelfSignedP12({
    name,
    email: String(req?.email ?? '').trim().slice(0, 120),
    organization: String(req?.organization ?? '').trim().slice(0, 120),
    password,
  });
  await fs.writeFile(result.filePath, p12);
  return signing.rememberCertificate(result.filePath);
});

ipcMain.handle('cert:sign', async (event, req) => {
  assertMainSender(event);
  if (!(req?.pdfBytes instanceof Uint8Array) || req.pdfBytes.byteLength === 0 || req.pdfBytes.byteLength > MAX_PDF_BYTES) {
    throw new Error('Document PDF invalide ou trop volumineux.');
  }
  return signing.signPdf({
    id: String(req.id),
    password: String(req.password ?? ''),
    pdfBytes: req.pdfBytes,
    reason: String(req.reason ?? '').slice(0, 200),
    location: String(req.location ?? '').slice(0, 200),
    contact: String(req.contact ?? '').slice(0, 200),
    pageIndex: Number(req.pageIndex) || 0,
    rect: Array.isArray(req.rect) ? req.rect : null,
  });
});

// Small encrypted store (Windows DPAPI) for sensitive user data such as saved signatures
const SECURE_KEYS = new Set(['signatures']);
const SECURE_MAX_CHARS = 8 * 1024 * 1024;
function getSecurePath(key) {
  return path.join(app.getPath('userData'), `f-${key}.enc`);
}

ipcMain.handle('secure:get', async (event, key) => {
  assertMainSender(event);
  if (!SECURE_KEYS.has(key) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(await fs.readFile(getSecurePath(key)));
  } catch {
    return null;
  }
});

ipcMain.handle('secure:set', async (event, key, value) => {
  assertMainSender(event);
  if (!SECURE_KEYS.has(key) || typeof value !== 'string' || value.length > SECURE_MAX_CHARS) {
    throw new Error('Données invalides.');
  }
  if (!safeStorage.isEncryptionAvailable()) return false;
  await fs.writeFile(getSecurePath(key), safeStorage.encryptString(value));
  return true;
});

// Yousign DPAPI encrypted config + Main-process API v3 proxy
ipcMain.handle('yousign:getConfig', async (event) => {
  assertMainSender(event);
  const cfg = await readYousignSecretConfig();
  return {
    env: cfg.env,
    hasApiKey: Boolean(cfg.apiKey),
    ephemeral: !safeStorage.isEncryptionAvailable(),
  };
});

ipcMain.handle('yousign:saveConfig', async (event, incoming) => {
  assertMainSender(event);
  const existing = await readYousignSecretConfig();
  const nextApiKey =
    typeof incoming?.apiKey === 'string' && incoming.apiKey.trim().length > 0
      ? incoming.apiKey.trim()
      : incoming?.clearKey
        ? ''
        : existing.apiKey;
  return writeYousignSecretConfig({
    env: incoming?.env || 'demo',
    apiKey: nextApiKey,
  });
});

ipcMain.handle('yousign:send', async (event, req) => {
  assertMainSender(event);
  const cfg = await readYousignSecretConfig();
  if (cfg.env === 'demo') {
    throw new Error('Le mode Démo est géré localement.');
  }
  if (!cfg.apiKey) {
    throw new Error('Clé API Yousign v3 manquante. Configurez-la dans Connexion API Yousign.');
  }
  if (!(req?.pdfBytes instanceof Uint8Array) || req.pdfBytes.byteLength > MAX_PDF_BYTES) {
    throw new Error('Document PDF invalide ou trop volumineux.');
  }
  if (!Array.isArray(req.signers) || req.signers.length === 0) {
    throw new Error('Au moins un signataire est requis.');
  }

  for (const s of req.signers) {
    const needsOtp =
      s.signatureLevel === 'advanced_electronic_signature' ||
      s.signatureLevel === 'qualified_electronic_signature';
    if (needsOtp && (!s.phoneNumber || !/^\+[1-9]\d{6,14}$/.test(String(s.phoneNumber).trim()))) {
      throw new Error(`Téléphone E.164 valide requis pour ${s.email} (AES/QES).`);
    }
  }

  const baseUrl = getYousignBaseUrl(cfg.env);
  const authHeaders = { Authorization: `Bearer ${cfg.apiKey}` };

  const createRes = await fetch(`${baseUrl}/signature_requests`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      name: String(req.requestName || 'Document F-pdf'),
      delivery_mode: req.deliveryMode === 'none' ? 'none' : 'email',
      timezone: 'Europe/Paris',
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Yousign : échec création de demande (HTTP ${createRes.status})${await yousignErrorDetail(createRes)}`);
  }
  const sr = await createRes.json();

  const formData = new FormData();
  const safeName = path.basename(String(req.pdfFilename || 'document.pdf'));
  formData.append(
    'file',
    new Blob([req.pdfBytes], { type: 'application/pdf' }),
    safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`
  );
  formData.append('nature', 'signable_document');
  formData.append('parse_anchors', 'true');

  const docRes = await fetch(`${baseUrl}/signature_requests/${encodeURIComponent(sr.id)}/documents`, {
    method: 'POST',
    headers: authHeaders,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: formData,
  });
  if (!docRes.ok) {
    throw new Error(`Yousign : échec téléversement PDF (HTTP ${docRes.status})${await yousignErrorDetail(docRes)}`);
  }
  const doc = await docRes.json();

  for (const signer of req.signers) {
    const needsOtp =
      signer.signatureLevel === 'advanced_electronic_signature' ||
      signer.signatureLevel === 'qualified_electronic_signature';
    const xVal = Number.isFinite(Number(signer.x)) ? Math.max(0, Math.round(Number(signer.x))) : 75;
    const yVal = Number.isFinite(Number(signer.y)) ? Math.max(0, Math.round(Number(signer.y))) : 620;
    const wVal = Number.isFinite(Number(signer.width)) ? Math.max(60, Math.round(Number(signer.width))) : 200;
    const hVal = Number.isFinite(Number(signer.height)) ? Math.max(30, Math.round(Number(signer.height))) : 60;

    const signerPayload = {
      info: {
        first_name: String(signer.firstName || '').trim(),
        last_name: String(signer.lastName || '').trim(),
        email: String(signer.email || '').trim(),
        ...(signer.phoneNumber ? { phone_number: String(signer.phoneNumber).trim() } : {}),
        locale: 'fr',
      },
      signature_level: signer.signatureLevel || 'electronic_signature',
      signature_authentication_mode: needsOtp ? 'otp_sms' : 'no_otp',
      fields: [
        {
          document_id: doc.id,
          type: 'signature',
          page: Math.max(1, Number(signer.page) || 1),
          x: xVal,
          y: yVal,
          width: wVal,
          height: hVal,
        },
      ],
    };
    const sRes = await fetch(`${baseUrl}/signature_requests/${encodeURIComponent(sr.id)}/signers`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify(signerPayload),
    });
    if (!sRes.ok) {
      throw new Error(`Yousign : échec ajout signataire ${signer.email} (HTTP ${sRes.status})${await yousignErrorDetail(sRes)}`);
    }
  }

  const actRes = await fetch(`${baseUrl}/signature_requests/${encodeURIComponent(sr.id)}/activate`, {
    method: 'POST',
    headers: authHeaders,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!actRes.ok) {
    throw new Error(`Yousign : échec activation de la demande (HTTP ${actRes.status})${await yousignErrorDetail(actRes)}`);
  }
  const activated = await actRes.json();

  return {
    id: activated.id || sr.id,
    name: String(req.requestName || 'Document F-pdf'),
    env: cfg.env,
    status: activated.status || 'ongoing',
    createdAt: new Date().toISOString(),
    documentId: doc.id,
    signers: req.signers.map((s, idx) => ({
      name: `${s.firstName} ${s.lastName}`.trim(),
      email: s.email,
      status: activated.signers?.[idx]?.status || 'notified',
      signatureLink: activated.signers?.[idx]?.signature_link,
    })),
  };
});

ipcMain.handle('yousign:status', async (event, record) => {
  assertMainSender(event);
  assertYousignRecord(record);
  const cfg = await readYousignSecretConfig();
  if (cfg.env !== record.env) {
    throw new Error(`Environnement différent : la demande appartient à ${record.env.toUpperCase()}.`);
  }
  if (!cfg.apiKey) {
    throw new Error('Clé API Yousign manquante.');
  }
  const baseUrl = getYousignBaseUrl(record.env);
  const res = await fetch(
    `${baseUrl}/signature_requests/${encodeURIComponent(String(record.id))}`,
    {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    throw new Error(`Impossible de rafraîchir le statut (HTTP ${res.status})${await yousignErrorDetail(res)}`);
  }
  const data = await res.json();
  return {
    ...record,
    status: data.status || record.status,
    signers: (record.signers || []).map((s, idx) => ({
      ...s,
      status: data.signers?.[idx]?.status || s.status,
      signatureLink: data.signers?.[idx]?.signature_link || s.signatureLink,
    })),
  };
});

ipcMain.handle('yousign:download', async (event, record) => {
  assertMainSender(event);
  assertYousignRecord(record);
  const cfg = await readYousignSecretConfig();
  if (cfg.env !== record.env) {
    throw new Error(`Environnement différent : la demande appartient à ${record.env.toUpperCase()}.`);
  }
  if (!cfg.apiKey || !record.documentId) {
    throw new Error('Clé API ou identifiant de document Yousign manquant.');
  }
  const baseUrl = getYousignBaseUrl(record.env);
  const res = await fetch(
    `${baseUrl}/signature_requests/${encodeURIComponent(String(record.id))}/documents/${encodeURIComponent(String(record.documentId))}/download`,
    {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    throw new Error(`Téléchargement PDF signé impossible (HTTP ${res.status})${await yousignErrorDetail(res)}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
});

app.whenReady().then(() => {
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const csp =
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: data:; frame-src 'self' blob:; object-src 'none'; base-uri 'self';";
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      });
    });
  }

  // Deny every browser permission except copying text (camera, micro, geolocation, notifications...)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === 'clipboard-sanitized-write')
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
