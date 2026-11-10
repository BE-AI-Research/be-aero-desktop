// The context buffer: keeps one conversation's request inside a token budget
// the way BE-Code does for small local models. A ladder, cheapest first:
//   1. old tool results collapse to a stub (the conversation itself is kept),
//   2. the model summarizes the older part, which is then carried as a
//      compaction summary ahead of the newest exchanges,
//   3. plain trimming, only when there is nothing better.
// Pure functions over the provider-neutral message shape; persistence and
// the model call belong to the caller.

const DEFAULT_CHARS_PER_TOKEN = 3.6;
const MIN_CPT = 1.5;
const MAX_CPT = 8;
const IMAGE_TOKENS = 1500;          // one screenshot / image attachment
const STUB = '[old tool result removed to save context]';
const BIG_INPUT = 2000;             // tool-call arguments larger than this shrink
const KEEP_TAIL = 4;                // newest messages kept verbatim at compaction
const TRANSCRIPT_CAP = 24 * 1024;   // characters of transcript the summary sees

// Default budgets when the user has not set one: generous for hosted
// providers, cautious for local servers whose window is usually 8-32k.
const DEFAULT_BUDGETS = { anthropic: 150000, openai: 100000, local: 16000 };

function budgetFor(presetId, presetKind, configured, local) {
  const n = Number(configured);
  if (n > 0) return Math.max(2000, Math.floor(n));
  if (presetKind === 'anthropic') return DEFAULT_BUDGETS.anthropic;
  if (presetId === 'openai' && !local) return DEFAULT_BUDGETS.openai;
  return DEFAULT_BUDGETS.local;
}

// Size of one message in characters, images and attachments counted as
// token-equivalents so a screenshot is not "free".
function messageChars(m, cpt = DEFAULT_CHARS_PER_TOKEN) {
  if (!m) return 0;
  let n = String(m.content || '').length + 8;
  for (const c of m.toolCalls || []) n += String(c.name || '').length + JSON.stringify(c.input || {}).length + 16;
  for (const r of m.results || []) {
    n += String(r.content || '').length + 16;
    if (Array.isArray(r.images)) n += r.images.length * IMAGE_TOKENS * cpt;
  }
  for (const a of m.attachments || []) {
    if (a.kind === 'image' || a.kind === 'pdf') n += IMAGE_TOKENS * cpt;
    else n += Math.min(Number(a.size) || 0, 200000);
  }
  return n;
}

function totalChars(messages, system) {
  let n = String(system || '').length;
  for (const m of messages) n += messageChars(m);
  return n;
}

function estimateTokens(messages, system, cpt = DEFAULT_CHARS_PER_TOKEN) {
  return Math.ceil(totalChars(messages, system) / (cpt || DEFAULT_CHARS_PER_TOKEN));
}

// Chars-per-token learned from what the server reports, smoothed; the first
// report replaces the guess outright.
class Calibration {
  constructor() { this.cpt = DEFAULT_CHARS_PER_TOKEN; this.seen = false; }
  observe(chars, promptTokens) {
    if (!(promptTokens > 0) || chars < 256) return this.cpt;
    const observed = chars / promptTokens;
    let next = this.seen ? this.cpt * 0.5 + observed * 0.5 : observed;
    next = Math.max(MIN_CPT, Math.min(MAX_CPT, next));
    this.cpt = next;
    this.seen = true;
    return next;
  }
}

// Collapse tool traffic older than the newest `keep` messages: result bodies
// become a stub, images are dropped, oversized call arguments shrink to a
// note. Returns a new array; the stored conversation is never edited.
function collapseOld(messages, keep = 8) {
  const keepFrom = Math.max(0, messages.length - keep);
  return messages.map((m, i) => {
    if (i >= keepFrom) return m;
    let out = m;
    if (m.role === 'tool' && Array.isArray(m.results)) {
      out = { ...m, results: m.results.map((r) => ({ id: r.id, name: r.name, isError: r.isError, content: STUB })) };
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      const calls = m.toolCalls.map((c) => {
        const s = JSON.stringify(c.input || {});
        return s.length > BIG_INPUT ? { ...c, input: { _note: `arguments omitted (${s.length} characters)` } } : c;
      });
      if (calls.some((c, j) => c !== m.toolCalls[j])) out = { ...out, toolCalls: calls };
    }
    return out;
  });
}

// The messages to send for this conversation, within `budget` tokens:
// everything after the last compaction, the summary carried in front.
function prepare(conv, { budget, cpt = DEFAULT_CHARS_PER_TOKEN, system = '' }) {
  const from = Math.max(0, Number(conv.compactedAt) || 0);
  let base = (conv.messages || []).slice(from);
  while (base.length && base[0].role === 'tool') base = base.slice(1);
  const lead = conv.summary ? [
    { role: 'user', content: `Summary of the earlier part of this conversation (compacted to save context):\n\n${conv.summary}` },
    { role: 'assistant', content: 'Understood. I am continuing from that summary.' }
  ] : [];
  const limit = Math.max(1000, budget - Math.min(Math.floor(budget / 4), 4000));
  let msgs = base;
  let collapsed = false;
  let tokens = estimateTokens([...lead, ...msgs], system, cpt);
  if (tokens > limit) { msgs = collapseOld(msgs, 8); collapsed = true; tokens = estimateTokens([...lead, ...msgs], system, cpt); }
  if (tokens > limit) { msgs = collapseOld(msgs, 1); tokens = estimateTokens([...lead, ...msgs], system, cpt); }
  return { messages: [...lead, ...msgs], tokens, limit, budget, collapsed, needsCompaction: tokens > limit, baseCount: base.length, offset: from + ((conv.messages || []).length - from - base.length) };
}

// Where to cut for a compaction: the tail keeps the newest exchanges and
// always starts at a user message, so no tool exchange is split.
function splitForCompaction(messages, keepTail = KEEP_TAIL) {
  if (messages.length <= keepTail + 1) return null;
  let i = messages.length - keepTail;
  while (i > 0 && messages[i].role !== 'user') i--;
  if (i <= 0) return null;
  return { head: messages.slice(0, i), tail: messages.slice(i) };
}

// A readable transcript of the head for the summary request, newest lines
// surviving when it has to be cut (that is where the current state lives).
function transcript(head, cap = TRANSCRIPT_CAP) {
  const lines = [];
  for (const m of head) {
    if (m.role === 'user') lines.push(`[user] ${String(m.content || '').slice(0, 4000)}${m.attachments && m.attachments.length ? ` (attached: ${m.attachments.map((a) => a.name).join(', ')})` : ''}`);
    else if (m.role === 'assistant') {
      if (m.content) lines.push(`[assistant] ${String(m.content).slice(0, 4000)}`);
      for (const c of m.toolCalls || []) lines.push(`[assistant called ${c.name}] ${JSON.stringify(c.input || {}).slice(0, 300)}`);
    } else if (m.role === 'tool') {
      for (const r of m.results || []) lines.push(`[${r.name || 'tool'} result${r.isError ? ' (error)' : ''}] ${String(r.content || '').replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }
  let text = lines.join('\n');
  if (text.length > cap) text = '…\n' + text.slice(text.length - cap);
  return text;
}

function summaryRequest(prior, head) {
  const body = transcript(head);
  return {
    system: 'You write compaction summaries for an assistant\'s working memory. Answer with the summary only - no preamble.',
    messages: [{
      role: 'user',
      content: [
        prior ? `Earlier summary (fold it in, keep what still matters):\n${prior}\n` : '',
        `Transcript to summarize:\n${body}\n`,
        'Write a dense summary (at most about 400 words) with these parts: the user\'s goals and standing instructions; what has been done so far and the results that matter (ids, paths, URLs, settings values); the current state and what is in progress; open questions or things still to do. Keep exact names and values; drop pleasantries.'
      ].filter(Boolean).join('\n')
    }]
  };
}

module.exports = {
  DEFAULT_CHARS_PER_TOKEN, STUB, KEEP_TAIL, DEFAULT_BUDGETS,
  budgetFor, messageChars, totalChars, estimateTokens, Calibration, collapseOld, prepare, splitForCompaction, transcript, summaryRequest
};
