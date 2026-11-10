// How models actually call tools, after BE-Code (internal/profiles,
// agent/prompt.go, agent/xmlcalls.go, agent/think.go, tools.ParseArgs).
//
// Local models are loose about formats. A tool call can arrive as:
//   - native OpenAI tool_calls (JSON arguments, sometimes double-encoded)
//   - <tool_call>{"name": ..., "arguments": {...}}</tool_call>   (Hermes / Qwen 2.5 / our compat prompt)
//   - ```json {"name": ...} ```                                     (fenced)
//   - <tool_call><function=NAME><parameter=KEY>value</parameter></function></tool_call>
//                                                                   (Qwen3-Coder / Qwen3.5+ chat templates)
//   - <|python_tag|>{"name": ..., "parameters": {...}}  or a bare {"name":..,"parameters":..} reply (Llama 3.x)
//   - [TOOL_CALLS] [{"name": ..., "arguments": {...}}]              (Mistral)
//   - ```tool_code\nname(key="value", n=3)\n```                     (Gemma)
// and reasoning models wrap thinking in <think>/<thought>/<thinking> (or send
// it in a separate `reasoning` field). This module recognises all of them so
// a tool call is never mistaken for a final answer, and keeps reasoning out
// of the transcript. Pure functions; no I/O.

// ------------------------------------------------------------------ profiles
// compat: 'auto' (native first, embedded calls parsed too, switch to embedded
// if the server rejects tools), 'always' (embedded prompt only - families with
// no or broken native tool training), 'never' (vendors with solid native calls).
const PROFILES = [
  ['qwen3', false, { family: 'qwen3', compat: 'auto', stripThink: true, notes: 'reasoning tags stripped; XML tool calls accepted' }],
  ['qwen', false, { family: 'qwen', compat: 'auto', stripThink: false }],
  ['deepseek-v3', true, { family: 'deepseek-v3', compat: 'never' }],
  ['deepseek-chat', true, { family: 'deepseek-chat', compat: 'never' }],
  ['o3', true, { family: 'o3', compat: 'never' }],
  ['o4', true, { family: 'o4', compat: 'never' }],
  ['gpt-', true, { family: 'gpt', compat: 'never' }],
  ['claude', true, { family: 'claude', compat: 'never' }],
  ['gemini', true, { family: 'gemini', compat: 'never' }],
  ['deepseek-r1', false, { family: 'deepseek-r1', compat: 'always', stripThink: true }],
  ['deepseek', false, { family: 'deepseek', compat: 'auto' }],
  ['gemma', false, { family: 'gemma', compat: 'always' }],
  ['functiongemma', false, { family: 'functiongemma', compat: 'auto' }],
  ['llama', false, { family: 'llama', compat: 'auto' }],
  ['mistral', false, { family: 'mistral', compat: 'auto' }],
  ['codestral', false, { family: 'codestral', compat: 'auto' }],
  ['phi', false, { family: 'phi', compat: 'always' }],
  ['granite', false, { family: 'granite', compat: 'auto' }],
  ['starcoder', false, { family: 'starcoder', compat: 'always' }],
  ['codellama', false, { family: 'codellama', compat: 'always' }],
  ['gpt-oss', false, { family: 'gpt-oss', compat: 'auto', stripThink: true }]
];
const DEFAULT_PROFILE = { family: 'generic', compat: 'auto', stripThink: false };

// Longest matching substring wins ("deepseek-r1:..-qwen-distill" -> deepseek-r1,
// "codellama" beats "llama"); anchored rows match only at the start or after '/'.
function profileFor(model) {
  const m = String(model || '').toLowerCase();
  let best = DEFAULT_PROFILE;
  let bestLen = 0;
  for (const [match, anchored, p] of PROFILES) {
    let idx = m.indexOf(match);
    let found = false;
    while (idx >= 0) {
      if (!anchored || idx === 0 || m[idx - 1] === '/') { found = true; break; }
      idx = m.indexOf(match, idx + 1);
    }
    if (found && match.length > bestLen) { best = p; bestLen = match.length; }
  }
  return { ...DEFAULT_PROFILE, ...best };
}

// ------------------------------------------------------------------ thinking
const THINK_BLOCK = /<(think|thought|thinking)>[\s\S]*?<\/(think|thought|thinking)>\s*/g;
const OPEN_TAGS = ['<think>', '<thought>', '<thinking>'];
const CLOSE_TAGS = ['</think>', '</thought>', '</thinking>'];

// Complete reasoning blocks, plus an unterminated trailing one (cut off mid-thought).
function stripThink(s) {
  let out = String(s || '').replace(THINK_BLOCK, '');
  for (const tag of OPEN_TAGS) {
    const i = out.indexOf(tag);
    if (i >= 0 && !out.slice(i).includes('</')) out = out.slice(0, i);
  }
  // A reply that *starts* with the close tag (the template opened <think> for it).
  out = out.replace(/^[\s\S]*?<\/think>\s*/, (m) => (m.includes('<think>') ? m : ''));
  return out.trim();
}

function findFirst(s, tags) {
  let best = -1;
  let bestTag = '';
  for (const t of tags) {
    const i = s.indexOf(t);
    if (i >= 0 && (best < 0 || i < best)) { best = i; bestTag = t; }
  }
  return [best, bestTag];
}
function holdback(s, tags) {
  let max = 0;
  for (const t of tags) {
    for (let n = t.length - 1; n > 0; n--) {
      if (n <= s.length && s.endsWith(t.slice(0, n))) { if (n > max) max = n; break; }
    }
  }
  return max;
}

// Streaming filter: drops <think> blocks from deltas as they arrive, holding
// back only a partial tag that straddles a chunk boundary.
class ThinkFilter {
  constructor() { this.inThink = false; this.pending = ''; this.thought = 0; }
  feed(delta) {
    let s = this.pending + String(delta || '');
    this.pending = '';
    let out = '';
    while (s) {
      if (this.inThink) {
        const [idx, tag] = findFirst(s, CLOSE_TAGS);
        if (idx < 0) {
          const hb = holdback(s, CLOSE_TAGS);
          this.thought += s.length - hb;
          if (hb) this.pending = s.slice(s.length - hb);
          return out;
        }
        this.thought += idx;
        s = s.slice(idx + tag.length);
        this.inThink = false;
        continue;
      }
      const [idx, tag] = findFirst(s, OPEN_TAGS);
      if (idx < 0) {
        const hb = holdback(s, OPEN_TAGS);
        out += s.slice(0, s.length - hb);
        this.pending = s.slice(s.length - hb);
        return out;
      }
      out += s.slice(0, idx);
      s = s.slice(idx + tag.length);
      this.inThink = true;
    }
    return out;
  }
  flush() {
    if (this.inThink) { this.pending = ''; return ''; }
    const p = this.pending;
    this.pending = '';
    return p;
  }
}

// ------------------------------------------------------------------ arguments
// Tool-call arguments with BE-Code's tolerance: empty/"null" -> {}, an
// object passes through, a JSON string holding an object is unwrapped
// (double-encoded), trailing commas and single-quoted keys are forgiven.
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return Array.isArray(raw) ? null : raw;
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === 'null') return {};
  const tryJson = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
  let v = tryJson(s);
  if (typeof v === 'string') v = tryJson(v.trim());
  if (v === undefined) v = tryJson(s.replace(/,\s*([}\]])/g, '$1'));
  if (v === undefined && /^\{/.test(s)) v = tryJson(s.replace(/'([^'\n]*)'\s*:/g, '"$1":').replace(/:\s*'([^'\n]*)'/g, ': "$1"').replace(/,\s*([}\]])/g, '$1'));
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

// JSON-schema types of each tool's parameters: (tool, param) -> 'string' | 'integer' | ...
function paramTypes(defs) {
  const map = new Map();
  for (const d of defs || []) {
    const props = (d.input_schema && d.input_schema.properties) || {};
    for (const [k, p] of Object.entries(props)) if (p && typeof p.type === 'string') map.set(`${d.name}\u0000${k}`, p.type);
  }
  return (tool, param) => map.get(`${tool}\u0000${param}`) || '';
}

// Text value -> the schema's type (only when it really is that JSON).
function typedValue(text, type) {
  if (['integer', 'number', 'boolean', 'array', 'object'].includes(type)) {
    try { return JSON.parse(String(text).trim()); } catch { /* keep text */ }
  }
  return text;
}

// ------------------------------------------------------------------ embedded calls
const TAG_CALL = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
const FENCE_CALL = /```(?:json|tool_call)?\s*(\{[\s\S]*?\})\s*```/g;
const XML_CALL = /(?:<tool_call>\s*)?<function=([^>\s]+)\s*>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/g;
const XML_PARAM = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g;
const MISTRAL = /\[TOOL_CALLS\]\s*(\[[\s\S]*\])/;
const PYTHON_TAG = /<\|python_tag\|>\s*(\{[\s\S]*\})/;
const TOOL_CODE = /```tool_code\s*\n?([\s\S]*?)```/g;

// One parsed JSON call object -> { name, input } (field-name variants accepted).
function fromJsonCall(obj, known) {
  if (!obj || typeof obj !== 'object') return null;
  const fn = obj.function && typeof obj.function === 'object' ? obj.function : null;
  const name = obj.name || obj.tool || obj.tool_name || (fn && fn.name);
  if (!name || !known.has(name)) return null;
  const raw = obj.arguments !== undefined ? obj.arguments : obj.parameters !== undefined ? obj.parameters
    : obj.input !== undefined ? obj.input : obj.args !== undefined ? obj.args : fn && fn.arguments;
  const input = parseArgs(raw === undefined ? {} : raw);
  return input ? { name, input } : null;
}

// Python-style call: name(key="v", n=3, flag=True, items=["a"])
function fromPythonCall(src, known, typeOf) {
  const m = /^\s*(?:print\()?\s*([A-Za-z_][\w]*)\s*\(([\s\S]*)\)\s*\)?\s*$/.exec(src.trim());
  if (!m || !known.has(m[1])) return null;
  const input = {};
  const argRe = /([A-Za-z_]\w*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[[^\]]*\]|\{[^}]*\}|[^,]+)/g;
  let a;
  while ((a = argRe.exec(m[2]))) {
    let v = a[2].trim();
    if (/^'/.test(v)) v = JSON.stringify(v.slice(1, -1).replace(/\\'/g, "'"));
    v = v.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
    let parsed;
    try { parsed = JSON.parse(v); } catch { parsed = v; }
    input[a[1]] = typeof parsed === 'string' ? typedValue(parsed, typeOf(m[1], a[1])) : parsed;
  }
  return { name: m[1], input };
}

// Take the layout's framing newline off a parameter value, no more.
function unframe(v) {
  return v.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

// content -> { text, calls: [{ id, name, input }] }. Calls to unknown tools
// are left in the text. Tries the forms in order of specificity.
function parseEmbeddedCalls(content, defs, startId = 0) {
  const known = new Set((defs || []).map((d) => d.name));
  const typeOf = paramTypes(defs);
  let text = String(content || '');
  const calls = [];
  const push = (c) => { calls.push({ id: `embedded_${startId + calls.length}`, name: c.name, input: c.input }); };
  const scan = (re, fn) => {
    re.lastIndex = 0;
    const found = [...text.matchAll(re)];
    for (const m of found) {
      const c = fn(m);
      if (c) { push(c); text = text.replace(m[0], ''); }
    }
  };
  // Qwen XML first: its <function= ...> inside <tool_call> would otherwise
  // be mistaken for a malformed JSON body.
  scan(XML_CALL, (m) => {
    const name = m[1].trim();
    if (!known.has(name)) return null;
    const input = {};
    for (const p of m[2].matchAll(XML_PARAM)) input[p[1].trim()] = typedValue(unframe(p[2]), typeOf(name, p[1].trim()));
    return { name, input };
  });
  if (!calls.length) scan(TAG_CALL, (m) => fromJsonCall(parseArgs(m[1]), known));
  if (!calls.length) {
    const mm = MISTRAL.exec(text);
    if (mm) {
      let arr = null;
      try { arr = JSON.parse(mm[1]); } catch { arr = null; }
      if (Array.isArray(arr)) {
        const got = arr.map((o) => fromJsonCall(o, known)).filter(Boolean);
        if (got.length) { got.forEach(push); text = text.replace(mm[0], ''); }
      }
    }
  }
  if (!calls.length) {
    const pm = PYTHON_TAG.exec(text);
    if (pm) { const c = fromJsonCall(parseArgs(pm[1]), known); if (c) { push(c); text = text.replace(pm[0], ''); } }
  }
  if (!calls.length) scan(TOOL_CODE, (m) => fromPythonCall(m[1], known, typeOf));
  if (!calls.length) scan(FENCE_CALL, (m) => fromJsonCall(parseArgs(m[1]), known));
  if (!calls.length) {
    // A reply that is nothing but one JSON call object (Llama 3.x without the tag).
    const t = text.trim();
    if (/^\{[\s\S]*\}$/.test(t)) {
      const c = fromJsonCall(parseArgs(t), known);
      if (c) { push(c); text = ''; }
    }
  }
  return { text: text.replace(/<\/?tool_call>/g, '').trim(), calls };
}

// The reply ends inside a call that never closes (output limit hit mid-call).
function openEmbeddedCall(content) {
  const s = String(content || '');
  for (const [open, close] of [['<tool_call>', '</tool_call>'], ['<function=', '</function>']]) {
    const i = s.lastIndexOf(open);
    if (i >= 0 && !s.slice(i).includes(close)) return true;
  }
  return false;
}

// Some servers reject the tools field outright.
function looksLikeToolsUnsupported(err) {
  const s = String(err && err.message || err || '').toLowerCase();
  if (s.includes('thought_signature')) return false;
  return s.includes('tool') && (s.includes('not support') || s.includes('unsupported') || s.includes('invalid') || s.includes('unknown field') || s.includes('does not support'));
}

// The embedded-format instructions appended to the system prompt.
function compatInstructions(defs) {
  const list = (defs || []).map((d) => `- ${d.name}: ${d.description} parameters: ${JSON.stringify(d.input_schema || {})}`).join('\n');
  return 'Tool calling format: to call a tool, output EXACTLY one block and nothing after it:\n'
    + '<tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>\n'
    + 'Each result comes back as:\n'
    + '<tool_result name="TOOL_NAME" status="ok">result text</tool_result>\n'
    + `Available tools:\n${list}\n`
    + 'When you are completely finished, reply with your answer and no tool_call block.';
}

// How a call / its result is written into the transcript in embedded mode.
function callAsText(c) { return `<tool_call>${JSON.stringify({ name: c.name, arguments: c.input || {} })}</tool_call>`; }
function resultAsText(r) {
  return `<tool_result name="${r.name}" status="${r.isError ? 'error' : 'ok'}">${String(r.content || '')}</tool_result>`;
}

module.exports = {
  profileFor, stripThink, ThinkFilter, parseArgs, paramTypes, parseEmbeddedCalls, openEmbeddedCall,
  looksLikeToolsUnsupported, compatInstructions, callAsText, resultAsText, PROFILES
};
