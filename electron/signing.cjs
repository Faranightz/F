// Digital signature with a certificate (.pfx / .p12), done in the main process:
// the certificate file and its private key never reach the user interface.
// Signature format: PKCS#7 detached (adbe.pkcs7.detached), read by Acrobat, Foxit and others.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const { PDFDocument } = require('pdf-lib');
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const signpdf = require('@signpdf/signpdf').default;
const { P12Signer } = require('@signpdf/signer-p12');

const MAX_PFX_BYTES = 1024 * 1024;
const certificates = new Map(); // id -> absolute path chosen by the user

function rememberCertificate(filePath) {
  const id = crypto.randomUUID();
  certificates.set(id, filePath);
  return { id, fileName: path.basename(filePath) };
}

async function readCertificate(id) {
  const filePath = certificates.get(id);
  if (!filePath) throw new Error('Certificat introuvable. Choisissez-le de nouveau.');
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_PFX_BYTES) throw new Error('Fichier de certificat trop volumineux.');
  return fs.readFile(filePath);
}

function attr(cert, shortName) {
  const a = cert.subject.getField(shortName);
  return a ? String(a.value) : '';
}

/** Opens the .pfx with its password and returns public information only. */
async function inspectCertificate(id, password) {
  const bytes = await readCertificate(id);
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(bytes.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, String(password ?? ''));
  } catch {
    throw new Error('Mot de passe du certificat incorrect, ou fichier invalide.');
  }
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
  if (!certBags.length || !keyBags.length) {
    throw new Error('Ce fichier ne contient pas de certificat avec sa clé privée.');
  }
  // The signing certificate is the one matching the private key
  const key = keyBags[0].key;
  const cert =
    certBags.map((b) => b.cert).find((c) => c && c.publicKey && key && c.publicKey.n && key.n && c.publicKey.n.equals(key.n)) ||
    certBags[0].cert;
  const now = new Date();
  return {
    name: attr(cert, 'CN') || 'Signataire',
    organization: attr(cert, 'O'),
    email: attr(cert, 'E') || attr(cert, 'emailAddress'),
    issuer: cert.issuer.getField('CN') ? String(cert.issuer.getField('CN').value) : '',
    selfSigned: cert.isIssuer(cert),
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    valid: now >= cert.validity.notBefore && now <= cert.validity.notAfter,
  };
}

/**
 * Signs the PDF. `rect` = [x1, y1, x2, y2] of the visible signature on page `pageIndex`
 * (raw PDF coordinates), or null for an invisible signature.
 */
async function signPdf({ id, password, pdfBytes, reason, location, contact, pageIndex, rect }) {
  const info = await inspectCertificate(id, password);
  if (!info.valid) throw new Error('Ce certificat est expiré ou pas encore valide.');
  const p12 = await readCertificate(id);
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();
  const page = pages[Math.min(Math.max(0, Number(pageIndex) || 0), pages.length - 1)];
  const widgetRect =
    Array.isArray(rect) && rect.length === 4 && rect.every((n) => Number.isFinite(n)) ? rect.map(Number) : [0, 0, 0, 0];
  pdflibAddPlaceholder({
    pdfPage: page,
    reason: String(reason || 'Signature du document'),
    contactInfo: String(contact || info.email || ''),
    name: info.name,
    location: String(location || ''),
    signatureLength: 16384,
    widgetRect,
    appName: 'F-pdf',
  });
  const withPlaceholder = await doc.save({ useObjectStreams: false });
  const signer = new P12Signer(p12, { passphrase: String(password ?? '') });
  const signed = await signpdf.sign(Buffer.from(withPlaceholder), signer);
  return { bytes: new Uint8Array(signed), signerName: info.name };
}

/** Creates a personal (self-signed) digital ID, like Foxit/Acrobat "Create a digital ID". */
function createSelfSignedP12({ name, email, organization, password }) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + crypto.randomBytes(15).toString('hex');
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 60 * 1000);
  cert.validity.notAfter = new Date(now);
  cert.validity.notAfter.setFullYear(now.getFullYear() + 3);
  const attrs = [{ name: 'commonName', value: name }];
  if (organization) attrs.push({ name: 'organizationName', value: organization });
  if (email) attrs.push({ name: 'emailAddress', value: email });
  attrs.push({ name: 'countryName', value: 'FR' });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, {
    algorithm: '3des', // readable by Windows and Acrobat
    friendlyName: name,
  });
  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}

module.exports = { rememberCertificate, inspectCertificate, signPdf, createSelfSignedP12 };
