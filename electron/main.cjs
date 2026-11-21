const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const isDev = process.env.ELECTRON_DEV === '1';
const MAX_PDF_BYTES = 100 * 1024 * 1024; // 100 MB safety cap

let mainWindow = null;

function getYousignConfigPath() {
  return path.join(app.getPath('userData'), 'f-yousign-config.enc');
}

function getYousignBaseUrl(env) {
  return env === 'production'
    ? 'https://api.yousign.app/v3'
    : 'https://api-sandbox.yousign.app/v3';
}

async function readYousignSecretConfig() {
  const filePath = getYousignConfigPath();
  try {
    const raw = await fs.readFile(filePath);
    let jsonText;
    if (safeStorage.isEncryptionAvailable()) {
      jsonText = safeStorage.decryptString(raw);
    } else {
      jsonText = raw.toString('utf8');
    }
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
  const payload = JSON.stringify(safeCfg);
  const filePath = getYousignConfigPath();
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(payload);
    await fs.writeFile(filePath, encrypted);
  } else {
    await fs.writeFile(filePath, payload, 'utf8');
  }
  return { env: safeCfg.env, hasApiKey: Boolean(safeCfg.apiKey) };
}

function isAllowedExternalUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: 'F',
    backgroundColor: '#f1f3f6',
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

  // Restrict navigation and external windows
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const allowedDev = isDev && targetUrl.startsWith('http://localhost:5173');
    const allowedFile = !isDev && targetUrl.startsWith('file://');
    if (!allowedDev && !allowedFile) {
      event.preventDefault();
      if (isAllowedExternalUrl(targetUrl)) {
        shell.openExternal(targetUrl);
      }
    }
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Binary IPC: Open PDF (async, size-bounded, native Uint8Array transfer)
ipcMain.handle('dialog:openPdf', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Ouvrir un document PDF — F',
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

// Binary IPC: Save PDF (sanitized defaultName, validated Uint8Array, async write)
ipcMain.handle('dialog:savePdf', async (_event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { saved: false };
  if (!payload || !(payload.bytes instanceof Uint8Array)) {
    throw new Error('Données PDF invalides.');
  }
  if (payload.bytes.byteLength === 0 || payload.bytes.byteLength > MAX_PDF_BYTES) {
    throw new Error('Taille du document PDF hors limites.');
  }
  const safeBase = path.basename(String(payload.defaultName || 'document.pdf')).replace(/[<>:"/\\|?*]/g, '_');
  const defaultPath = safeBase.toLowerCase().endsWith('.pdf') ? safeBase : `${safeBase}.pdf`;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Enregistrer le document PDF — F',
    defaultPath,
    filters: [{ name: 'Document PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { saved: false };

  await fs.writeFile(result.filePath, Buffer.from(payload.bytes));
  return { saved: true, filePath: path.basename(result.filePath) };
});

ipcMain.handle('shell:openExternal', async (_event, url) => {
  if (typeof url === 'string' && isAllowedExternalUrl(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

// Yousign DPAPI encrypted config + Main-process API v3 proxy (no CORS, key never exposed to renderer)
ipcMain.handle('yousign:getConfig', async () => {
  const cfg = await readYousignSecretConfig();
  return { env: cfg.env, hasApiKey: Boolean(cfg.apiKey) };
});

ipcMain.handle('yousign:saveConfig', async (_event, incoming) => {
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

ipcMain.handle('yousign:send', async (_event, req) => {
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

  const baseUrl = getYousignBaseUrl(cfg.env);
  const authHeaders = { Authorization: `Bearer ${cfg.apiKey}` };

  const createRes = await fetch(`${baseUrl}/signature_requests`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: String(req.requestName || 'Document F'),
      delivery_mode: req.deliveryMode === 'none' ? 'none' : 'email',
      timezone: 'Europe/Paris',
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Yousign : échec création de demande (HTTP ${createRes.status}).`);
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
    body: formData,
  });
  if (!docRes.ok) {
    throw new Error(`Yousign : échec téléversement PDF (HTTP ${docRes.status}).`);
  }
  const doc = await docRes.json();

  for (const signer of req.signers || []) {
    const needsOtp =
      signer.signatureLevel === 'advanced_electronic_signature' ||
      signer.signatureLevel === 'qualified_electronic_signature';
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
          x: Math.round(Number(signer.x) || 75),
          y: Math.round(Number(signer.y) || 620),
          width: Math.max(60, Math.round(Number(signer.width) || 200)),
          height: Math.max(30, Math.round(Number(signer.height) || 60)),
        },
      ],
    };
    const sRes = await fetch(`${baseUrl}/signature_requests/${encodeURIComponent(sr.id)}/signers`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(signerPayload),
    });
    if (!sRes.ok) {
      throw new Error(`Yousign : échec ajout signataire ${signer.email} (HTTP ${sRes.status}).`);
    }
  }

  const actRes = await fetch(`${baseUrl}/signature_requests/${encodeURIComponent(sr.id)}/activate`, {
    method: 'POST',
    headers: authHeaders,
  });
  if (!actRes.ok) {
    throw new Error(`Yousign : échec activation de la demande (HTTP ${actRes.status}).`);
  }
  const activated = await actRes.json();

  return {
    id: activated.id || sr.id,
    name: String(req.requestName || 'Document F'),
    env: cfg.env,
    status: activated.status || 'ongoing',
    createdAt: new Date().toISOString(),
    documentId: doc.id,
    signers: (req.signers || []).map((s, idx) => ({
      name: `${s.firstName} ${s.lastName}`.trim(),
      email: s.email,
      status: activated.signers?.[idx]?.status || 'notified',
      signatureLink: activated.signers?.[idx]?.signature_link,
    })),
  };
});

ipcMain.handle('yousign:status', async (_event, record) => {
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
    { headers: { Authorization: `Bearer ${cfg.apiKey}` } }
  );
  if (!res.ok) {
    throw new Error(`Impossible de rafraîchir le statut (HTTP ${res.status}).`);
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

ipcMain.handle('yousign:download', async (_event, record) => {
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
    { headers: { Authorization: `Bearer ${cfg.apiKey}` } }
  );
  if (!res.ok) {
    throw new Error(`Téléchargement PDF signé impossible (HTTP ${res.status}).`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
});

app.whenReady().then(() => {
  // Enforce CSP headers in Electron session
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp =
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: data: https://cdn.jsdelivr.net https://tessdata.projectnaptha.com; frame-src 'self' blob:; object-src 'none'; base-uri 'self';";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
