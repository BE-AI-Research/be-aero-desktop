// The agent loop: user message -> model -> (tool calls -> results -> model)*
// -> final answer. Provider-agnostic; permission decisions are delegated to
// the caller, as is persistence. Emits events the chat UI renders live.
const tools = require('./tools');

const MAX_CONTEXT_MESSAGES = 60;
const MAX_TOOL_RESULT_CHARS = 20000;

// The user's persona / master instructions come first so they frame
// everything else; the operating rules follow.
function systemPrompt(ctx) {
  const s = ctx.settings();
  const persona = (s.ai && s.ai.systemPrompt || '').trim();
  const now = new Date();
  return [
    persona,
    'You are the assistant built into BE-Aero Desktop, a widget-based desktop shell. You can observe and operate the desktop through tools: widgets, settings, themes, the scratchpad, the search index, running applications, and web widgets (embedded browser frames you can read, navigate, click and type into).',
    'Prefer using tools over guessing. When the user asks for something a tool can do, do it, then confirm briefly. Use search() before launch() to find the exact path of an app or file. For web tasks, read the page first (web_read), then act.',
    'Some tools change things on the user\'s machine; those may prompt the user for permission - if a tool reports it was denied, stop and tell the user instead of retrying.',
    'Be concise. Plain prose with occasional short lists; no headings unless asked. Write in the user\'s language.',
    `Context: platform ${process.platform}; local time ${now.toLocaleString()}; layout mode "${s.dock}"; theme preset "${(s.theme || {}).preset || 'aero'}".`
  ].filter(Boolean).join('\n\n');
}

// Keep the request bounded: the most recent messages, never splitting a
// tool exchange from the assistant turn that requested it.
function windowMessages(messages) {
  let slice = messages.slice(-MAX_CONTEXT_MESSAGES);
  while (slice.length && slice[0].role === 'tool') slice = slice.slice(1);
  return slice;
}

async function runTurn({ provider, model, conversation, ctx, permit, emit, signal, maxSteps = 12 }) {
  const defs = tools.definitions();
  const system = systemPrompt(ctx);
  let steps = 0;
  for (;;) {
    if (signal && signal.aborted) return { stopped: true };
    steps++;
    let res;
    try {
      res = await provider.chat({
        model, system, tools: defs, signal,
        messages: windowMessages(conversation.messages),
        onText: (delta) => emit({ type: 'delta', text: delta })
      });
    } catch (err) {
      if (signal && signal.aborted) return { stopped: true };
      const message = provider.describeError ? provider.describeError(err) : String(err && err.message || err);
      emit({ type: 'error', message });
      return { error: message };
    }

    const assistant = { role: 'assistant', content: res.text || '' };
    if (res.toolCalls && res.toolCalls.length) assistant.toolCalls = res.toolCalls;
    ctx.append(assistant);
    emit({ type: 'assistant', content: assistant.content, toolCalls: assistant.toolCalls || [] });

    if (res.stopReason === 'refusal') {
      emit({ type: 'error', message: 'The model declined this request.' });
      return { refusal: true };
    }
    if (!res.toolCalls || !res.toolCalls.length) return { done: true, usage: res.usage };
    if (steps >= maxSteps) {
      emit({ type: 'error', message: `Stopped after ${maxSteps} tool steps.` });
      return { done: true, truncated: true };
    }

    const results = [];
    for (const call of res.toolCalls) {
      if (signal && signal.aborted) return { stopped: true };
      let content;
      let isError = false;
      const invalid = tools.validateInput(call.name, call.input);
      if (invalid) {
        content = `Invalid input: ${invalid}`;
        isError = true;
      } else {
        const category = tools.categoryOf(call.name);
        const allowed = category === 'read' ? true : await permit(call);
        if (!allowed) {
          content = 'Denied by the user. Do not retry this action.';
          isError = true;
        } else {
          try {
            const out = await tools.execute(call.name, call.input, ctx);
            content = tools.clip(out === undefined ? { ok: true } : out, MAX_TOOL_RESULT_CHARS);
          } catch (err) {
            content = `Error: ${err && err.message || err}`;
            isError = true;
          }
        }
      }
      results.push({ id: call.id, name: call.name, content, isError });
      emit({ type: 'tool', id: call.id, name: call.name, input: call.input, ok: !isError, result: content.slice(0, 2000) });
    }
    ctx.append({ role: 'tool', results });
  }
}

module.exports = { runTurn, systemPrompt, windowMessages };
