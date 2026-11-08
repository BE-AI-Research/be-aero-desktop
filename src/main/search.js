// Search engine for the Spotlight-style launcher.
// Concepts (categories, typo-tolerant edit distance, launch-frequency boost)
// are inspired by HorusSearch; this is an original JavaScript implementation.
const path = require('path');

// Category order mirrors the result grouping in the launcher UI.
const CATEGORIES = [
  ['APPLICATIONS', ['.lnk', '.exe', '.url', '.appref-ms']],
  ['SETTINGS', []],
  ['DOCUMENTS', ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.rtf', '.odt', '.csv', '.psd', '.ai']],
  ['IMAGES', ['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tiff', '.ico', '.svg', '.heic']],
  ['MUSIC', ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.mid', '.midi', '.aiff']],
  ['VIDEOS', ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.flv', '.m4v', '.3gp']],
  ['DEVELOPER', ['.js', '.ts', '.jsx', '.tsx', '.json', '.html', '.htm', '.css', '.cs', '.cpp', '.c', '.h', '.py', '.rb', '.go', '.rs', '.java', '.php', '.sh', '.ps1', '.bat', '.cmd', '.xml', '.yml', '.yaml', '.sln', '.csproj']],
  ['ARCHIVES', ['.zip', '.rar', '.7z', '.tar', '.gz', '.iso']],
  ['FOLDERS', []],
  ['OTHER', []]
];
const CATEGORY_ORDER = CATEGORIES.map(([name]) => name);
const EXT_TO_CATEGORY = new Map();
for (const [name, exts] of CATEGORIES) for (const e of exts) EXT_TO_CATEGORY.set(e, name);

function categorize(entry) {
  if (entry.kind === 'setting') return 'SETTINGS';
  if (entry.kind === 'app') return 'APPLICATIONS';
  if (entry.kind === 'folder') return 'FOLDERS';
  return EXT_TO_CATEGORY.get(path.extname(entry.path || entry.name).toLowerCase()) || 'OTHER';
}

// Classic two-row Levenshtein distance.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function normalize(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function tokenize(s) {
  return normalize(s).split(/[\s._\-()[\],]+/).filter(Boolean);
}

// Score how well one query term matches a name. 0 = no match.
function termScore(term, nameNorm, words) {
  if (nameNorm === term) return 100;
  if (nameNorm.startsWith(term)) return 80;
  if (words.some((w) => w.startsWith(term))) return 65;
  // Acronym match: "vsc" -> "Visual Studio Code"
  if (term.length >= 2 && words.length >= term.length &&
      words.map((w) => w[0]).join('').startsWith(term)) return 60;
  if (nameNorm.includes(term)) return 45;
  // Typo tolerance on whole words (only for terms long enough to be meaningful)
  if (term.length >= 4) {
    const maxDist = term.length >= 7 ? 2 : 1;
    for (const w of words) {
      const d = levenshtein(term, w.slice(0, term.length + 1));
      if (d <= maxDist) return 35 - d * 8;
    }
  }
  // In-order subsequence: "dwnlds" -> "downloads"
  let i = 0;
  for (const ch of nameNorm) if (ch === term[i]) i++;
  if (i === term.length && term.length >= 3) return 15;
  return 0;
}

function scoreEntry(query, entry, launchCounts) {
  const terms = tokenize(query);
  if (!terms.length) return 0;
  const nameNorm = entry._norm || (entry._norm = normalize(entry.name));
  const words = entry._words || (entry._words = tokenize(entry.name));
  let total = 0;
  for (const t of terms) {
    const s = termScore(t, nameNorm, words);
    if (!s) return 0; // every term must match something
    total += s;
  }
  total /= terms.length;
  // Prefer shorter names (closer to the query) and applications.
  total += Math.max(0, 10 - Math.abs(nameNorm.length - normalize(query).length) / 3);
  if (entry.kind === 'app') total += 20;
  else if (entry.kind === 'setting') total += 8;
  else if (entry.kind === 'folder') total += 2;
  // Frequently launched items float to the top.
  const uses = (launchCounts && launchCounts[entry.path]) || 0;
  if (uses) total += Math.min(30, 8 * Math.log2(1 + uses));
  return total;
}

// Returns grouped results: [{ category, items: [entry+score] }] plus a flat top hit.
function search(query, entries, { limit = 40, perCategory = 8, launchCounts = {} } = {}) {
  const q = query.trim();
  if (!q) return { top: null, groups: [], total: 0 };
  const scored = [];
  for (const e of entries) {
    const s = scoreEntry(q, e, launchCounts);
    if (s > 0) scored.push({ entry: e, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length);

  const seen = new Set();
  const byCat = new Map();
  let count = 0;
  for (const { entry, score } of scored) {
    if (count >= limit) break;
    const key = (entry.kind === 'app' ? entry.name : entry.path).toLowerCase();
    if (seen.has(key)) continue; // same app in user + common Start Menu
    seen.add(key);
    const cat = categorize(entry);
    const list = byCat.get(cat) || [];
    if (list.length >= perCategory) continue;
    list.push({ name: entry.name, path: entry.path, kind: entry.kind, target: entry.target, category: cat, score: Math.round(score) });
    byCat.set(cat, list);
    count++;
  }
  const top = scored.length ? byCat.get(categorize(scored[0].entry))[0] : null;
  const groups = [];
  // Top hit's category first (like Spotlight), then the fixed order.
  if (top) groups.push({ category: top.category, items: byCat.get(top.category) });
  for (const cat of CATEGORY_ORDER) {
    if (top && cat === top.category) continue;
    if (byCat.has(cat)) groups.push({ category: cat, items: byCat.get(cat) });
  }
  return { top, groups, total: scored.length };
}

// ------------------------------------------------------------ calculator
// Safe arithmetic parser (no eval): + - * / % ^, parentheses, unary minus,
// and a few functions/constants.
const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, exp: Math.exp
};
const CONSTS = { pi: Math.PI, e: Math.E };

function calculate(input) {
  const src = input.replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '');
  if (!src || !/[\d)]/.test(src) || !/^[\d.+\-*/%^()a-z]+$/i.test(src)) return null;
  if (!/[+\-*/%^(]/.test(src.replace(/^-/, '')) && !/^[a-z]/i.test(src)) return null; // bare number
  let pos = 0;
  const peek = () => src[pos];
  const eat = (c) => (src[pos] === c ? (pos++, true) : false);

  function number() {
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(pos));
    if (m) { pos += m[0].length; return parseFloat(m[0]); }
    const id = /^[a-z]+/i.exec(src.slice(pos));
    if (id) {
      const name = id[0].toLowerCase();
      pos += id[0].length;
      if (name in CONSTS) return CONSTS[name];
      if (name in FUNCS) {
        if (!eat('(')) throw new Error('expected (');
        const v = expr();
        if (!eat(')')) throw new Error('expected )');
        return FUNCS[name](v);
      }
    }
    throw new Error('unexpected token');
  }
  function primary() {
    if (eat('(')) { const v = expr(); if (!eat(')')) throw new Error('expected )'); return v; }
    if (eat('-')) return -primary();
    if (eat('+')) return primary();
    return number();
  }
  function power() {
    let v = primary();
    while (peek() === '%' && !/[\d.(a-z]/i.test(src[pos + 1] || '')) { pos++; v /= 100; } // postfix percent
    if (eat('^')) v = Math.pow(v, power());
    return v;
  }
  function term() {
    let v = power();
    for (;;) {
      if (eat('*')) v *= power();
      else if (eat('/')) v /= power();
      else if (peek() === '%' && /[\d.(a-z]/i.test(src[pos + 1] || '')) { pos++; v %= power(); }
      else return v;
    }
  }
  function expr() {
    let v = term();
    for (;;) {
      if (eat('+')) v += term();
      else if (eat('-')) v -= term();
      else return v;
    }
  }
  try {
    const v = expr();
    if (pos !== src.length || !Number.isFinite(v)) return null;
    return Math.round(v * 1e10) / 1e10;
  } catch {
    return null;
  }
}

module.exports = { search, scoreEntry, categorize, levenshtein, calculate, tokenize, CATEGORY_ORDER };
