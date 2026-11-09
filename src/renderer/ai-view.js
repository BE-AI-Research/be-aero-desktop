// AI chat widget: conversations list, streamed replies, tool-call rows, a
// pin-on-top toggle for watching agentic tasks, and the hand-off target for
// "Ask AI" from the search bar / Spotlight.
(function () {
  let aero = null;
  let root = null;
  let msgsEl = null;
  let inputEl = null;
  let sendBtn = null;
  let stopBtn = null;
  let pinBtn = null;
  let listEl = null;
  let titleEl = null;
  let statusEl = null;
  let current = null;       // conversation id
  let busy = false;
  let streamEl = null;      // the assistant bubble currently streaming
  let streamText = '';
  let pinned = false;
  let queued = [];          // messages waiting behind the current turn

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Markdown-lite: fenced code, inline code, bold, italics, lists, links.
  function md(text) {
    const parts = String(text || '').split(/```/);
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        const body = part.replace(/^[a-z0-9_-]*\n/i, '');
        return `<pre><code>${esc(body)}</code></pre>`;
      }
      let h = esc(part);
      h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      h = h.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>');
      h = h.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" data-ext>$1</a>');
      h = h.replace(/^(?:[-*] .*(?:\n|$))+/gm, (block) =>
        '<ul>' + block.trim().split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('') + '</ul>');
      h = h.replace(/^(?:\d+\. .*(?:\n|$))+/gm, (block) =>
        '<ol>' + block.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('') + '</ol>');
      return h.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
    }).join('');
  }

  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function scrollToEnd() {
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function bubble(role, html) {
    const b = el('div', `ai-msg ai-${role}`, msgsEl);
    b.innerHTML = html;
    scrollToEnd();
    return b;
  }

  function toolRow(name, ok, input, result) {
    const row = el('details', `ai-tool ${ok ? 'ok' : 'err'}`, msgsEl);
    const sum = el('summary', '', row);
    sum.textContent = `${ok ? '⚙' : '⚠'} ${name}`;
    const body = el('div', 'ai-tool-body', row);
    body.textContent = `${JSON.stringify(input || {}, null, 1)}\n→ ${result || ''}`;
    scrollToEnd();
  }

  function renderQueue() {
    for (const el of msgsEl.querySelectorAll('.ai-queued')) el.remove();
    queued.forEach((text, i) => {
      const b = el('div', 'ai-msg ai-queued', msgsEl);
      b.innerHTML = `<span class="q-tag">queued</span> ${esc(text)} <button class="q-x" title="Remove from queue">\u2715</button>`;
      b.querySelector('.q-x').addEventListener('click', () => { if (current) aero.aiUnqueue(current, i); });
    });
    scrollToEnd();
  }

  // Label: the title becomes an inline editor; Enter or blur saves, Esc cancels.
  function editLabel() {
    if (!current || titleEl.isContentEditable) return;
    const before = titleEl.textContent;
    titleEl.contentEditable = 'true';
    titleEl.classList.add('editing');
    titleEl.focus();
    document.getSelection().selectAllChildren(titleEl);
    const finish = async (save) => {
      titleEl.contentEditable = 'false';
      titleEl.classList.remove('editing');
      const next = titleEl.textContent.trim();
      if (save && next && next !== before) {
        await aero.aiRename(current, next);
        await refreshList();
      } else titleEl.textContent = before;
    };
    titleEl.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    titleEl.onblur = () => finish(true);
  }

  function setBusy(on) {
    busy = on;
    root.classList.toggle('busy', on);
    sendBtn.title = on ? 'Queue this message for after the current turn' : 'Send (Enter)';
    stopBtn.hidden = !on;
    statusEl.textContent = on ? 'Thinking…' : '';
  }

  function renderConversation(conv) {
    msgsEl.innerHTML = '';
    streamEl = null;
    const hint = () => bubble('hint', 'Ask anything - or ask it to change a theme, open an app, read a web widget, or take notes.');
    if (!conv) { titleEl.textContent = 'New conversation'; hint(); return; }
    titleEl.textContent = conv.title || 'Conversation';
    for (const m of conv.messages || []) {
      if (m.role === 'user') bubble('user', esc(m.content));
      else if (m.role === 'assistant') {
        if (m.content) bubble('assistant', md(m.content));
      } else if (m.role === 'tool') {
        for (const r of m.results || []) toolRow(r.name, !r.isError, null, String(r.content || '').slice(0, 400));
      }
    }
    if (!(conv.messages || []).length) hint();
  }

  async function refreshList() {
    const list = await aero.aiConversations();
    listEl.innerHTML = '';
    const opt0 = el('option', '', listEl, 'New conversation');
    opt0.value = '';
    for (const c of list) {
      const o = el('option', '', listEl, c.title);
      o.value = c.id;
    }
    listEl.value = current || '';
  }

  async function openConversation(id) {
    current = id || null;
    const conv = current ? await aero.aiConversation(current) : null;
    if (current && !conv) current = null;
    renderConversation(conv);
    listEl.value = current || '';
  }

  async function send(text) {
    const t = String(text || inputEl.value || '').trim();
    if (!t) return;
    inputEl.value = '';
    inputEl.style.height = '';
    if (!busy) setBusy(true);
    // Optimistic user bubble; the service echoes the final conversation id.
    if (msgsEl.querySelector('.ai-hint')) msgsEl.innerHTML = '';
    bubble('user', esc(t));
    const res = await aero.aiSend(current, t);
    if (res && res.queued) {
      // Shown as queued (the 'queue' event carries the authoritative list);
      // drop the optimistic bubble so it is not shown twice.
      const bubbles = msgsEl.querySelectorAll('.ai-user');
      if (bubbles.length) bubbles[bubbles.length - 1].remove();
      return;
    }
    if (res && res.conversationId && res.conversationId !== current) {
      current = res.conversationId;
      await refreshList();
    }
    if (res && res.error && !res.conversationId) {
      bubble('error', esc(res.error));
      setBusy(false);
    } else if (res && res.error) {
      // The run itself reported the error through events; nothing more to add.
      setBusy(false);
    } else {
      setBusy(false);
    }
  }

  function onEvent(ev) {
    if (!ev || (current && ev.conversationId !== current)) {
      // Events for another conversation (e.g. a Spotlight ask while viewing
      // an old one): switch to it so the user sees what is happening.
      if (ev && ev.type === 'user' && ev.conversationId) {
        current = ev.conversationId;
        openConversation(current).then(refreshList);
      }
      return;
    }
    switch (ev.type) {
      case 'user':
        if (!current) { current = ev.conversationId; refreshList(); }
        if (ev.title) titleEl.textContent = ev.title;
        break;
      case 'delta':
        if (!streamEl) { streamEl = bubble('assistant', ''); streamText = ''; }
        streamText += ev.text || '';
        streamEl.innerHTML = md(streamText);
        scrollToEnd();
        break;
      case 'assistant':
        if (streamEl) { streamEl.innerHTML = md(ev.content || streamText); }
        else if (ev.content) bubble('assistant', md(ev.content));
        streamEl = null; streamText = '';
        break;
      case 'tool':
        toolRow(ev.name, ev.ok, ev.input, ev.result);
        break;
      case 'error':
        bubble('error', esc(ev.message || 'Something went wrong.'));
        break;
      case 'queue':
        queued = Array.isArray(ev.items) ? ev.items : [];
        renderQueue();
        break;
      case 'done':
        setBusy(false);
        refreshList();
        break;
      default:
        break;
    }
  }

  function init(opts) {
    aero = opts.aero;
    root = document.querySelector('.ai-widget');
    if (!root) return;
    msgsEl = root.querySelector('.ai-messages');
    inputEl = root.querySelector('.ai-input');
    sendBtn = root.querySelector('.ai-send');
    stopBtn = root.querySelector('.ai-stop');
    pinBtn = root.querySelector('.ai-pin');
    listEl = root.querySelector('.ai-list');
    titleEl = root.querySelector('.ai-title');
    statusEl = root.querySelector('.ai-status');

    sendBtn.addEventListener('click', () => send());
    stopBtn.addEventListener('click', () => { if (current) aero.aiStop(current); });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(140, inputEl.scrollHeight) + 'px';
    });
    listEl.addEventListener('change', () => openConversation(listEl.value));
    root.querySelector('.ai-new').addEventListener('click', () => openConversation(null));
    root.querySelector('.ai-label').addEventListener('click', editLabel);
    titleEl.addEventListener('dblclick', editLabel);
    root.querySelector('.ai-delete').addEventListener('click', async () => {
      if (!current) return;
      await aero.aiDelete(current);
      current = null;
      await refreshList();
      renderConversation(null);
    });
    pinBtn.addEventListener('click', async () => {
      pinned = await aero.aiPin(!pinned);
      pinBtn.classList.toggle('on', pinned);
      pinBtn.title = pinned ? 'Pinned above other windows - click to release' : 'Keep above other windows while the assistant works';
    });
    msgsEl.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-ext]');
      if (a) { e.preventDefault(); aero.openExternal && aero.openExternal(a.href); }
    });

    aero.onAiEvent(onEvent);
    // "Ask AI" from the search bar / Spotlight lands here.
    aero.onAiAsk((text) => {
      root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      send(text);
    });

    refreshList();
    renderConversation(null);
  }

  window.AeroAi = { init };
})();
