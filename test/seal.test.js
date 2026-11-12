const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadIdentity } = require('../src/main/mesh/identity');
const { seal, open } = require('../src/main/mesh/seal');

test('relay sealing: only the recipient opens it; forgery and tampering fail', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-seal-'));
  try {
    const a = loadIdentity(path.join(base, 'a'), { name: 'Desk' });
    const b = loadIdentity(path.join(base, 'b'), { name: 'Laptop' });
    const c = loadIdentity(path.join(base, 'c'), { name: 'Other' });
    const cert = (i) => i.certDer.toString('base64');
    const h = { from: a.id, to: b.id, kind: 'state', key: 'theme' };
    const env = seal(h, { preset: 'midnight' }, { senderKeyPem: a.keyPem, recipientCert: cert(b) });
    assert.ok(!env.toString().includes('midnight'), 'the relay sees no content');
    const got = open(env, { recipientKeyPem: b.keyPem, recipientId: b.id, senderCert: cert(a), expectFrom: a.id });
    assert.deepStrictEqual(got.data, { preset: 'midnight' });
    assert.deepStrictEqual(got.header, h);
    // someone else cannot open it
    assert.throws(() => open(env, { recipientKeyPem: c.keyPem, recipientId: c.id, senderCert: cert(a) }), /not addressed/);
    assert.throws(() => open(env, { recipientKeyPem: c.keyPem, senderCert: cert(a) }));
    // a different sender cannot pass it off as A's
    const forged = seal(h, { preset: 'evil' }, { senderKeyPem: c.keyPem, recipientCert: cert(b) });
    assert.throws(() => open(forged, { recipientKeyPem: b.keyPem, recipientId: b.id, senderCert: cert(a) }), /bad signature/);
    // tampering with the header or the body fails
    const e = JSON.parse(env.toString());
    assert.throws(() => open(Buffer.from(JSON.stringify({ ...e, key: 'scratchpad' })), { recipientKeyPem: b.keyPem, senderCert: cert(a) }), /bad signature/);
    const ct = Buffer.from(e.ct, 'base64'); ct[0] ^= 1;
    assert.throws(() => open(Buffer.from(JSON.stringify({ ...e, ct: ct.toString('base64') })), { recipientKeyPem: b.keyPem, senderCert: cert(a) }), /bad signature/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
