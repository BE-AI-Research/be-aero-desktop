// End-to-end sealing for messages that travel through the BE-Aero Relay
// Server: only the recipient can open them, and it can tell who sent them.
//
//   seal: an ephemeral P-256 key + the recipient's device key (from its
//         certificate) -> ECDH -> HKDF-SHA256 -> AES-256-GCM. The sender
//         signs (header, ephemeral key, iv, ciphertext, tag) with its own
//         device key. The header (from, to, kind, key) is bound into the
//         AEAD as associated data, so it cannot be swapped.
//   open: check the signature with the sender's certificate, then decrypt.
// The relay sees only the envelope: who to, who from, kind, size.
const crypto = require('crypto');

const VERSION = 1;
const INFO = Buffer.from('be-aero relay seal v1');

function publicKeyOfCert(certB64OrPem) {
  const s = String(certB64OrPem || '');
  const x = /BEGIN CERTIFICATE/.test(s) ? new crypto.X509Certificate(s) : new crypto.X509Certificate(Buffer.from(s, 'base64'));
  return x.publicKey;
}

function aad(h) { return Buffer.from(JSON.stringify([VERSION, h.from, h.to, h.kind, h.key || ''])); }

// -> Buffer (the sealed envelope, JSON)
function seal({ from, to, kind, key = '' }, plaintext, { senderKeyPem, recipientCert }) {
  const recipient = publicKeyOfCert(recipientCert);
  const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const ephPub = eph.publicKey.export({ type: 'spki', format: 'der' });
  const k = Buffer.from(crypto.hkdfSync('sha256', shared, ephPub, INFO, 32));
  const iv = crypto.randomBytes(12);
  const header = { from, to, kind, key };
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(aad(header));
  const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(JSON.stringify(plaintext));
  const ct = Buffer.concat([c.update(body), c.final()]);
  const tag = c.getAuthTag();
  const signed = Buffer.concat([aad(header), ephPub, iv, ct, tag]);
  const sig = crypto.sign('sha256', signed, crypto.createPrivateKey(senderKeyPem));
  return Buffer.from(JSON.stringify({ v: VERSION, ...header, eph: ephPub.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64'), sig: sig.toString('base64') }));
}

// -> { header, data } ; throws when forged, altered or not for us.
function open(sealed, { recipientKeyPem, recipientId, senderCert, expectFrom }) {
  const e = JSON.parse(Buffer.isBuffer(sealed) ? sealed.toString('utf8') : String(sealed));
  if (!e || e.v !== VERSION) throw new Error('unknown envelope');
  if (recipientId && e.to !== recipientId) throw new Error('not addressed to this device');
  if (expectFrom && e.from !== expectFrom) throw new Error('sender mismatch');
  const header = { from: e.from, to: e.to, kind: e.kind, key: e.key || '' };
  const ephPub = Buffer.from(e.eph, 'base64');
  const iv = Buffer.from(e.iv, 'base64');
  const ct = Buffer.from(e.ct, 'base64');
  const tag = Buffer.from(e.tag, 'base64');
  const signed = Buffer.concat([aad(header), ephPub, iv, ct, tag]);
  if (!crypto.verify('sha256', signed, publicKeyOfCert(senderCert), Buffer.from(e.sig, 'base64'))) throw new Error('bad signature');
  const shared = crypto.diffieHellman({ privateKey: crypto.createPrivateKey(recipientKeyPem), publicKey: crypto.createPublicKey({ key: ephPub, format: 'der', type: 'spki' }) });
  const k = Buffer.from(crypto.hkdfSync('sha256', shared, ephPub, INFO, 32));
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
  d.setAAD(aad(header));
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ct), d.final()]);
  let data;
  try { data = JSON.parse(plain.toString('utf8')); } catch { data = plain; }
  return { header, data };
}

module.exports = { seal, open, publicKeyOfCert };
