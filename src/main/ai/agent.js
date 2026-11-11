// The agent loop: user message -> model -> (tool calls -> results -> model)*
// -> final answer. Provider-agnostic; permission decisions are delegated to
// the caller, as is persistence. Emits events the chat UI renders live.
const tools = require('./tools');
const ctxbuf = require('./context');
const { chatWithRetry, isRetryable } = require('./resilience');
const { watchStall, budgetForWindow } = require('./backend');
const toolcalls = require('./toolcalls');

const MAX_CONTEXT_MESSAGES = 60;
const MAX_TOOL_RESULT_CHARS = 20000;

// The user's persona / master instructions come first so they frame
// everything else; the operating rules follow.
function systemPrompt(ctx) {
  const s = ctx.settings();
  const persona = (s.ai && s.ai.systemPrompt || '').trim();
  const memory = ctx.memorySummary ? ctx.memorySummary() : '';
  const now = new Date();
  return [
    persona,
    memory ? `What you remember about this user and their work (global memory; keep it current with memory_remember / memory_forget):\n${memory}` : 'Your global memory is empty. When the user shares a lasting fact about themselves, their preferences or their work, save it with memory_remember.',
    ctx.noTools
      ? 'You are the assistant built into BE-Aero Desktop, a widget-based desktop shell. In this configuration you answer from knowledge and the conversation only: no tools are available, so say so plainly when the user asks you to act on the desktop, and tell them what they can do themselves.'
      : 'You are the assistant built into BE-Aero Desktop, a widget-based desktop shell. You can observe and operate the desktop through tools: widgets, settings, themes, the scratchpad, the search index, running applications, and web widgets (embedded browser frames you can read, navigate, click and type into).',
    'Prefer using tools over guessing. When the user asks for something a tool can do, do it, then confirm briefly. Use search() before launch() to find the exact path of an app or file.',
    'Web research: web_search for results, fetch_url to read a result. Browsing for the user happens in two places. (1) The OS browser: browser_open(url) opens the page in their own browser (their main profile) and returns its text; when you must click or type in a page, browser_open(url, interact: true) opens it in the assistant browser profile instead (they may need to sign in there once), then browser_elements lists NUMBERED elements and browser_click / browser_type act by index; after anything that navigates, read again. browser_screenshot shows you the page when text is not enough. (2) Web widgets on the desktop: web_open(url), then web_elements -> web_click / web_type by index, web_screenshot to look. Use the OS browser when the user says "browser", wants to see it, or needs their logged-in sites; use widgets for things that should live on the desktop. Driving desktop apps: list_running_apps, focus_app, then send_keys; exec_capture runs command-line work and returns the output.',
    'Messages may arrive while you are working; they are delivered in order as new turns - finish the current step, then address them.',
    'You can schedule work to run automatically with schedule_task (daily / weekly / every N minutes / once) when the user asks for reminders, reports or recurring jobs; list_tasks shows what is scheduled. When you ARE running as a scheduled task, nobody is watching: finish the job, write results somewhere useful (scratchpad, a pane, a notification) and keep the summary short.',
    'When information is easier to grasp visually - numbers to compare, a trend, a table with more than a few rows, a schedule, a dashboard, a diagram - call show_visual with a small self-contained HTML page instead of describing it in text, then describe in plain words what it shows - the key numbers, the trend, the conclusion - in a sentence or two, as if speaking to someone who cannot see the screen (replies may be read aloud). Never paste the HTML, CSS, JavaScript or data into your reply text, and do not narrate how it was built. Keep pages compact (they render in a narrow sidebar card); use where "desktop" when the user wants something to keep on screen.',
    ctx.aiFolder ? `Your own folder is ${ctx.aiFolder()} (it is "AI Folder" in the user's file browser). Files attached to chats are copied into its Uploads folder. Save anything you make for the user there with write_file - it is the only place you can write - and tell them the file name.` : '',
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
  // Screenshots are only useful while fresh; keep the last few, drop the rest
  // from the request so the payload stays small (they remain on disk).
  const keepFrom = Math.max(0, slice.length - 8);
  return slice.map((m, i) => (m.role === 'tool' && i < keepFrom && m.results && m.results.some((r) => r.images)
    ? { ...m, results: m.results.map((r) => ({ ...r, images: undefined })) } : m));
}

// Summarize the older part of the conversation with the model and record
// the compaction on the conversation (ctx.compact persists it). False when
// there is nothing to compact or the model returned no summary.
async function compactConversation({ provider, model, conversation, ctx, emit, signal, keepTail = ctxbuf.KEEP_TAIL }) {
  const from = Math.max(0, Number(conversation.compactedAt) || 0);
  let base = conversation.messages.slice(from);
  let skipped = 0;
  while (base.length && base[0].role === 'tool') { base = base.slice(1); skipped++; }
  // A short conversation that is already over budget (huge messages, tiny
  // window) still compacts: keep less of the tail rather than nothing.
  let split = null;
  for (const keep of [keepTail, 2, 1]) { split = ctxbuf.splitForCompaction(base, keep); if (split) break; }
  if (!split) return false;
  const req = ctxbuf.summaryRequest(conversation.summary || '', split.head);
  const res = await chatWithRetry(provider, { model, system: req.system, messages: req.messages, tools: [], signal, maxTokens: 1500 }, { emit, signal });
  const summary = String(res && res.text || '').trim();
  if (!summary) return false;
  ctx.compact(summary, from + skipped + split.head.length);
  return true;
}

async function runTurn({ provider, model, conversation, ctx, permit, emit, signal, maxSteps = 12, context = {} }) {
  const defs = ctx.noTools ? [] : tools.definitions();
  const baseSystem = systemPrompt(ctx);
  // Tool-call format (BE-Code profiles): 'native' sends the tools field;
  // 'compat' embeds the tool list in the prompt and reads calls from text.
  // In 'auto' a profile can require compat (Gemma, Phi, DeepSeek-R1), and a
  // server that rejects the tools field switches the session to compat.
  // Whatever the mode, calls written as text (Qwen XML, <tool_call> JSON,
  // Mistral, Llama, Gemma tool_code) are recognised.
  const profile = toolcalls.profileFor(model);
  const session = context.session || {};
  const setting = context.toolMode || 'auto';
  const compatMode = () => defs.length > 0 && setting !== 'native' && (setting === 'compat' || profile.compat === 'always' || !!session.compat);
  // finalOnly: the step limit was reached - one last call without tools, so
  // the request ends with an answer from what was found, not with nothing.
  let finalOnly = false;
  const systemFor = () => (compatMode() && !finalOnly ? `${baseSystem}\n\n${toolcalls.compatInstructions(defs)}` : baseSystem);
  let system = systemFor();
  let cutOffRetried = false;
  let emptyNudged = false;
  // Read-only calls already made in this request (name + input): a repeat
  // is answered from memory instead of fetching the same page again.
  const seen = new Map();
  // Set when the step's request was cancelled to be sent again (the model
  // blocking the server was unloaded): not a stop, the step re-runs.
  let restartStep = false;
  const baseBudget = Number(context.budget) > 0 ? Number(context.budget) : ctxbuf.DEFAULT_BUDGETS.local;
  let budget = baseBudget;
  const calibration = context.calibration || new ctxbuf.Calibration();
  let steps = 0;
  for (;;) {
    if (signal && signal.aborted) return { stopped: true };
    steps++;
    let res;
    try {
      // The context buffer: collapse old tool traffic, then summarize with
      // the model, then trim - the ladder BE-Code uses for small windows.
      // Before each call (BE-Code checkBackend): is the model still loaded,
      // and with which window? A reload at a smaller window shrinks the
      // budget so the conversation is compacted to fit, not truncated.
      if (context.checkBackend) {
        let st = null;
        try { st = await context.checkBackend(); } catch { st = null; }
        if (st && st.loaded && st.window > 0) budget = budgetForWindow(st.window, baseBudget);
      }
      system = systemFor();
      let prep = ctxbuf.prepare(conversation, { budget, cpt: calibration.cpt, system });
      if (prep.needsCompaction && context.compactWithModel !== false) {
        emit({ type: 'notice', text: `Context at about ${prep.tokens.toLocaleString()} of ${budget.toLocaleString()} tokens - summarizing the older part of this conversation.` });
        let ok = false;
        try { ok = await compactConversation({ provider, model, conversation, ctx, emit, signal }); } catch (err) { if (signal && signal.aborted) return { stopped: true }; ok = false; }
        prep = ctxbuf.prepare(conversation, { budget, cpt: calibration.cpt, system });
        emit({ type: 'notice', text: ok ? `Compacted to about ${prep.tokens.toLocaleString()} tokens.` : 'The model returned no summary; continuing with the newest messages only.' });
      }
      let messages = prep.messages;
      if (prep.needsCompaction) messages = windowMessages(messages).slice(-12);
      // Silence is reported, not left to look like a hang (model loading,
      // prompt re-processing, or queued behind another client).
      // <think> blocks never reach the screen; a separate reasoning stream
      // counts as activity and shows as "thinking".
      const think = new toolcalls.ThinkFilter();
      // The step's own abort: the run's Stop aborts it, and so can
      // registerStep's restart (then the same step is sent again).
      const stepAc = new AbortController();
      const relay = () => stepAc.abort();
      if (signal) { if (signal.aborted) stepAc.abort(); else signal.addEventListener('abort', relay, { once: true }); }
      if (context.registerStep) context.registerStep(() => { restartStep = true; stepAc.abort(); });
      const stall = watchStall((delta) => { const v = think.feed(delta); if (v) emit({ type: 'delta', text: v }); },
        (stage, idleMs) => { emit({ type: 'stall', stage, seconds: Math.round(idleMs / 1000) }); if (context.onStall) context.onStall(stage, idleMs); }, context.stall || {});
      let thinkingShown = false;
      const onReasoning = () => { stall.onText(''); if (!thinkingShown) { thinkingShown = true; emit({ type: 'thinking' }); } };
      try {
        res = await chatWithRetry(provider, {
          model, system, tools: compatMode() || finalOnly ? [] : defs, compat: compatMode() && !finalOnly, signal: stepAc.signal, messages,
          onText: stall.onText, onReasoning
        }, { emit, signal: stepAc.signal });
        const tail = think.flush();
        if (tail) emit({ type: 'delta', text: tail });
      } finally {
        stall.stop();
        if (signal) signal.removeEventListener('abort', relay);
        if (context.registerStep) context.registerStep(null);
      }
      emit({ type: 'stall', stage: 0, seconds: 0 });
      if (res && res.usage && res.usage.input) calibration.observe(ctxbuf.totalChars(messages, system), res.usage.input);
      emit({ type: 'context', tokens: ctxbuf.estimateTokens(messages, system, calibration.cpt), budget, compacted: !!conversation.summary });
    } catch (err) {
      if (signal && signal.aborted) return { stopped: true };
      if (restartStep) {
        restartStep = false;
        steps--;
        emit({ type: 'stall', stage: 0, seconds: 0 });
        emit({ type: 'notice', text: 'Sending the request again now that the server is free.' });
        continue;
      }
      // Some servers reject the tools field outright: embedded calls for the
      // rest of the session, and this step again.
      if (!compatMode() && setting !== 'native' && defs.length && !session.nativeWorked && toolcalls.looksLikeToolsUnsupported(err)) {
        session.compat = true;
        emit({ type: 'notice', text: 'The server rejected native tool calls; switching to text tool calls for this model.' });
        steps--;
        continue;
      }
      const message = provider.describeError ? provider.describeError(err) : String(err && err.message || err);
      emit({ type: 'error', message });
      return { error: message, retryable: isRetryable(err) };
    }

    // Normalise what came back: reasoning out of the text, and tool calls the
    // model wrote as text (any of the formats in toolcalls.js) into calls.
    const rawText = String(res.text || '');
    let text = toolcalls.stripThink(rawText);
    let calls = finalOnly ? [] : (res.toolCalls || []);
    if (calls.length) session.nativeWorked = true;
    if (!calls.length && defs.length && !finalOnly) {
      const parsed = toolcalls.parseEmbeddedCalls(text, defs);
      if (parsed.calls.length) { calls = parsed.calls; text = parsed.text; }
    }
    // A reply cut off inside a tool call is not an answer: ask once for it again.
    if (!calls.length && !cutOffRetried && toolcalls.openEmbeddedCall(text)) {
      cutOffRetried = true;
      ctx.append({ role: 'assistant', content: text });
      ctx.append({ role: 'user', content: '[Your last tool call was cut off before it closed. Issue it again, complete, with shorter arguments if you can.]' });
      emit({ type: 'notice', text: 'The model\'s tool call was cut off; asking it to try again.' });
      continue;
    }
    // Nothing at all (no text, no call): usually a model that spent its
    // output thinking. Nudge once instead of ending silently.
    if (!calls.length && !text.trim() && !emptyNudged && res.stopReason !== 'refusal') {
      emptyNudged = true;
      emit({ type: 'notice', text: res.reasoning ? 'The model only thought and gave no answer; asking it to answer.' : 'The model returned an empty reply; asking it to continue.' });
      ctx.append({ role: 'user', content: '[Your last reply was empty. Continue the task: call a tool or give your answer now.]' });
      continue;
    }
    res = { ...res, text, toolCalls: calls };

    const assistant = { role: 'assistant', content: res.text || '' };
    if (res.toolCalls && res.toolCalls.length) assistant.toolCalls = res.toolCalls;
    ctx.append(assistant);
    emit({ type: 'assistant', content: assistant.content, toolCalls: assistant.toolCalls || [] });

    if (res.stopReason === 'refusal') {
      emit({ type: 'error', message: 'The model declined this request.' });
      return { refusal: true };
    }
    if (!res.toolCalls || !res.toolCalls.length) return { done: true, usage: res.usage, ...(finalOnly ? { truncated: true } : {}) };
    if (steps >= maxSteps) {
      // Out of tool steps: these calls are not run, and the model answers
      // from what it has (one call, no tools).
      ctx.append({ role: 'tool', results: res.toolCalls.map((c) => ({ id: c.id, name: c.name, content: 'Not run: the tool-step limit for this request was reached.', isError: true })) });
      ctx.append({ role: 'user', content: '[Tool-step limit reached. No more tool calls. Give your final answer now from what you have already found, and say plainly what you could not confirm.]' });
      emit({ type: 'notice', text: `Reached the limit of ${maxSteps} tool steps; asking for a final answer from what was found.` });
      finalOnly = true;
      continue;
    }

    const results = [];
    for (const call of res.toolCalls) {
      if (signal && signal.aborted) return { stopped: true };
      let content;
      let isError = false;
      let images = null;
      const invalid = tools.validateInput(call.name, call.input);
      let callKey = '';
      try { callKey = `${call.name}|${JSON.stringify(call.input || {})}`; } catch { callKey = ''; }
      const repeat = !invalid && callKey && tools.categoryOf(call.name) === 'read' && seen.has(callKey);
      if (repeat) {
        content = `Already done earlier in this request (step ${seen.get(callKey)}); its result is above. Do not repeat it: use what you have, or give your answer.`;
      } else if (invalid) {
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
            if (out && Array.isArray(out.images) && out.images.length) {
              images = out.images.filter((im) => im && im.data).slice(0, 2);
              const { images: _omit, ...rest } = out;
              content = tools.clip(rest, MAX_TOOL_RESULT_CHARS);
            } else {
              content = tools.clip(out === undefined ? { ok: true } : out, MAX_TOOL_RESULT_CHARS);
            }
          } catch (err) {
            content = `Error: ${err && err.message || err}`;
            isError = true;
          }
        }
      }
      if (callKey && !repeat && !invalid) seen.set(callKey, steps);
      results.push({ id: call.id, name: call.name, content, isError, ...(images ? { images } : {}) });
      emit({ type: 'tool', id: call.id, name: call.name, input: call.input, ok: !isError, result: content.slice(0, 2000), image: images ? `data:${images[0].mime};base64,${images[0].data}` : null });
    }
    ctx.append({ role: 'tool', results });
  }
}

module.exports = { runTurn, systemPrompt, windowMessages, compactConversation };
