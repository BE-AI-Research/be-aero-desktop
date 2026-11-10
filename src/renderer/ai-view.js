// AI chat widget: tabbed conversations, Markdown rendering with clickable
// links, streamed replies and tool rows, attachments, a per-conversation
// message queue, labels, a pin-on-top toggle, and the Tasks tab (scheduled
// prompts). Also the hand-off target for "Ask AI" from the search bar.
(function () {
  let aero = null;
  let root = null;
  let tabsEl, msgsEl, tasksEl, inputEl, sendBtn, stopBtn, pinBtn, listEl, titleEl, statusEl, attachEl, composeEl;

  const TASKS_KEY = 'tasks';
  let tabs = [];            // [{ key, convId|null, title, unread }]
  let activeKey = null;
  let tabSeq = 0;
  const live = new Map();   // convId -> { busy, streamText, streamEl, queued: [] }
  let pending = [];         // attachments chosen for the next message
  let pinned = false;
  let taskList = [];
  let editingTask = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const human = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const KIND_GLYPH = { image: '🖼', pdf: '📄', text: '📝', other: '📎' };

  // ------------------------------------------------------------ markdown
  function inline(s) {
    let h = esc(s);
    h = h.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    h = h.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
    h = h.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    // [text](url) first, then bare urls that are not already inside a tag
    h = h.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" data-ext title="${u}">${t}</a>`);
    h = h.replace(/(^|[^"'>=\w])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, (_, pre, u) => `${pre}<a href="${u}" data-ext>${u}</a>`);
    return h;
  }

  function renderTable(lines) {
    const rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())));
    if (!rows.length) return '';
    const head = rows.shift();
    return `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function blocks(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { const lvl = Math.min(6, m[1].length + 2); html += `<h${lvl}>${inline(m[2])}</h${lvl}>`; i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html += '<hr>'; i++; continue; }
      if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html += `<blockquote>${blocks(q.join('\n'))}</blockquote>`;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const t = [];
        while (i < lines.length && /\|/.test(lines[i])) { t.push(lines[i]); i++; }
        html += renderTable(t);
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          if (/^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) items[items.length - 1] += '\n' + lines[i].trim();
          else items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
          i++;
        }
        html += `<${ordered ? 'ol' : 'ul'}>${items.map((it) => `<li>${inline(it).replace(/\n/g, '<br>')}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
        continue;
      }
      const p = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) { p.push(lines[i]); i++; }
      html += `<p>${inline(p.join('\n')).replace(/\n/g, '<br>')}</p>`;
    }
    return html;
  }

  function md(text) {
    const parts = String(text || '').split(/```/);
    return parts.map((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n');
        const lang = nl >= 0 ? part.slice(0, nl).trim() : '';
        const body = nl >= 0 ? part.slice(nl + 1) : part;
        return `<div class="ai-code"><div class="ai-code-head"><span>${esc(lang || 'code')}</span><button class="ai-copy" title="Copy code">Copy</button></div><pre><code>${esc(body.replace(/\n$/, ''))}</code></pre></div>`;
      }
      return blocks(part);
    }).join('');
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  // ------------------------------------------------------------ dom helpers
  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  // One scroll per frame, however many bubbles were added; `soft` scrolls
  // only when the reader is already near the bottom (streaming text must not
  // yank someone reading earlier messages).
  let scrollRaf = 0;
  let scrollHard = false;
  const nearBottom = () => msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 120;
  const scrollToEnd = (soft) => {
    if (!soft) scrollHard = true;
    if (scrollRaf) return;
    const wasNear = nearBottom();
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (scrollHard || wasNear) msgsEl.scrollTop = msgsEl.scrollHeight;
      scrollHard = false;
    });
  };

  function bubble(role, html) {
    const b = el('div', `ai-msg ai-${role}`, msgsEl);
    b.innerHTML = html;
    scrollToEnd();
    return b;
  }

  // ---- Message actions: edit / resend / delete on your messages, delete on
  // replies. Each acts on the conversation on disk, then redraws it.
  const ICON = {
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 6.5l4 4" stroke="currentColor" stroke-width="1.8"/></svg>',
    resend: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function actionBtn(parent, kind, title) {
    const b = document.createElement('button');
    b.className = `ai-act ai-act-${kind}`;
    b.dataset.act = kind;
    b.title = title;
    b.innerHTML = ICON[kind === 'delete' || kind === 'delete-reply' ? 'trash' : kind];
    parent.appendChild(b);
    return b;
  }
  function userBubble(content, atts, index) {
    const b = bubble('user', chipsBlock(atts) + inline(content).replace(/\n/g, '<br>'));
    b.dataset.idx = String(index);
    b.dataset.raw = String(content || '');
    userActions(b, index);
    return b;
  }
  function userActions(b, index) {
    if (!b || b.querySelector(':scope > .ai-actions')) return;
    if (!b.dataset.raw) b.dataset.raw = b.textContent;
    const bar = document.createElement('div');
    bar.className = 'ai-actions';
    actionBtn(bar, 'edit', 'Edit and resend');
    const rs = actionBtn(bar, 'resend', 'Resend this message');
    rs.insertAdjacentHTML('beforeend', '<span class="ai-act-label">Resend</span>');
    actionBtn(bar, 'delete', 'Delete this message and its reply');
    b.appendChild(bar);
  }
  function replyActions(b, turn) {
    if (!b || turn < 0) return b;
    b.dataset.turn = String(turn);
    if (b.querySelector(':scope > .ai-actions')) return b;
    const bar = document.createElement('div');
    bar.className = 'ai-actions ai-actions-reply';
    actionBtn(bar, 'delete-reply', 'Delete this reply');
    b.appendChild(bar);
    return b;
  }
  function editInline(b) {
    if (b.classList.contains('editing')) return;
    const idx = Number(b.dataset.idx);
    const t = activeTab();
    b.classList.add('editing');
    const keep = b.innerHTML;
    b.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'ai-edit-box';
    ta.value = b.dataset.raw || '';
    b.appendChild(ta);
    const row = document.createElement('div');
    row.className = 'ai-edit-row';
    row.innerHTML = '<button class="btn ai-edit-save">Save &amp; resend</button><button class="btn ai-edit-cancel">Cancel</button>';
    b.appendChild(row);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight + 2) + 'px'; };
    grow(); ta.addEventListener('input', grow);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    const cancel = () => { b.classList.remove('editing'); b.innerHTML = keep; };
    const save = async () => {
      const text = ta.value.trim();
      if (!text) return;
      const r = await aero.aiResend(t.convId, idx, text);
      if (r && r.error && !r.conversationId) { bubble('error', esc(r.error)); cancel(); }
    };
    row.querySelector('.ai-edit-cancel').addEventListener('click', cancel);
    row.querySelector('.ai-edit-save').addEventListener('click', save);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  }
  async function onAction(btn) {
    const t = activeTab();
    if (!t || !t.convId) return;
    const lv = liveFor(t.convId);
    if (lv && lv.busy) return;
    const b = btn.closest('.ai-msg');
    const kind = btn.dataset.act;
    if (kind === 'edit') { editInline(b); return; }
    if (kind === 'resend') {
      // Drop what followed this message from view right away; the redraw follows.
      let n = b.nextElementSibling;
      while (n) { const nx = n.nextElementSibling; n.remove(); n = nx; }
      b.classList.remove('unanswered');
      const r = await aero.aiResend(t.convId, Number(b.dataset.idx));
      if (r && r.error && !r.conversationId) bubble('error', esc(r.error));
      return;
    }
    if (kind === 'delete') {
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm'); btn.title = 'Click again to delete';
        setTimeout(() => { btn.classList.remove('confirm'); btn.title = 'Delete this message and its reply'; }, 2500);
        return;
      }
      await aero.aiDeleteMessage(t.convId, Number(b.dataset.idx), 'turn');
    } else if (kind === 'delete-reply') {
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm'); btn.title = 'Click again to delete';
        setTimeout(() => { btn.classList.remove('confirm'); btn.title = 'Delete this reply'; }, 2500);
        return;
      }
      await aero.aiDeleteMessage(t.convId, Number(b.dataset.turn), 'reply');
    }
    const top = msgsEl.scrollTop;
    await renderConversation(t);
    msgsEl.scrollTop = top;
  }

  // ---- Streaming render: coalesce chunks to one Markdown render per frame.
  const streamQueue = new Set();
  let streamRaf = 0;
  function paintStream(lv) {
    if (!lv.streamEl || !lv.streamEl.isConnected) return;
    lv.streamEl.innerHTML = md(lv.streamText);
  }
  function scheduleStream(lv) {
    streamQueue.add(lv);
    if (streamRaf) return;
    streamRaf = requestAnimationFrame(() => {
      streamRaf = 0;
      for (const x of streamQueue) paintStream(x);
      streamQueue.clear();
      scrollToEnd(true);
    });
  }

  // Speaker button on a finished assistant reply: reads that reply aloud
  // with the Text to speech settings; a second click stops it.
  const SAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  let sayingEl = null;
  function finishReply(b, raw) {
    if (!b || !raw || !String(raw).trim()) return b;
    b.dataset.raw = String(raw);
    let btn = b.querySelector(':scope > .ai-say');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'ai-say';
      btn.title = 'Read aloud';
      btn.innerHTML = SAY_SVG;
      b.prepend(btn);
    }
    b.classList.add('has-say');
    return b;
  }
  function setSaying(b) {
    if (sayingEl && sayingEl !== b) { sayingEl.classList.remove('saying'); const x = sayingEl.querySelector('.ai-say'); if (x) x.title = 'Read aloud'; }
    sayingEl = b;
    if (b) { b.classList.add('saying'); const x = b.querySelector('.ai-say'); if (x) x.title = 'Stop reading'; }
  }
  // "Showing <title>." ahead of a reply that came with visuals, so speech
  // names what is on screen instead of reading it.
  function withVisuals(titles, text) {
    const t = (titles || []).filter(Boolean);
    if (!t.length) return text;
    return `Showing ${t.length === 1 ? t[0] : `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`}.\n\n${text}`;
  }
  // The visual cards between this reply and the question before it.
  function visualsBefore(b) {
    const out = [];
    for (let n = b.previousElementSibling; n && !n.classList.contains('ai-user'); n = n.previousElementSibling) {
      if (n.classList.contains('visual-card')) out.unshift((n.querySelector('.visual-title') || {}).textContent || 'a visual');
    }
    return out;
  }

  async function sayBubble(b) {
    if (sayingEl === b) { stopSpeaking(); setSaying(null); b.classList.remove('saying'); return; }
    stopSpeaking();
    setSaying(b);
    await speak(withVisuals(visualsBefore(b), b.dataset.raw || b.textContent), true);
    if (sayingEl === b) { b.classList.remove('saying'); const x = b.querySelector('.ai-say'); if (x) x.title = 'Read aloud'; sayingEl = null; }
  }

  // A visual made with show_visual renders as a card instead of a tool row.
  function visualFromResult(name, ok, result) {
    if (name !== 'show_visual' || !ok) return null;
    try { const r = JSON.parse(String(result || '')); return r && r.visual ? r : null; } catch { return null; }
  }
  function visualCard(v) {
    if (!window.AeroVisuals) return null;
    const card = AeroVisuals.card(v, aero);
    msgsEl.appendChild(card);
    scrollToEnd();
    return card;
  }

  function toolRow(name, ok, input, result, image) {
    const v = visualFromResult(name, ok, result);
    if (v) { visualCard(v); return; }
    const row = el('details', `ai-tool ${ok ? 'ok' : 'err'}`, msgsEl);
    const sum = el('summary', '', row);
    sum.textContent = `${ok ? '⚙' : '⚠'} ${name}`;
    el('div', 'ai-tool-body', row).textContent = `${JSON.stringify(input || {}, null, 1)}\n→ ${result || ''}`;
    if (image) { const im = el('img', 'ai-tool-shot', row); im.src = image; im.alt = 'screenshot'; }
    scrollToEnd();
  }

  function chipHtml(a, removable, i) {
    return `<span class="ai-chip" title="${esc(a.path || a.name)}">${KIND_GLYPH[a.kind] || KIND_GLYPH.other} ${esc(a.name)} <small>${human(a.size || 0)}</small>${removable ? ` <button class="chip-x" data-i="${i}" title="Remove">✕</button>` : ''}</span>`;
  }
  const chipsBlock = (atts) => (atts && atts.length ? `<div class="ai-chips">${atts.map((a) => chipHtml(a, false)).join('')}</div>` : '');

  function renderPending() {
    attachEl.innerHTML = pending.map((a, i) => chipHtml(a, true, i)).join('');
    attachEl.classList.toggle('hidden', !pending.length || activeKey === TASKS_KEY);
  }

  // ------------------------------------------------------------ tabs
  const activeTab = () => tabs.find((t) => t.key === activeKey) || null;
  const liveFor = (convId) => {
    if (!convId) return null;
    if (!live.has(convId)) live.set(convId, { busy: false, streamText: '', streamEl: null, queued: [] });
    return live.get(convId);
  };

  function persistTabs() {
    try {
      localStorage.setItem('ai.tabs', JSON.stringify({
        order: tabs.filter((t) => t.convId || t.key === TASKS_KEY).map((t) => (t.key === TASKS_KEY ? TASKS_KEY : t.convId)),
        active: (activeTab() || {}).convId || ((activeTab() || {}).key === TASKS_KEY ? TASKS_KEY : null)
      }));
    } catch { /* storage unavailable */ }
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const t of tabs) {
      const b = el('button', `ai-tab${t.key === activeKey ? ' active' : ''}${t.unread ? ' unread' : ''}${t.key === TASKS_KEY ? ' tasks-tab' : ''}`, tabsEl);
      b.dataset.key = t.key;
      const title = t.key === TASKS_KEY ? '⏱ Tasks' : (t.title || 'New chat');
      b.innerHTML = `<span class="ai-tab-title">${esc(title)}</span><span class="ai-tab-x" title="Close tab">✕</span>`;
      b.title = title;
      b.draggable = true;
    }
    const plus = el('button', 'ai-tab ai-tab-plus', tabsEl, '+');
    plus.title = 'New chat tab';
    plus.dataset.key = '+';
    persistTabs();
  }

  function newTab(convId, title, activate = true) {
    const existing = convId && tabs.find((t) => t.convId === convId);
    if (existing) { if (activate) activateTab(existing.key); return existing; }
    const t = { key: convId || `new${++tabSeq}`, convId: convId || null, title: title || (convId ? 'Conversation' : 'New chat'), unread: false };
    tabs.push(t);
    if (activate) activateTab(t.key); else renderTabs();
    return t;
  }

  async function activateTab(key) {
    activeKey = key;
    const t = activeTab();
    if (t) t.unread = false;
    renderTabs();
    const isTasks = key === TASKS_KEY;
    tasksEl.classList.toggle('hidden', !isTasks);
    msgsEl.classList.toggle('hidden', isTasks);
    composeEl.classList.toggle('hidden', isTasks);
    renderPending();
    titleEl.textContent = isTasks ? 'Scheduled tasks' : (t ? t.title : '');
    if (isTasks) { renderTasks(); syncBusy(); return; }
    await renderConversation(t);
    if (t.convId) loadContext(t.convId);
    listEl.value = t && t.convId ? t.convId : '';
    syncBusy();
  }

  function closeTab(key) {
    const i = tabs.findIndex((t) => t.key === key);
    if (i < 0) return;
    tabs.splice(i, 1);
    if (activeKey === key) {
      const next = tabs[i] || tabs[i - 1] || null;
      if (next) activateTab(next.key); else newTab(null, null, true);
    } else renderTabs();
  }

  async function loadContext(convId) {
    try {
      const c = await aero.aiContext(convId);
      if (c) { liveFor(convId).context = { tokens: c.tokens, budget: c.budget, compacted: !!c.compacted }; syncBusy(); }
    } catch { /* fine */ }
  }

  const HISTORY_PAGE = 80;

  // Draw messages[] whose first element is message number `offset`.
  function renderMessages(messages, offset, state) {
    messages.forEach((m, j) => {
      const i = offset + j;
      if (m.role === 'user') {
        state.turn = i;
        state.lastUser = userBubble(m.content, m.attachments, i);
        state.answered = false;
      } else if (m.role === 'assistant') {
        if (m.content) { replyActions(finishReply(bubble('assistant', md(m.content)), m.content), state.turn); state.answered = true; }
      } else if (m.role === 'tool') {
        for (const r of m.results || []) toolRow(r.name, !r.isError, null, String(r.content || '').slice(0, 400), r.images && r.images[0] ? `data:${r.images[0].mime};base64,${r.images[0].data}` : null);
      }
    });
  }

  // "Show earlier messages": load the previous page above, keeping the
  // reader's place.
  function earlierButton(tab, before) {
    const b = document.createElement('button');
    b.className = 'ai-earlier';
    b.textContent = `Show earlier messages (${before})`;
    msgsEl.prepend(b);
    b.addEventListener('click', async () => {
      const page = await aero.aiConversationView(tab.convId, HISTORY_PAGE, before);
      if (!page) return;
      const keep = msgsEl.scrollHeight - msgsEl.scrollTop;
      // Render into a detached holder, then move the nodes above the current first message.
      const holder = document.createElement('div');
      const realMsgs = msgsEl;
      msgsEl = holder;
      try { renderMessages(page.messages, page.start, { turn: -1, lastUser: null, answered: false }); } finally { msgsEl = realMsgs; }
      const first = b.nextSibling;
      for (const n of [...holder.childNodes]) msgsEl.insertBefore(n, first);
      b.remove();
      if (page.start > 0) earlierButton(tab, page.start);
      msgsEl.scrollTop = msgsEl.scrollHeight - keep;
    });
  }

  async function renderConversation(tab) {
    msgsEl.innerHTML = '';
    if (!tab) return;
    const conv = tab.convId ? await aero.aiConversationView(tab.convId, HISTORY_PAGE) : null;
    if (tab.convId && !conv) { tab.convId = null; tab.title = 'New chat'; }
    const hint = () => bubble('hint', 'Ask anything - or ask it to change a theme, open an app, read a web widget, search the web, or take notes. Attach files with 📎.');
    if (!conv) { hint(); renderTabs(); return; }
    tab.title = conv.title || 'Conversation';
    titleEl.textContent = tab.title;
    if (conv.start > 0) earlierButton(tab, conv.start);
    const state = { turn: -1, lastUser: null, answered: false };
    renderMessages(conv.messages || [], conv.start || 0, state);
    const lastUser = state.lastUser;
    const answered = state.answered;
    // A question with no answer (stopped, failed, server away): offer Resend.
    if (lastUser && !answered && !(liveFor(tab.convId) || {}).busy) lastUser.classList.add('unanswered');
    if (!(conv.messages || []).length) hint();
    const lv = liveFor(tab.convId);
    if (lv) {
      if (lv.streamText) lv.streamEl = bubble('assistant', md(lv.streamText));
      renderQueue(lv);
    }
    renderTabs();
  }

  function renderQueue(lv) {
    for (const e of msgsEl.querySelectorAll('.ai-queued')) e.remove();
    (lv ? lv.queued : []).forEach((text, i) => {
      const b = el('div', 'ai-msg ai-queued', msgsEl);
      b.innerHTML = `<span class="q-tag">queued</span> ${esc(text)} <button class="q-x" title="Remove from queue">✕</button>`;
      b.querySelector('.q-x').addEventListener('click', () => { const t = activeTab(); if (t && t.convId) aero.aiUnqueue(t.convId, i); });
    });
    scrollToEnd();
  }

  let voiceOffHint = false;   // shown in the status line after a one-shot dictation
  function contextLine(lv) {
    if (!lv || !lv.context || !lv.context.budget) return '';
    const pct = Math.min(999, Math.round((lv.context.tokens / lv.context.budget) * 100));
    return `context ${pct}%${lv.context.compacted ? ' · compacted' : ''}`;
  }

  function syncBusy() {
    const t = activeTab();
    const lv = t && t.convId ? liveFor(t.convId) : null;
    const on = !!(lv && lv.busy);
    root.classList.toggle('busy', on);
    stopBtn.hidden = !on;
    sendBtn.title = on ? 'Queue this message for after the current turn' : 'Send (Enter)';
    if (lv && lv.offline) statusEl.textContent = lv.offlineText || 'Server offline - will resume when it is back.';
    else if (on) statusEl.textContent = lv.stallText || lv.retryText || 'Thinking…';
    else if (voiceOffHint && !listening) statusEl.textContent = 'Voice off - click the microphone or press the voice hotkey to dictate again.';
    else statusEl.textContent = contextLine(lv);
  }

  // Connection dot in the header: probe on demand, poll while offline.
  let probeTimer = null;
  async function probe(quiet) {
    const dot = root.querySelector('.ai-conn');
    if (!dot) return null;
    if (!quiet) { dot.className = 'ai-conn wait'; dot.title = 'Checking the server…'; }
    let r = null;
    try { r = await aero.aiProbe(); } catch { r = null; }
    if (r && r.ok) { dot.className = 'ai-conn ok'; dot.title = `Connected${r.latencyMs != null ? ` (${r.latencyMs} ms)` : ''}${r.models ? ` · ${r.models} model${r.models === 1 ? '' : 's'}` : ''}`; }
    else { dot.className = 'ai-conn bad'; dot.title = r && r.error ? `Offline: ${r.error}` : 'Offline'; }
    return r;
  }
  function watchOffline(convId) {
    clearInterval(probeTimer);
    probeTimer = setInterval(async () => {
      const r = await probe(true);
      if (r && r.ok) {
        clearInterval(probeTimer); probeTimer = null;
        const lv = liveFor(convId);
        lv.offline = false; lv.offlineText = '';
        syncBusy();
        aero.aiResume(convId);
      }
    }, 8000);
  }

  async function refreshList() {
    const list = await aero.aiConversations();
    listEl.innerHTML = '';
    const opt0 = el('option', '', listEl, 'Open a conversation…');
    opt0.value = '';
    for (const c of list) { const o = el('option', '', listEl, c.title); o.value = c.id; }
    for (const t of tabs) { const c = list.find((x) => x.id === t.convId); if (c) t.title = c.title; }
    renderTabs();
    const t = activeTab();
    listEl.value = t && t.convId ? t.convId : '';
    if (t && t.key !== TASKS_KEY) titleEl.textContent = t.title;
  }

  // ------------------------------------------------------------ sending
  async function send(text) {
    let t = activeTab();
    if (!t || t.key === TASKS_KEY) t = newTab(null, null, true);
    const msg = String(text || inputEl.value || '').trim();
    const files = pending.slice();
    if (!msg && !files.length) return;
    if (/^\/compact\s*$/i.test(msg)) {
      inputEl.value = ''; inputEl.style.height = '';
      if (t.convId) { liveFor(t.convId).busy = true; syncBusy(); aero.aiCompact(t.convId); }
      return;
    }
    inputEl.value = ''; inputEl.style.height = '';
    pending = []; renderPending();
    clearTimeout(autoTimer); clearInterval(autoTick); autoTimer = null; autoTick = null;
    voiceOffHint = false;
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (msgsEl.querySelector('.ai-hint')) msgsEl.innerHTML = '';
    const lv = t.convId ? liveFor(t.convId) : null;
    if (!(lv && lv.busy)) bubble('user', chipsBlock(files) + inline(msg).replace(/\n/g, '<br>'));
    t.awaiting = true;   // only THIS tab may adopt the conversation id that comes back
    const res = await aero.aiSend(t.convId, msg, files);
    t.awaiting = false;
    if (res && res.conversationId && res.conversationId !== t.convId) {
      t.convId = res.conversationId;
      t.key = res.conversationId;
      activeKey = t.key;
      await refreshList();
    }
    if (res && res.error && !res.conversationId) bubble('error', esc(res.error));
    syncBusy();
  }

  function onEvent(ev) {
    if (!ev || !ev.conversationId) return;
    const convId = ev.conversationId;
    let tab = tabs.find((t) => t.convId === convId);
    const t0 = activeTab();
    if (!tab && ev.type === 'user' && t0 && !t0.convId && t0.awaiting) {
      // The active empty tab that sent this message receives its conversation id.
      tab = t0; tab.convId = convId; tab.key = convId; activeKey = convId;
    }
    if (!tab && ev.type === 'user') tab = newTab(convId, ev.title || 'Conversation', false);   // task runs, Spotlight asks
    if (!tab) return;
    const lv = liveFor(convId);
    const isActive = tab.key === activeKey;
    switch (ev.type) {
      case 'user':
        lv.busy = true;
        lv.turn = Number.isInteger(ev.index) ? ev.index : lv.turn;
        if (isActive && Number.isInteger(ev.index)) {
          if (ev.replay) userBubble(ev.content, ev.attachments, ev.index);
          else {
            const pending = [...msgsEl.querySelectorAll('.ai-msg.ai-user:not([data-idx])')].pop();
            if (pending) { pending.dataset.idx = String(ev.index); userActions(pending, ev.index); }
          }
        }
        if (ev.title) { tab.title = ev.title; if (isActive) titleEl.textContent = ev.title; }
        if (!isActive) tab.unread = true;
        break;
      case 'delta':
        lv.streamText += ev.text || '';
        if (isActive) {
          if (!lv.streamEl) lv.streamEl = bubble('assistant', '');
          scheduleStream(lv);
        }
        break;
      case 'assistant':
        if (isActive) {
          if (lv.streamEl) { lv.streamEl.innerHTML = md(ev.content || lv.streamText); replyActions(finishReply(lv.streamEl, ev.content || lv.streamText), Number.isInteger(lv.turn) ? lv.turn : -1); }
          else if (ev.content) replyActions(finishReply(bubble('assistant', md(ev.content)), ev.content), Number.isInteger(lv.turn) ? lv.turn : -1);
        }
        if (ev.content && (!ev.toolCalls || !ev.toolCalls.length)) { speak(withVisuals(lv.visuals, ev.content)); lv.visuals = []; }
        lv.streamEl = null; lv.streamText = '';
        if (!isActive) tab.unread = true;
        break;
      case 'tool':
        if (isActive) toolRow(ev.name, ev.ok, ev.input, ev.result, ev.image);
        { const v = visualFromResult(ev.name, ev.ok, ev.result); if (v) (lv.visuals = lv.visuals || []).push(v.title || 'a visual'); }
        break;
      case 'queue':
        lv.queued = Array.isArray(ev.items) ? ev.items : [];
        if (isActive) renderQueue(lv);
        break;
      case 'error':
        if (isActive) bubble('error', esc(ev.message || 'Something went wrong.'));
        break;
      case 'thinking':
        lv.retryText = 'Thinking…';
        if (isActive) syncBusy();
        break;
      case 'stall':
        lv.stallText = ev.stage === 1
          ? `Waiting for the model: no output for ${ev.seconds} s (loading, re-reading the conversation, or queued behind another request).`
          : ev.stage === 2 ? `Still waiting for the model after ${ev.seconds} s. Stop cancels; nothing is lost.` : '';
        if (isActive) syncBusy();
        break;
      case 'retry':
        // Whatever streamed before the failure is discarded; the call is
        // being made again with the same state.
        lv.streamText = '';
        if (lv.streamEl) { lv.streamEl.innerHTML = ''; }
        lv.retryText = `Backend error - retrying in ${Math.ceil((ev.delayMs || 0) / 1000)} s (${ev.attempt}/${ev.max}); nothing is lost.`;
        if (isActive) statusEl.textContent = lv.retryText;
        break;
      case 'notice':
        if (isActive) bubble('notice', esc(ev.text || ''));
        break;
      case 'blocked':
        // Another model holds the server while ours waits: one click
        // unloads it and sends the request again.
        if (isActive) {
          const others = (ev.others || []).join(', ');
          const n = bubble('notice ai-blocked', `${esc(ev.model || 'The model')} is waiting to load: ${esc(others)} is holding the server. `);
          const btn = document.createElement('button');
          btn.className = 'btn ai-evict';
          btn.textContent = `Unload ${(ev.others || []).length > 1 ? 'them' : (ev.others || [''])[0].split('/').pop()} and continue`;
          btn.title = `Unloads ${others} from the server (other programs using it will reload it when they next need it), then sends this request again`;
          btn.addEventListener('click', async () => {
            btn.disabled = true; btn.textContent = 'Unloading…';
            const r = await aero.aiEvictBlocking(convId).catch((e) => ({ error: String(e) }));
            btn.textContent = r && r.ok ? 'Unloaded' : `Could not unload${r && r.error ? `: ${r.error}` : ''}`;
          });
          n.appendChild(btn);
        }
        break;
      case 'context':
        lv.context = { tokens: ev.tokens, budget: ev.budget, compacted: !!ev.compacted };
        break;
      case 'offline':
        lv.offline = true;
        lv.offlineText = `${ev.message || 'Server offline.'} Waiting for it to come back - your message is kept.`;
        probe(true);
        watchOffline(convId);
        break;
      case 'done':
        if (lv.streamEl && lv.streamText) paintStream(lv);
        lv.busy = false; lv.streamEl = null; lv.streamText = ''; lv.retryText = ''; lv.stallText = '';
        if (!isActive) tab.unread = true;
        else if (ev.stopped || ev.error) {
          // A question that got no answer keeps a Resend button.
          const lastUser = [...msgsEl.querySelectorAll('.ai-msg.ai-user[data-idx]')].pop();
          if (lastUser && !(lastUser.nextElementSibling && lastUser.parentElement.querySelector('.ai-msg.ai-assistant[data-turn="' + lastUser.dataset.idx + '"]'))) lastUser.classList.add('unanswered');
        }
        refreshList();
        break;
      default: break;
    }
    renderTabs();
    if (isActive) syncBusy();
  }

  // ------------------------------------------------------------ labels
  function editLabel() {
    const t = activeTab();
    if (!t || !t.convId || titleEl.isContentEditable) return;
    const before = titleEl.textContent;
    titleEl.contentEditable = 'true';
    titleEl.classList.add('editing');
    titleEl.focus();
    document.getSelection().selectAllChildren(titleEl);
    const finish = async (save) => {
      titleEl.contentEditable = 'false';
      titleEl.classList.remove('editing');
      const next = titleEl.textContent.trim();
      if (save && next && next !== before) { await aero.aiRename(t.convId, next); await refreshList(); }
      else titleEl.textContent = before;
    };
    titleEl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    titleEl.onblur = () => finish(true);
  }

  // ------------------------------------------------------------ tasks
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const when = (ts) => {
    if (!ts) return '-';
    const d = ts - Date.now();
    if (Math.abs(d) < 60000) return 'now';
    const abs = Math.abs(d);
    const v = abs < 3600000 ? `${Math.round(abs / 60000)}m` : abs < 86400000 ? `${Math.round(abs / 3600000)}h` : `${Math.round(abs / 86400000)}d`;
    return d < 0 ? `${v} ago` : `in ${v}`;
  };

  // Presets fill the "When" field; anything BE-Code's forms accept can be typed.
  const WHEN_PRESETS = [
    ['', 'Quick pick...'], ['in 20m', 'In 20 minutes'], ['in 1h', 'In an hour'], ['at 09:00', 'Once at 9:00'],
    ['every 30m', 'Every 30 minutes'], ['every 2h', 'Every 2 hours'], ['daily 09:00', 'Every day at 9:00'],
    ['weekdays 08:30', 'Weekdays at 8:30'], ['mon,thu 14:30', 'Mon & Thu at 14:30'], ['sat,sun 10:00', 'Weekends at 10:00'],
    ['0 */4 * * *', 'Cron: every 4 hours']
  ];

  function taskForm(task) {
    const t = task || { name: '', prompt: '', when: 'daily 09:00', conversationMode: 'shared', permission: 'inherit' };
    return `<form class="ai-task-form">
      <input name="name" placeholder="Task name" value="${esc(t.name)}" required>
      <textarea name="prompt" rows="3" placeholder="What should the assistant do? e.g. 'Summarize my scratchpad and write a to-do list for today'" required>${esc(t.prompt)}</textarea>
      <div class="row">
        <input name="when" value="${esc(t.when || '')}" placeholder="When: daily 09:00 · every 2h · in 20m · weekdays 08:30" spellcheck="false" required>
        <select name="preset" title="Common times">${WHEN_PRESETS.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>
      </div>
      <div class="ai-when-preview hint-text"></div>
      <div class="row">
        <select name="model" title="Model this task runs on" data-current="${esc(t.model || '')}"><option value="">Model: default for tasks</option>${t.model ? `<option value="${esc(t.model)}" selected>Model: ${esc(t.model)}</option>` : ''}</select>
        <label class="check" title="Say the result on your speakers when the task finishes"><input type="checkbox" name="readAloud"${t.readAloud ? ' checked' : ''}> Read the result aloud</label>
      </div>
      <div class="row">
        <select name="conversationMode" title="Where the results go">
          <option value="shared"${t.conversationMode !== 'new' ? ' selected' : ''}>One running conversation for this task</option>
          <option value="new"${t.conversationMode === 'new' ? ' selected' : ''}>A fresh conversation each run</option>
        </select>
        <select name="permission" title="What it may change while you are away">
          <option value="inherit"${!t.permission || t.permission === 'inherit' ? ' selected' : ''}>Permissions: as in Settings (ask = read-only)</option>
          <option value="allow"${t.permission === 'allow' ? ' selected' : ''}>Permissions: allow changes (autonomous)</option>
          <option value="deny"${t.permission === 'deny' ? ' selected' : ''}>Permissions: read-only</option>
        </select>
      </div>
      <div class="ai-task-error"></div>
      <div class="row"><button type="submit" class="btn">${t.id ? 'Save' : 'Add task'}</button><button type="button" class="btn ai-task-cancel">Cancel</button></div>
    </form>`;
  }

  function readForm(form, base) {
    const f = new FormData(form);
    const out = { ...(base || {}), name: String(f.get('name')).trim(), prompt: String(f.get('prompt')).trim(), when: String(f.get('when')).trim(), conversationMode: f.get('conversationMode'), permission: f.get('permission'), model: String(f.get('model') || ''), readAloud: f.get('readAloud') === 'on' };
    delete out.schedule;
    for (const k of ['summary', 'nextRun', 'running', 'queued', 'enabled', 'lastStatus', 'whenError']) delete out[k];
    return out;
  }

  const fmtTime = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toDateString() === d.toDateString();
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay ? `today ${hm}` : tomorrow ? `tomorrow ${hm}` : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${hm}`;
  };

  function renderTasks() {
    if (activeKey !== TASKS_KEY) return;
    tasksEl.innerHTML = '';
    const head = el('div', 'ai-tasks-head', tasksEl);
    head.innerHTML = `<span>${taskList.length ? `${taskList.length} task${taskList.length === 1 ? '' : 's'}` : 'No scheduled tasks yet - prompts that run on their own.'}</span><button class="btn ai-task-new">+ New task</button>`;
    head.querySelector('.ai-task-new').addEventListener('click', () => { editingTask = {}; renderTasks(); });
    if (editingTask) {
      const wrap = el('div', 'ai-task-edit', tasksEl);
      wrap.innerHTML = taskForm(editingTask.id ? editingTask : null);
      const form = wrap.querySelector('form');
      const whenIn = form.querySelector('[name=when]');
      const preview = form.querySelector('.ai-when-preview');
      const errEl = form.querySelector('.ai-task-error');
      let pv = 0;
      const showPreview = async () => {
        const mine = ++pv;
        const r = await aero.aiTaskPreview(whenIn.value);
        if (mine !== pv) return;
        preview.classList.toggle('bad', !r.ok);
        preview.textContent = r.ok ? `Next: ${r.times.map(fmtTime).join(' · ')}` : (r.error || 'Not a time I know');
      };
      whenIn.addEventListener('input', showPreview);
      // Fill the model list from the server (kept for the session).
      const modelSel = form.querySelector('[name=model]');
      (async () => {
        // Fresh each time the form opens: the task provider may have changed.
        let models = [];
        try { const r = await aero.aiModels('task'); models = (r && r.models) || []; } catch { /* offline */ }
        window.__aeroModels = models;
        const cur = modelSel.dataset.current;
        const st = await aero.getSettings();
        const ai = st.ai || {};
        const def = ai.taskModel || (ai.taskProvider ? '' : ai.model) || '';
        modelSel.options[0].textContent = `Model: default for tasks${def ? ` (${def})` : ''}`;
        for (const m of window.__aeroModels) { if (m === cur) continue; const o = document.createElement('option'); o.value = m; o.textContent = `Model: ${m}`; modelSel.appendChild(o); }
        modelSel.value = cur;
      })();
      form.querySelector('[name=preset]').addEventListener('change', (e) => { if (e.target.value) { whenIn.value = e.target.value; e.target.value = ''; showPreview(); } });
      showPreview();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await aero.aiTaskSave(readForm(form, editingTask.id ? editingTask : {}));
        if (r && r.error) { errEl.textContent = r.error; return; }
        editingTask = null;
        renderTasks();
      });
      form.querySelector('.ai-task-cancel').addEventListener('click', () => { editingTask = null; renderTasks(); });
    }
    const list = el('div', 'ai-task-list', tasksEl);
    for (const t of taskList) {
      const state = t.state || (t.enabled === false ? 'paused' : 'active');
      const row = el('div', `ai-task ${state}${t.running ? ' running' : ''}`, list);
      const status = t.running ? 'running now' : t.queued ? 'waiting to run'
        : state === 'done' ? 'done' : state === 'paused' ? (t.failures >= 3 ? `paused after ${t.failures} failures` : 'paused')
        : t.nextRun ? `next ${fmtTime(t.nextRun)}` : 'not scheduled';
      const last = t.lastOutcome ? ` · last: ${t.lastOutcome}` : '';
      const perm = (t.permission === 'allow' ? ' · autonomous' : t.permission === 'deny' ? ' · read-only' : '') + (t.model ? ` · ${t.model.split('/').pop()}` : '') + (t.readAloud ? ' · read aloud' : '');
      row.innerHTML = `<button class="icon-btn t-state" title="${state === 'active' ? 'Pause' : 'Resume'}">${state === 'active' ? '⏸' : '▶'}</button>
        <div class="ai-task-main"><div class="ai-task-name">${esc(t.name)}${t.createdBy === 'agent' ? ' <span class="ai-task-by" title="Created by the assistant">AI</span>' : ''}</div>
        <div class="ai-task-meta">${esc(t.summary || t.when || '')} · ${esc(status)}${esc(last)}${perm}</div>
        ${t.whenError ? `<div class="ai-task-meta bad">${esc(t.whenError)}</div>` : ''}</div>
        <div class="ai-task-actions"><button class="icon-btn t-run" title="Run now"${t.running ? ' disabled' : ''}>⚡</button><button class="icon-btn t-open" title="Open its conversation"${t.conversationId ? '' : ' disabled'}>💬</button><button class="icon-btn t-edit" title="Edit">✎</button><button class="icon-btn t-del" title="Delete">🗑</button></div>`;
      row.querySelector('.t-state').addEventListener('click', () => aero.aiTaskToggle(t.id, state !== 'active'));
      row.querySelector('.t-run').addEventListener('click', () => aero.aiTaskRun(t.id));
      row.querySelector('.t-open').addEventListener('click', () => { if (t.conversationId) newTab(t.conversationId, `Task: ${t.name}`, true); });
      row.querySelector('.t-edit').addEventListener('click', () => { editingTask = t; renderTasks(); });
      const del = row.querySelector('.t-del');
      del.addEventListener('click', () => {
        if (!del.classList.contains('confirm')) { del.classList.add('confirm'); del.title = 'Click again to delete'; setTimeout(() => { del.classList.remove('confirm'); del.title = 'Delete'; }, 2500); return; }
        aero.aiTaskDelete(t.id);
      });
    }
  }

  // ------------------------------------------------------------ init
  async function init(opts) {
    aero = opts.aero;
    root = document.querySelector('.ai-widget');
    if (!root) return;
    tabsEl = root.querySelector('.ai-tabs');
    msgsEl = root.querySelector('.ai-messages');
    tasksEl = root.querySelector('.ai-tasks');
    inputEl = root.querySelector('.ai-input');
    sendBtn = root.querySelector('.ai-send');
    stopBtn = root.querySelector('.ai-stop');
    pinBtn = root.querySelector('.ai-pin');
    listEl = root.querySelector('.ai-list');
    titleEl = root.querySelector('.ai-title');
    statusEl = root.querySelector('.ai-status');
    attachEl = root.querySelector('.ai-attachments');
    composeEl = root.querySelector('.ai-compose');

    sendBtn.addEventListener('click', () => send());
    stopBtn.addEventListener('click', () => { const t = activeTab(); if (t && t.convId) aero.aiStop(t.convId); });
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    inputEl.addEventListener('input', () => { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(140, inputEl.scrollHeight) + 'px'; });
    listEl.addEventListener('change', () => { if (listEl.value) newTab(listEl.value, listEl.options[listEl.selectedIndex].textContent, true); });
    root.querySelector('.ai-new').addEventListener('click', () => newTab(null, null, true));
    root.querySelector('.ai-label').addEventListener('click', editLabel);
    root.querySelector('.ai-min').addEventListener('click', () => aero.setSettings({ ai: { minimized: true } }));
    titleEl.addEventListener('dblclick', editLabel);
    root.querySelector('.ai-delete').addEventListener('click', async () => {
      const t = activeTab();
      if (!t || t.key === TASKS_KEY) return;
      if (t.convId) { await aero.aiDelete(t.convId); live.delete(t.convId); }
      closeTab(t.key);
      await refreshList();
    });
    root.querySelector('.ai-tasks-btn').addEventListener('click', async () => {
      if (!tabs.some((t) => t.key === TASKS_KEY)) tabs.push({ key: TASKS_KEY, convId: null, title: 'Tasks', unread: false });
      taskList = await aero.aiTasks();
      activateTab(TASKS_KEY);
    });
    pinBtn.addEventListener('click', async () => {
      pinned = await aero.aiPin(!pinned);
      pinBtn.classList.toggle('on', pinned);
      pinBtn.title = pinned ? 'Pinned above other windows - click to release' : 'Keep above other windows while the assistant works';
    });
    autoBtn = root.querySelector('.ai-autosend');
    if (autoBtn) { autoBtn.addEventListener('click', toggleAutoSend); syncAutoBtn(); }
    inputEl.addEventListener('keydown', () => { if (autoTimer) armAutoSend(); });
    if (aero.onAiSpeak) aero.onAiSpeak((text) => speak(text, true));
    if (aero.onVoiceHotkey) aero.onVoiceHotkey(() => {
      // Dictation lands in the active conversation (a fresh tab when the
      // Tasks tab is in front).
      const t = activeTab();
      if (!listening && (!t || t.key === TASKS_KEY)) newTab(null, null, true);
      toggleMic();
    });
    micBtn = root.querySelector('.ai-mic');
    if (micBtn) {
      micBtn.addEventListener('click', toggleMic);
      if (aero.onAiVoice) aero.onAiVoice(onVoice);
      if (aero.aiVoiceAvailable) aero.aiVoiceAvailable().then((v) => { if (!(v && v.stt)) { micBtn.title = `Voice input unavailable: ${v && v.reason || ''}`; micBtn.classList.add('off'); } }).catch(() => {});
    }
    root.querySelector('.ai-attach').addEventListener('click', async () => {
      const picked = await aero.aiPickFiles();
      for (const a of picked || []) if (!pending.some((p) => p.path === a.path)) pending.push(a);
      renderPending(); inputEl.focus();
    });
    attachEl.addEventListener('click', (e) => { const x = e.target.closest('.chip-x'); if (!x) return; pending.splice(Number(x.dataset.i), 1); renderPending(); });
    tabsEl.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('.ai-tab');
      if (!tabBtn) return;
      if (tabBtn.dataset.key === '+') { newTab(null, null, true); return; }
      if (e.target.closest('.ai-tab-x')) { closeTab(tabBtn.dataset.key); return; }
      activateTab(tabBtn.dataset.key);
    });
    tabsEl.addEventListener('auxclick', (e) => { const b = e.target.closest('.ai-tab'); if (b && e.button === 1 && b.dataset.key !== '+') closeTab(b.dataset.key); });
    // Drag to reorder.
    let dragKey = null;
    tabsEl.addEventListener('dragstart', (e) => {
      const b = e.target.closest('.ai-tab');
      if (!b || b.dataset.key === '+') { e.preventDefault(); return; }
      dragKey = b.dataset.key;
      b.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragKey); } catch { /* some engines require data */ }
    });
    tabsEl.addEventListener('dragover', (e) => {
      if (!dragKey) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      for (const x of tabsEl.querySelectorAll('.drop-before, .drop-after')) x.classList.remove('drop-before', 'drop-after');
      const over = e.target.closest('.ai-tab');
      if (!over || over.dataset.key === dragKey || over.dataset.key === '+') return;
      const r = over.getBoundingClientRect();
      over.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
    });
    tabsEl.addEventListener('drop', (e) => {
      if (!dragKey) return;
      e.preventDefault();
      const over = e.target.closest('.ai-tab');
      const from = tabs.findIndex((t) => t.key === dragKey);
      if (from >= 0 && over && over.dataset.key !== '+' && over.dataset.key !== dragKey) {
        const [moved] = tabs.splice(from, 1);
        let to = tabs.findIndex((t) => t.key === over.dataset.key);
        const r = over.getBoundingClientRect();
        if (e.clientX >= r.left + r.width / 2) to += 1;
        tabs.splice(to, 0, moved);
      }
      dragKey = null;
      renderTabs();
    });
    tabsEl.addEventListener('dragend', () => { dragKey = null; renderTabs(); });
    msgsEl.addEventListener('click', async (e) => {
      const a = e.target.closest('a[data-ext]');
      if (a) { e.preventDefault(); aero.openExternal(a.href); return; }
      const act = e.target.closest('.ai-act');
      if (act) { e.stopPropagation(); onAction(act); return; }
      const say = e.target.closest('.ai-say');
      if (say) { e.stopPropagation(); sayBubble(say.closest('.ai-msg')); return; }
      const c = e.target.closest('.ai-copy');
      if (c) { const code = c.closest('.ai-code').querySelector('code').textContent; c.textContent = (await copyText(code)) ? 'Copied' : 'Failed'; setTimeout(() => { c.textContent = 'Copy'; }, 1200); }
    });

    aero.onAiEvent(onEvent);
    aero.onAiAsk((text) => { root.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); send(text); });
    const conn = root.querySelector('.ai-conn');
    if (conn) { conn.addEventListener('click', () => probe(false)); setTimeout(() => probe(true), 1500); }
    aero.onAiTasks((list) => { taskList = list || []; renderTasks(); });

    // Restore tabs; fall back to one fresh chat.
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('ai.tabs') || 'null'); } catch { saved = null; }
    const existing = await aero.aiConversations();
    const titles = new Map(existing.map((c) => [c.id, c.title]));
    const order = (saved && (saved.order || [...(saved.open || []), ...(saved.tasks ? [TASKS_KEY] : [])])) || [];
    for (const id of order) {
      if (id === TASKS_KEY) tabs.push({ key: TASKS_KEY, convId: null, title: 'Tasks', unread: false });
      else if (titles.has(id)) tabs.push({ key: id, convId: id, title: titles.get(id), unread: false });
    }
    if (!tabs.some((t) => t.key !== TASKS_KEY)) tabs.unshift({ key: `new${++tabSeq}`, convId: null, title: 'New chat', unread: false });
    const act = saved && saved.active && tabs.find((t) => (saved.active === TASKS_KEY ? t.key === TASKS_KEY : t.convId === saved.active));
    taskList = await aero.aiTasks().catch(() => []);
    await refreshList();
    await activateTab(act ? act.key : tabs[0].key);
  }

  // ------------------------------------------------------------ voice
  // The microphone is captured here (so the user chooses the device) and
  // streamed to main as 16 kHz mono PCM; main runs the offline recognizer.
  // Replies come back from main as WAV and play on the chosen speaker.
  const PCM_RATE = 16000;
  let voiceCfg = {};
  let listening = false;
  let micBtn = null;
  let capture = null;          // { stream, ctx, node, src }
  let player = null;           // current <audio> for a spoken reply
  let speakQueue = Promise.resolve();

  function setVoice(cfg) {
    voiceCfg = cfg || {};
    if (!voiceCfg.speak) stopSpeaking();
    syncAutoBtn();
    if (!voiceCfg.autoSend) cancelAutoSend();
  }

  // ---- Auto send: after the dictated text has been quiet for
  // autoSendDelay seconds, send it. Speech or typing restarts the clock.
  let autoBtn = null;
  let autoTimer = null;
  let autoTick = null;
  let autoDeadline = 0;
  const autoDelayMs = () => Math.max(1, Math.min(30, Number(voiceCfg.autoSendDelay) || 3)) * 1000;
  function syncAutoBtn() {
    if (!autoBtn) return;
    const on = !!voiceCfg.autoSend;
    autoBtn.classList.toggle('on', on);
    autoBtn.title = on
      ? `Auto send: on - dictated messages send after ${autoDelayMs() / 1000} s of silence (click to turn off)`
      : 'Auto send: off - click to send dictated messages automatically';
  }
  function cancelAutoSend() {
    clearTimeout(autoTimer); clearInterval(autoTick); autoTimer = null; autoTick = null;
    if (listening && statusEl && /^Sending in/.test(statusEl.textContent)) statusEl.textContent = 'Listening…';
  }
  function armAutoSend() {
    if (!voiceCfg.autoSend || !inputEl.value.trim()) return;
    cancelAutoSend();
    autoDeadline = Date.now() + autoDelayMs();
    const show = () => { const s = Math.max(0, Math.ceil((autoDeadline - Date.now()) / 1000)); statusEl.textContent = `Sending in ${s} s… (keep talking or type to wait)`; };
    show();
    autoTick = setInterval(show, 250);
    autoTimer = setTimeout(() => {
      clearInterval(autoTick); autoTick = null; autoTimer = null;
      if (inputEl.value.trim()) { send(); if (listening) statusEl.textContent = 'Listening…'; }
    }, autoDelayMs());
  }
  async function toggleAutoSend() {
    const on = !voiceCfg.autoSend;
    voiceCfg = { ...voiceCfg, autoSend: on };
    syncAutoBtn();
    if (!on) cancelAutoSend(); else armAutoSend();
    await aero.setSettings({ ai: { voice: { autoSend: on } } });
  }

  // Float32 at any sample rate -> Int16 at 16 kHz (linear interpolation).
  function toPcm16(float32, fromRate) {
    if (fromRate === PCM_RATE) {
      const out = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) { const v = Math.max(-1, Math.min(1, float32[i])); out[i] = v < 0 ? v * 0x8000 : v * 0x7FFF; }
      return out;
    }
    const ratio = fromRate / PCM_RATE;
    const n = Math.floor(float32.length / ratio);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(float32.length - 1, i0 + 1);
      const v = Math.max(-1, Math.min(1, float32[i0] + (float32[i1] - float32[i0]) * (pos - i0)));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7FFF;
    }
    return out;
  }

  async function openMic(onChunk) {
    const constraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } };
    if (voiceCfg.micId) constraints.audio.deviceId = { exact: voiceCfg.micId };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
    catch (err) {
      if (voiceCfg.micId) { delete constraints.audio.deviceId; stream = await navigator.mediaDevices.getUserMedia(constraints); }   // the saved device is gone
      else throw err;
    }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      const f = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
      onChunk(toPcm16(f, ctx.sampleRate), Math.sqrt(sum / f.length));
    };
    src.connect(node);
    node.connect(ctx.destination);   // a ScriptProcessor only runs while connected; the gain is muted below
    const mute = ctx.createGain(); mute.gain.value = 0;
    node.disconnect(); node.connect(mute); mute.connect(ctx.destination);
    return { stream, ctx, node, src, mute };
  }

  function closeMic(c) {
    if (!c) return;
    try { c.node.disconnect(); c.src.disconnect(); c.mute.disconnect(); } catch { /* fine */ }
    try { c.stream.getTracks().forEach((t) => t.stop()); } catch { /* fine */ }
    try { c.ctx.close(); } catch { /* fine */ }
  }

  // Short confirmation tones (rising = listening, falling = off), so the
  // hotkey gives feedback even when the chat is out of sight.
  let cueCtx = null;
  function cue(on) {
    try {
      if (!cueCtx) cueCtx = new AudioContext();
      const t0 = cueCtx.currentTime;
      const notes = on ? [660, 990] : [880, 520];
      notes.forEach((f, i) => {
        const o = cueCtx.createOscillator();
        const g = cueCtx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        const s = t0 + i * 0.09;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.18, s + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.085);
        o.connect(g); g.connect(cueCtx.destination);
        o.start(s); o.stop(s + 0.09);
      });
    } catch { /* no audio output */ }
  }

  function setListening(on) {
    if (on !== listening) cue(on);
    listening = on;
    if (micBtn) {
      micBtn.classList.toggle('on', on);
      micBtn.style.setProperty('--level', '0');
      micBtn.title = on ? 'Listening - click to stop' : 'Voice input (offline speech recognition)';
    }
  }

  function onVoice(ev) {
    if (!ev) return;
    if (ev.type === 'loading') { if (listening) statusEl.textContent = 'Loading Whisper… (speak - nothing is lost)'; return; }
    if (ev.type === 'ready') { if (listening && !autoTimer) statusEl.textContent = 'Listening…'; return; }
    if (ev.type === 'working') { if (listening && !autoTimer) statusEl.textContent = 'Transcribing…'; return; }
    if (ev.type === 'final' && ev.text) {
      const cur = inputEl.value;
      inputEl.value = (cur ? cur.replace(/\s*$/, ' ') : '') + ev.text;
      inputEl.dispatchEvent(new Event('input'));
      // One phrase per activation unless the user asked to keep listening:
      // the mic turns itself off and must be re-activated.
      const offHint = () => { voiceOffHint = true; if (!autoTimer) syncBusy(); };
      if (voiceCfg.autoSend) armAutoSend();
      if (!voiceCfg.continuous && listening) stopMic().then(offHint);
      else if (listening && !autoTimer) statusEl.textContent = 'Listening…';
      return;
    }
    if (ev.type === 'error') bubble('error', esc(ev.text || 'Voice input failed.'));
    if (ev.type === 'end' || ev.type === 'error') { stopMic(); }
  }

  async function startMic() {
    if (listening) return;
    voiceOffHint = false;
    if (voiceCfg.interrupt !== false) stopSpeaking();
    statusEl.textContent = 'Starting the microphone…';
    try {
      capture = await openMic((pcm, rms) => {
        if (!listening) return;
        aero.aiVoiceFeed(new Uint8Array(pcm.buffer));
        if (micBtn) micBtn.style.setProperty('--level', String(Math.min(1, rms * 6)));
        // Talking again pushes the auto-send deadline out.
        if (autoTimer && rms > 0.03) armAutoSend();
      });
    } catch (err) {
      bubble('error', `Microphone unavailable: ${esc(err && err.message || err)}`);
      statusEl.textContent = '';
      return;
    }
    setListening(true);
    statusEl.textContent = 'Listening…';
    const ok = await aero.aiVoiceStart();
    if (!ok) stopMic();
  }

  async function stopMic() {
    if (capture) { closeMic(capture); capture = null; }
    // A pending auto send still fires once the last phrase lands.
    if (!autoTimer) cancelAutoSend();
    const was = listening;
    setListening(false);
    if (was) { try { await aero.aiVoiceStop(); } catch { /* fine */ } }
    syncBusy();
  }

  function toggleMic() { return listening ? stopMic() : startMic(); }

  // Reply text -> plain spoken sentences (src/shared/speech.js): symbols,
  // abbreviations, units, acronyms, lists, tables, code and links.
  function speakable(text) {
    if (window.AeroSpeech) return AeroSpeech.toSpeech(text, 4000);
    return String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_#>|~`]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
  }

  function stopSpeaking() {
    speakQueue = Promise.resolve();
    speakGen++;
    if (sayingEl) { sayingEl.classList.remove('saying'); const x = sayingEl.querySelector('.ai-say'); if (x) x.title = 'Read aloud'; sayingEl = null; }
    if (player) { try { player.pause(); } catch { /* fine */ } player = null; }
    if (window.speechSynthesis) speechSynthesis.cancel();
  }

  // Split for speech: sentences, merged up to ~240 characters, so the first
  // words play while the rest is still being synthesized.
  function speechChunks(t) {
    const parts = String(t).match(/[^.!?;:\n]+[.!?;:]*\s*|\n+/g) || [t];
    const out = [];
    let cur = '';
    for (const p of parts) {
      if ((cur + p).length > 240 && cur) { out.push(cur.trim()); cur = ''; }
      cur += p;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.filter(Boolean);
  }
  const synthOpts = () => ({ voice: voiceCfg.voiceName || '', rate: Number(voiceCfg.rate) || 1, pitch: Number(voiceCfg.pitch) || 0 });
  let ttsErrorShown = '';

  // Play rendered WAVs on the configured speaker, synthesizing the next
  // chunk while the current one plays; fall back to the browser's own
  // synthesis when main has no engine.
  async function speakNow(text) {
    const t = speakable(text);
    if (!t) return;
    const gen = speakGen;
    const vol = voiceCfg.volume == null ? 1 : Math.max(0, Math.min(1, Number(voiceCfg.volume) / 100));
    const chunks = speechChunks(t);
    const render = (c) => aero.aiVoiceSpeak(c, synthOpts()).catch((err) => ({ error: String(err && err.message || err) }));
    let next = render(chunks[0]);
    let usedEngine = false;
    for (let i = 0; i < chunks.length; i++) {
      const wav = await next;
      if (gen !== speakGen) return;
      if (i + 1 < chunks.length) next = render(chunks[i + 1]);
      if (wav && wav.error) {
        if (ttsErrorShown !== wav.error) { ttsErrorShown = wav.error; bubble('error', esc(`Text to speech: ${wav.error}`)); }
        if (usedEngine) return;
        break;                         // fall back to the browser voice below
      }
      if (!wav) break;
      usedEngine = true;
      const a = new Audio(`data:audio/wav;base64,${wav}`);
      a.volume = vol;
      player = a;
      if (voiceCfg.speakerId && typeof a.setSinkId === 'function') { try { await a.setSinkId(voiceCfg.speakerId); } catch { /* default device */ } }
      await new Promise((res) => { a.onended = res; a.onerror = res; a.play().catch(res); });
      if (player === a) player = null;
      if (gen !== speakGen) return;
    }
    if (usedEngine) return;
    if (!window.speechSynthesis) return;
    await new Promise((res) => {
      const u = new SpeechSynthesisUtterance(t);
      u.rate = Math.max(0.5, Math.min(2, Number(voiceCfg.rate) || 1));
      u.volume = vol;
      u.pitch = Math.max(0, Math.min(2, 1 + (Number(voiceCfg.pitch) || 0) / 50));
      if (voiceCfg.voiceName) { const v = speechSynthesis.getVoices().find((x) => x.name === voiceCfg.voiceName); if (v) u.voice = v; }
      u.onend = res; u.onerror = res;
      speechSynthesis.speak(u);
    });
  }
  let speakGen = 0;
  function speak(text, force) {
    if (!force && !voiceCfg.speak) return;
    const gen = speakGen;
    speakQueue = speakQueue.then(() => (gen === speakGen ? speakNow(text) : null)).catch(() => {});
    return speakQueue;
  }

  // Settings helpers: devices need one granted getUserMedia for labels.
  async function audioDevices() {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch { /* labels may be empty */ }
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: all.filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 6)}` })),
      speakers: all.filter((d) => d.kind === 'audiooutput').map((d) => ({ id: d.deviceId, label: d.label || `Speaker ${d.deviceId.slice(0, 6)}` }))
    };
  }
  // Listen for `ms` and report the peak level (0-1) through onLevel.
  async function micTest(onLevel, ms = 5000) {
    let peak = 0;
    const c = await openMic((_pcm, rms) => { const l = Math.min(1, rms * 6); peak = Math.max(peak, l); onLevel(l); });
    await new Promise((res) => setTimeout(res, ms));
    closeMic(c);
    return peak;
  }

  window.AeroAi = { spokenFor: (b) => speakable(withVisuals(visualsBefore(b), b.dataset.raw || b.textContent)), init, md, setVoice, speakable, speak: (t) => speak(t, true), stopSpeaking, audioDevices, micTest, startMic, stopMic, onVoice };

})();
