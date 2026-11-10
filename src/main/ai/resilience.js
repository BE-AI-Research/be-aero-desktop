// Backend resilience, after BE-Code's rule that a local inference server is
// shared and fallible: it restarts, swaps models, queues for a minute, drops
// a stream halfway. None of that should cost the user their turn. The
// conversation state lives on disk, so a failed call is simply retried in
// place with exponential backoff; a rejected key or a malformed request is
// never retried.

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30 * 1000;

const RETRYABLE = /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed|socket hang up|network error|terminated|other side closed|premature close|timed? ?out|\bloading\b|unavailable|overloaded|try again|\bbusy\b|rate.?limit|\b(?:429|5\d\d)\b/i;
const AUTH = /\b(?:401|403)\b|invalid.*api.?key|authentication|unauthori[sz]ed|forbidden/i;

function isAbort(err) {
  return !!err && (err.name === 'AbortError' || /aborted|abort/i.test(String(err.message || '')));
}

// A rejected key never gets better by asking again.
function isAuthError(err) {
  if (!err) return false;
  if (err.status === 401 || err.status === 403) return true;
  return AUTH.test(String(err.message || ''));
}

// "The server is busy / restarting / loading a model" versus "this request
// is wrong". Typed HTTP status wins over text when present.
function isRetryable(err) {
  if (!err || isAbort(err) || isAuthError(err)) return false;
  const status = Number(err.status);
  if (status) {
    if (status === 408 || status === 429 || status >= 500) return true;
    if (status >= 400) return false;
  }
  return RETRYABLE.test(String(err.message || err));
}

function shortError(err) {
  let s = String(err && err.message || err || 'error');
  const nl = s.indexOf('\n');
  if (nl >= 0) s = s.slice(0, nl);
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// provider.chat(req) with retries. Streamed text that arrived before a
// failure is discarded by the caller on the 'retry' event; the server's
// Retry-After (seconds, on err.retryAfter) is honoured up to the cap.
async function chatWithRetry(provider, req, { emit, signal, maxRetries = MAX_RETRIES, baseDelay = BASE_DELAY_MS, maxDelay = MAX_DELAY_MS, wait = sleep } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await provider.chat(req);
    } catch (err) {
      lastErr = err;
      if ((signal && signal.aborted) || isAbort(err)) throw err;
      if (!isRetryable(err) || attempt === maxRetries) throw err;
      let delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
      if (Number(err.retryAfter) > 0) delay = Math.min(maxDelay, Number(err.retryAfter) * 1000);
      if (emit) emit({ type: 'retry', attempt: attempt + 1, max: maxRetries, delayMs: delay, message: shortError(err) });
      await wait(delay, signal);
    }
  }
  throw lastErr;
}

module.exports = { chatWithRetry, isRetryable, isAuthError, isAbort, shortError, sleep, MAX_RETRIES, BASE_DELAY_MS, MAX_DELAY_MS };
