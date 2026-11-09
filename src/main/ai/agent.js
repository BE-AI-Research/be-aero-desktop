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
    'Prefer using tools over guessing. When the user asks for something a tool can do, do it, then confirm briefly. Use search() before launch() to find the exact path of an app or file.',
    'Web research: web_search for results, fetch_url to read a result; open_web_search only when the user wants to see results in their own browser. Driving a web widget: web_read for the text, web_elements for selectors, then web_click / web_type / web_select, and web_wait after anything that navigates. Driving desktop apps: list_running_apps, focus_app, then send_keys; exec_capture runs command-line work and returns the output.',
    'Messages may arrive while you are working; they are delivered in order as new turns - finish the current step, then address them.',
    'You can schedule work to run automatically with schedule_task (daily / weekly / every N minutes / once) when the user asks for reminders, reports or recurring jobs; list_tasks shows what is scheduled. When you ARE running as a scheduled task, nobody is watching: finish the job, write results somewhere useful (scratchpad, a pane, a notification) and keep the summary short.',
    'Users can attach files to messages: images and PDFs arrive as content you can see, text files arrive inline. Work from the attachment itself; use read_file / list_directory for files they refer to by path.',
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
