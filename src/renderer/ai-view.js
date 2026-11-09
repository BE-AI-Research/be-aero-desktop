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
  const scrollToEnd = () => { msgsEl.scrollTop = msgsEl.scrollHeight; };

  function bubble(role, html) {
    const b = el('div', `ai-msg ai-${role}`, msgsEl);
    b.innerHTML = html;
    scrollToEnd();
    return b;
  }

  function toolRow(name, ok, input, result, image) {
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

  async function renderConversation(tab) {
    msgsEl.innerHTML = '';
    if (!tab) return;
    const conv = tab.convId ? await aero.aiConversation(tab.convId) : null;
    if (tab.convId && !conv) { tab.convId = null; tab.title = 'New chat'; }
    const hint = () => bubble('hint', 'Ask anything - or ask it to change a theme, open an app, read a web widget, search the web, or take notes. Attach files with 📎.');
    if (!conv) { hint(); renderTabs(); return; }
    tab.title = conv.title || 'Conversation';
    titleEl.textContent = tab.title;
    for (const m of conv.messages || []) {
      if (m.role === 'user') bubble('user', chipsBlock(m.attachments) + inline(m.content).replace(/\n/g, '<br>'));
      else if (m.role === 'assistant') { if (m.content) bubble('assistant', md(m.content)); }
      else if (m.role === 'tool') for (const r of m.results || []) toolRow(r.name, !r.isError, null, String(r.content || '').slice(0, 400), r.images && r.images[0] ? `data:${r.images[0].mime};base64,${r.images[0].data}` : null);
    }
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

  function syncBusy() {
    const t = activeTab();
    const lv = t && t.convId ? liveFor(t.convId) : null;
    const on = !!(lv && lv.busy);
    root.classList.toggle('busy', on);
    stopBtn.hidden = !on;
    sendBtn.title = on ? 'Queue this message for after the current turn' : 'Send (Enter)';
    statusEl.textContent = on ? 'Thinking…' : '';
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
    inputEl.value = ''; inputEl.style.height = '';
    pending = []; renderPending();
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
        if (ev.title) { tab.title = ev.title; if (isActive) titleEl.textContent = ev.title; }
        if (!isActive) tab.unread = true;
        break;
      case 'delta':
        lv.streamText += ev.text || '';
        if (isActive) {
          if (!lv.streamEl) lv.streamEl = bubble('assistant', '');
          lv.streamEl.innerHTML = md(lv.streamText);
          scrollToEnd();
        }
        break;
      case 'assistant':
        if (isActive) {
          if (lv.streamEl) lv.streamEl.innerHTML = md(ev.content || lv.streamText);
          else if (ev.content) bubble('assistant', md(ev.content));
        }
        lv.streamEl = null; lv.streamText = '';
        if (!isActive) tab.unread = true;
        break;
      case 'tool':
        if (isActive) toolRow(ev.name, ev.ok, ev.input, ev.result, ev.image);
        break;
      case 'queue':
        lv.queued = Array.isArray(ev.items) ? ev.items : [];
        if (isActive) renderQueue(lv);
        break;
      case 'error':
        if (isActive) bubble('error', esc(ev.message || 'Something went wrong.'));
        break;
      case 'done':
        lv.busy = false; lv.streamEl = null; lv.streamText = '';
        if (!isActive) tab.unread = true;
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

  function taskForm(task) {
    const t = task || { name: '', prompt: '', schedule: { type: 'daily', time: '09:00', every: 60, days: [1, 2, 3, 4, 5] }, conversationMode: 'shared', permission: 'inherit', enabled: true };
    const s = t.schedule || {};
    const localDT = s.at ? new Date(s.at) : new Date(Date.now() + 3600000);
    const pad = (n) => String(n).padStart(2, '0');
    const dtValue = `${localDT.getFullYear()}-${pad(localDT.getMonth() + 1)}-${pad(localDT.getDate())}T${pad(localDT.getHours())}:${pad(localDT.getMinutes())}`;
    const typeLabel = { daily: 'Daily', weekly: 'Weekly', interval: 'Every N minutes', once: 'Once' };
    return `<form class="ai-task-form">
      <input name="name" placeholder="Task name" value="${esc(t.name)}" required>
      <textarea name="prompt" rows="3" placeholder="What should the assistant do? e.g. 'Summarize my scratchpad and write a to-do list for today'" required>${esc(t.prompt)}</textarea>
      <div class="row">
        <select name="type">${['daily', 'weekly', 'interval', 'once'].map((v) => `<option value="${v}"${(s.type || 'daily') === v ? ' selected' : ''}>${typeLabel[v]}</option>`).join('')}</select>
        <input name="time" type="time" value="${esc(s.time || '09:00')}" class="sched daily weekly">
        <input name="every" type="number" min="1" value="${Number(s.every) || 60}" class="sched interval" title="minutes">
        <input name="at" type="datetime-local" value="${dtValue}" class="sched once">
      </div>
      <div class="row sched weekly ai-days">${DAYS.map((d, i) => `<label><input type="checkbox" name="day${i}"${(s.days || [1, 2, 3, 4, 5]).includes(i) ? ' checked' : ''}> ${d}</label>`).join('')}</div>
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
      <div class="row"><button type="submit" class="btn">${t.id ? 'Save' : 'Add task'}</button><button type="button" class="btn ai-task-cancel">Cancel</button></div>
    </form>`;
  }

  function readForm(form, base) {
    const f = new FormData(form);
    const type = f.get('type');
    const schedule = { type };
    if (type === 'once') schedule.at = new Date(String(f.get('at'))).toISOString();
    if (type === 'interval') schedule.every = Number(f.get('every')) || 60;
    if (type === 'daily' || type === 'weekly') schedule.time = String(f.get('time'));
    if (type === 'weekly') schedule.days = DAYS.map((_, i) => i).filter((i) => f.get(`day${i}`));
    return { ...(base || {}), name: String(f.get('name')).trim(), prompt: String(f.get('prompt')).trim(), schedule, conversationMode: f.get('conversationMode'), permission: f.get('permission') };
  }

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
      const typeSel = form.querySelector('[name=type]');
      const showSched = () => { for (const x of form.querySelectorAll('.sched')) x.classList.toggle('hidden', !x.classList.contains(typeSel.value)); };
      typeSel.addEventListener('change', showSched); showSched();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await aero.aiTaskSave(readForm(form, editingTask.id ? editingTask : {}));
        if (r && r.error) { const n = form.querySelector('[name=name]'); n.setCustomValidity(r.error); form.reportValidity(); n.setCustomValidity(''); return; }
        editingTask = null;
        renderTasks();
      });
      form.querySelector('.ai-task-cancel').addEventListener('click', () => { editingTask = null; renderTasks(); });
    }
    const list = el('div', 'ai-task-list', tasksEl);
    for (const t of taskList) {
      const row = el('div', `ai-task${t.enabled === false ? ' off' : ''}${t.running ? ' running' : ''}`, list);
      row.innerHTML = `<label class="ai-task-on" title="${t.enabled === false ? 'Enable' : 'Disable'}"><input type="checkbox"${t.enabled === false ? '' : ' checked'}></label>
        <div class="ai-task-main"><div class="ai-task-name">${esc(t.name)}</div>
        <div class="ai-task-meta">${esc(t.summary)} · next ${esc(when(t.nextRun))}${t.lastStatus ? ` · last: ${esc(t.lastStatus)}` : ''}${t.permission === 'allow' ? ' · autonomous' : t.permission === 'deny' ? ' · read-only' : ''}</div></div>
        <div class="ai-task-actions"><button class="icon-btn t-run" title="Run now">▶</button><button class="icon-btn t-open" title="Open its conversation"${t.conversationId ? '' : ' disabled'}>💬</button><button class="icon-btn t-edit" title="Edit">✎</button><button class="icon-btn t-del" title="Delete">🗑</button></div>`;
      row.querySelector('input').addEventListener('change', (e) => aero.aiTaskToggle(t.id, e.target.checked));
      row.querySelector('.t-run').addEventListener('click', () => aero.aiTaskRun(t.id));
      row.querySelector('.t-open').addEventListener('click', () => { if (t.conversationId) newTab(t.conversationId, `Task: ${t.name}`, true); });
      row.querySelector('.t-edit').addEventListener('click', () => { editingTask = t; renderTasks(); });
      row.querySelector('.t-del').addEventListener('click', () => aero.aiTaskDelete(t.id));
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
      const c = e.target.closest('.ai-copy');
      if (c) { const code = c.closest('.ai-code').querySelector('code').textContent; c.textContent = (await copyText(code)) ? 'Copied' : 'Failed'; setTimeout(() => { c.textContent = 'Copy'; }, 1200); }
    });

    aero.onAiEvent(onEvent);
    aero.onAiAsk((text) => { root.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); send(text); });
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

  window.AeroAi = { init, md };
})();
