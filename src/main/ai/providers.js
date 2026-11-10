// Model providers behind one interface:
//   provider.chat({ model, system, messages, tools, onText, signal }) ->
//     { text, toolCalls: [{ id, name, input }], stopReason, usage }
//   provider.listModels() -> [ids]
//
// Two adapters cover the field: Anthropic through the official SDK, and
// the OpenAI-compatible chat/completions dialect that OpenAI itself, Ollama,
// LM Studio, llama.cpp, vLLM, OpenRouter and most others speak - which is
// what makes "local providers" a configuration rather than a feature.

const attachments = require('./attachments');
const toolcalls = require('./toolcalls');
const { parseUnixBase, defaultBeCodeSocket, socketFetch } = require('./transport');

// local: a server on this machine or LAN (small windows, may restart - the
// context buffer and reconnection are tuned for it). noTools: the endpoint
// serves inference only, so the assistant answers without acting.
const PRESETS = {
  anthropic: { label: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: '', model: 'claude-opus-5-5', needsKey: true },
  openai: { label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', needsKey: true },
  ollama: { label: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: '', needsKey: false, local: true },
  lmstudio: { label: 'LM Studio (local)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', model: '', needsKey: false, local: true },
  llamacpp: { label: 'llama.cpp server (local)', kind: 'openai', baseUrl: 'http://localhost:8080/v1', model: '', needsKey: false, local: true },
  becode: { label: 'BE-Code session (shared inference)', kind: 'openai', baseUrl: `unix://${defaultBeCodeSocket()}`, model: 'default', needsKey: true, local: true, noTools: true,
    hint: 'A running BE-Code session with api.enabled serves ~/.be-code/api/api.sock. Register this app once (be-code apps add be-aero --tiers completions) and paste the key it prints. Inference only: the assistant answers but does not use tools.'
      + (process.platform === 'win32' ? ' On Windows this socket cannot be reached from the app yet (Node has no AF_UNIX client here); use it on Linux or macOS, or point a local provider at the BE-Code TCP endpoint when one exists.' : '') },
  beaiengine: { label: 'BE AI Engine fabric', kind: 'openai', baseUrl: 'http://localhost:9800/v1', model: '', needsKey: true, local: true },
  custom: { label: 'Custom OpenAI-compatible server', kind: 'openai', baseUrl: '', model: '', needsKey: false, local: true }
};

// ------------------------------------------------------------ translation
// Provider-neutral conversation messages -> Anthropic Messages API shape.
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: m.attachments && m.attachments.length
          ? attachments.toAnthropicContent(m.content, m.attachments)
          : [{ type: 'text', text: String(m.content || '') }]
      });
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: String(m.content) });
      for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input || {} });
      if (content.length) out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: (m.results || []).map((r) => ({
          type: 'tool_result', tool_use_id: r.id,
          content: r.images && r.images.length
            ? [{ type: 'text', text: String(r.content || '') }, ...r.images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } }))]
            : String(r.content || ''),
          ...(r.isError ? { is_error: true } : {})
        }))
      });
    }
  }
  return out;
}

function toAnthropicTools(tools) {
  return (tools || []).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

// Provider-neutral -> OpenAI chat/completions shape.
// compat: the server gets no tools field; earlier calls and results are
// written into the transcript in the embedded text format instead.
function toOpenAiMessages(system, messages, { compat = false } = {}) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (compat && m.role === 'assistant') {
      const text = [m.content ? String(m.content) : '', ...(m.toolCalls || []).map(toolcalls.callAsText)].filter(Boolean).join('\n');
      out.push({ role: 'assistant', content: text });
      continue;
    }
    if (compat && m.role === 'tool') {
      out.push({ role: 'user', content: (m.results || []).map(toolcalls.resultAsText).join('\n') });
      const shots = [];
      for (const r of m.results || []) for (const im of r.images || []) shots.push(im);
      if (shots.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Screenshots returned by the tool:' }, ...shots.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } }))] });
      continue;
    }
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: m.attachments && m.attachments.length
          ? attachments.toOpenAiContent(m.content, m.attachments)
          : String(m.content || '')
      });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content ? String(m.content) : null };
      if (m.toolCalls && m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) }
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      const shots = [];
      for (const r of m.results || []) {
        out.push({ role: 'tool', tool_call_id: r.id, content: String(r.content || '') });
        for (const im of r.images || []) shots.push({ name: r.name, im });
      }
      // The tool role cannot carry images here; hand them over as a user turn.
      if (shots.length) {
        out.push({ role: 'user', content: [
          { type: 'text', text: `Screenshot${shots.length > 1 ? 's' : ''} returned by ${[...new Set(shots.map((s) => s.name))].join(', ')}:` },
          ...shots.map((s) => ({ type: 'image_url', image_url: { url: `data:${s.im.mime};base64,${s.im.data}` } }))
        ] });
      }
    }
  }
  return out;
}

function toOpenAiTools(tools) {
  return (tools || []).map((t) => ({
    type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema }
  }));
}

// Fold one OpenAI streaming chunk into the accumulating state.
function applyOpenAiDelta(state, chunk) {
  const choice = chunk && chunk.choices && chunk.choices[0];
  if (!choice) return;
  const d = choice.delta || {};
  if (typeof d.content === 'string' && d.content) state.text += d.content;
  // Thinking models (Qwen3, DeepSeek-R1, gpt-oss) stream their reasoning in a
  // separate field on Ollama / vLLM / LM Studio.
  const r = (typeof d.reasoning === 'string' ? d.reasoning : '') + (typeof d.reasoning_content === 'string' ? d.reasoning_content : '');
  if (r) state.reasoning = (state.reasoning || '') + r;
  for (const tc of d.tool_calls || []) {
    const i = tc.index ?? 0;
    const cur = state.calls[i] || (state.calls[i] = { id: '', name: '', args: '' });
    if (tc.id) cur.id = tc.id;
    if (tc.function && tc.function.name) cur.name += tc.function.name;
    if (tc.function && typeof tc.function.arguments === 'string') cur.args += tc.function.arguments;
    else if (tc.function && tc.function.arguments && typeof tc.function.arguments === 'object') cur.args = JSON.stringify(tc.function.arguments);
  }
  if (choice.finish_reason) state.finish = choice.finish_reason;
}

function finishOpenAiState(state) {
  const toolCalls = [];
  state.calls.forEach((c, i) => {
    if (!c || !c.name) return;
    // Forgiving: double-encoded JSON, trailing commas, single quotes.
    const input = toolcalls.parseArgs(c.args) || { _unparsed: c.args };
    toolCalls.push({ id: c.id || `call_${i}`, name: c.name, input });
  });
  return {
    text: state.text, toolCalls, reasoning: state.reasoning || '', finish: state.finish || null,
    stopReason: toolCalls.length ? 'tool_use' : state.finish === 'length' ? 'max_tokens' : 'end_turn'
  };
}

// ------------------------------------------------------------- Anthropic
class AnthropicProvider {
  constructor({ apiKey, baseUrl }) {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod.Anthropic || mod;
    this.Anthropic = Anthropic;
    this.client = new Anthropic({ apiKey: apiKey || 'missing', ...(baseUrl ? { baseURL: baseUrl } : {}) });
  }

  async chat({ model, system, messages, tools, onText, signal, maxTokens = 16000 }) {
    const params = {
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: toAnthropicMessages(messages),
      ...(tools && tools.length ? { tools: toAnthropicTools(tools) } : {})
    };
    // Refusal fallbacks: on a safety decline the API reruns the turn on a
    // fallback model inside the same call. Only on the models that take it.
    const withFallback = /claude-(opus-5|fable-5|sonnet-5-5)/.test(model);
    const stream = withFallback
      ? this.client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
      : this.client.messages.stream(params, { signal });
    if (onText) stream.on('text', (delta) => onText(delta));
    const msg = await stream.finalMessage();
    let text = '';
    const toolCalls = [];
    for (const b of msg.content || []) {
      if (b.type === 'text') text += b.text;
      else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input || {} });
    }
    return {
      text, toolCalls, stopReason: msg.stop_reason, stopDetails: msg.stop_details || null,
      usage: msg.usage ? { input: msg.usage.input_tokens, output: msg.usage.output_tokens } : null
    };
  }

  async listModels() {
    const ids = [];
    for await (const m of this.client.models.list()) ids.push(m.id);
    return ids;
  }

  describeError(err) {
    const A = this.Anthropic;
    if (err instanceof A.AuthenticationError) return 'Anthropic rejected the API key.';
    if (err instanceof A.RateLimitError) return 'Rate limited by Anthropic - try again shortly.';
    if (err instanceof A.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
    return err && err.message ? err.message : String(err);
  }
}

// ----------------------------------------------------- OpenAI-compatible
class OpenAiCompatProvider {
  constructor({ apiKey, baseUrl, fetchImpl }) {
    this.apiKey = apiKey || '';
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    // unix://<socket> serves the API at /v1 on that socket (BE-Code).
    this.socketPath = parseUnixBase(this.baseUrl);
    if (this.socketPath) this.baseUrl = '/v1';
    this.fetch = fetchImpl || (this.socketPath
      ? (p, opts) => socketFetch(this.socketPath, p, opts)
      : (...a) => fetch(...a));
  }

  // An HTTP failure carries its status (and Retry-After) so the retry loop
  // can tell a rate limit from a rejected key without parsing text.
  async httpError(res, what) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 400); } catch { /* ignore */ }
    const err = new Error(`${res.status} from ${what}: ${detail || res.statusText}`);
    err.status = res.status;
    const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
    if (ra > 0) err.retryAfter = ra;
    return err;
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
    };
  }

  async chat({ model, system, messages, tools, onText, onReasoning, signal, maxTokens = 16000, compat = false }) {
    if (!this.baseUrl) throw new Error('No server URL configured for this provider.');
    const body = {
      model, stream: true, max_tokens: maxTokens,
      messages: toOpenAiMessages(system, messages, { compat }),
      ...(!compat && tools && tools.length ? { tools: toOpenAiTools(tools), tool_choice: 'auto' } : {})
    };
    const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal
    });
    if (!res.ok) throw await this.httpError(res, this.socketPath || this.baseUrl);
    const state = { text: '', calls: [], finish: null, reasoning: '' };
    const ctype = res.headers.get('content-type') || '';
    if (!/text\/event-stream/i.test(ctype)) {
      // Server ignored stream:true and answered in one JSON body.
      const json = await res.json();
      const msg = json.choices && json.choices[0] && json.choices[0].message || {};
      state.text = msg.content || '';
      state.reasoning = msg.reasoning_content || msg.reasoning || '';
      (msg.tool_calls || []).forEach((tc, i) => { const a = tc.function.arguments; state.calls[i] = { id: tc.id, name: tc.function.name, args: a && typeof a === 'object' ? JSON.stringify(a) : (a || '') }; });
      state.finish = json.choices && json.choices[0] && json.choices[0].finish_reason;
      if (onText && state.text) onText(state.text);
      return { ...finishOpenAiState(state), usage: json.usage ? { input: json.usage.prompt_tokens, output: json.usage.completion_tokens } : null };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let usage = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        const before = state.text.length;
        const rBefore = state.reasoning.length;
        applyOpenAiDelta(state, chunk);
        if (onText && state.text.length > before) onText(state.text.slice(before));
        if (onReasoning && state.reasoning.length > rBefore) onReasoning(state.reasoning.slice(rBefore));
        if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
      }
    }
    return { ...finishOpenAiState(state), usage };
  }

  async listModels({ signal } = {}) {
    if (!this.baseUrl) throw new Error('No server URL configured.');
    const res = await this.fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal });
    if (!res.ok) {
      // BE-Code's API has no model list; its session model is "default".
      if (this.socketPath && res.status === 404) return ['default'];
      throw await this.httpError(res, `${this.socketPath || this.baseUrl}/models`);
    }
    const json = await res.json();
    return (json.data || []).map((m) => m.id).filter(Boolean).sort();
  }

  describeError(err) {
    const where = this.socketPath || this.baseUrl;
    if (err && /ECONNREFUSED|ENOENT|fetch failed|socket hang up/i.test(String(err.message))) {
      return this.socketPath
        ? `No BE-Code session is serving at ${where} - start one with api.enabled (or /api on).`
        : `Could not reach ${where} - is the server running?`;
    }
    return err && err.message ? err.message : String(err);
  }
}

function createProvider(config) {
  const preset = PRESETS[config.provider] || PRESETS.custom;
  const baseUrl = config.baseUrl || preset.baseUrl;
  if (preset.kind === 'anthropic') return new AnthropicProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl || '' });
  return new OpenAiCompatProvider({ apiKey: config.apiKey, baseUrl });
}

module.exports = {
  PRESETS, createProvider, AnthropicProvider, OpenAiCompatProvider,
  toAnthropicMessages, toAnthropicTools, toOpenAiMessages, toOpenAiTools, applyOpenAiDelta, finishOpenAiState
};
