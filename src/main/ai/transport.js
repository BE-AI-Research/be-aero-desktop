// fetch() over a Unix domain socket, for inference servers that listen on
// one: a running BE-Code session serves its Application API at
// ~/.be-code/api/api.sock (same-machine, no TCP port, mode 0600). Returns
// the subset of the Response interface the OpenAI adapter uses.
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

// "unix:///home/u/.be-code/api/api.sock" or "unix://~/.be-code/api/api.sock"
// -> the socket path; anything else -> null.
function parseUnixBase(baseUrl) {
  const m = /^unix:\/\/(.+)$/i.exec(String(baseUrl || '').trim());
  if (!m) return null;
  let p = m[1].replace(/\/+$/, '');
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return p;
}

function defaultBeCodeSocket() {
  return path.join(os.homedir(), '.be-code', 'api', 'api.sock');
}

function socketFetch(socketPath, urlPath, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method, headers }, (res) => {
      const status = res.statusCode || 0;
      let cached = null;
      const text = () => cached || (cached = new Promise((ok, bad) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
        res.on('error', bad);
      }));
      resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: res.statusMessage || '',
        headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : (v === undefined ? null : v); } },
        text,
        json: () => text().then((t) => JSON.parse(t)),
        body: Readable.toWeb(res)
      });
    });
    req.on('error', (err) => reject(Object.assign(new Error(`fetch failed: ${err.message}`), { cause: err })));
    if (signal) {
      if (signal.aborted) { req.destroy(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
      signal.addEventListener('abort', () => { req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
    }
    if (body !== undefined) req.write(body);
    req.end();
  });
}

module.exports = { parseUnixBase, defaultBeCodeSocket, socketFetch };
