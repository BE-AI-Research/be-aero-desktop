// Web access for the assistant without an API key: a search that returns
// parsed results (DuckDuckGo's HTML endpoint - no key, no JavaScript), and a
// page fetcher that reduces HTML to readable text.
const MAX_TEXT = 20000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BE-Aero-Desktop/1.0';

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k]));
}

// HTML -> plain text: drop scripts/styles/nav chrome, keep block boundaries.
function htmlToText(html) {
  let h = String(html || '');
  h = h.replace(/<head[\s\S]*?<\/head>/gi, ' ').replace(/<title[\s\S]*?<\/title>/gi, ' ');
  h = h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|footer|aside|header)[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n');
  h = h.replace(/<[^>]+>/g, ' ');
  h = decodeEntities(h);
  return h.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

// DuckDuckGo "html" results page -> [{ title, url, snippet }].
function parseDuckDuckGo(html) {
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 20) {
    let url = decodeEntities(m[1]);
    // DDG wraps targets in a redirect: /l/?uddg=<encoded>&rut=...
    const udd = /[?&]uddg=([^&]+)/.exec(url);
    if (udd) { try { url = decodeURIComponent(udd[1]); } catch { /* keep as is */ } }
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//i.test(url)) continue;
    const title = htmlToText(m[2]);
    const snippet = htmlToText(m[3] || m[4] || '');
    if (title) out.push({ title, url, snippet });
  }
  return out;
}

async function webSearch(query, { count = 8, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((u, o) => fetch(u, o));
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await doFetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: controller.signal });
    if (!res.ok) return { error: `search returned ${res.status}` };
    const results = parseDuckDuckGo(await res.text()).slice(0, Math.max(1, Math.min(20, count)));
    return { query, results };
  } catch (err) {
    return { error: err && err.name === 'AbortError' ? 'search timed out' : String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPage(url, { fetchImpl, maxChars = MAX_TEXT } = {}) {
  if (!/^https?:\/\//i.test(url)) return { error: 'http(s) URLs only' };
  const doFetch = fetchImpl || ((u, o) => fetch(u, o));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await doFetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' }, signal: controller.signal, redirect: 'follow' });
    const type = res.headers.get('content-type') || '';
    if (!res.ok) return { error: `${res.status} ${res.statusText}`, url: res.url || url };
    if (!/text\/|json|xml/i.test(type)) return { error: `not a text page (${type.split(';')[0]})`, url: res.url || url };
    const body = await res.text();
    const text = /html/i.test(type) ? htmlToText(body) : body;
    return {
      url: res.url || url, title: /html/i.test(type) ? titleOf(body) : '',
      text: text.length > maxChars ? text.slice(0, maxChars) + `\n... (${text.length - maxChars} more characters)` : text
    };
  } catch (err) {
    return { error: err && err.name === 'AbortError' ? 'fetch timed out' : String(err && err.message || err), url };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { webSearch, fetchPage, parseDuckDuckGo, htmlToText, decodeEntities, titleOf };
