// Keyboard accelerator helpers, shared by the main process (which registers
// the global shortcut) and the renderer (which records one from a key press),
// so both agree on exactly what a valid accelerator looks like.
//
// Loaded by require() in main and by <script src> in the renderer.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AeroHotkey = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // KeyboardEvent.code is layout independent, so a recorded shortcut means the
  // same physical keys on any keyboard layout.
  const PUNCTUATION = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/'
  };
  const NAMED = {
    Space: 'Space', Tab: 'Tab', Enter: 'Return', NumpadEnter: 'Return',
    Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadDecimal: 'numdec',
    NumpadMultiply: 'nummult', NumpadDivide: 'numdiv'
  };
  const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

  // The accelerator key for a KeyboardEvent.code, or null if we will not bind it.
  function keyFromCode(code) {
    if (!code) return null;
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    if (NAMED[code]) return NAMED[code];
    if (PUNCTUATION[code]) return PUNCTUATION[code];
    return null;
  }

  function isModifierCode(code) {
    return MODIFIER_CODES.test(String(code || ''));
  }

  // Build an Electron accelerator from a key event. Returns null when the press
  // is not bindable on its own - a bare key would swallow ordinary typing
  // everywhere, so at least one modifier is required.
  function fromEvent(e) {
    if (!e || isModifierCode(e.code)) return null;
    const key = keyFromCode(e.code);
    if (!key) return null;
    const parts = [];
    if (e.ctrlKey) parts.push('Control');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Super');
    if (!parts.length) return null;
    parts.push(key);
    return parts.join('+');
  }

  // Canonical spellings for the non-modifier half, so "space" and "Space" and
  // "SPACE" all compare equal.
  const CANONICAL_KEYS = (() => {
    const keys = new Set(Object.values(NAMED));
    for (const p of Object.values(PUNCTUATION)) keys.add(p);
    for (let i = 1; i <= 24; i++) keys.add(`F${i}`);
    for (let i = 0; i <= 9; i++) keys.add(`num${i}`);
    for (const k of ['numadd', 'numsub', 'numdec', 'nummult', 'numdiv', 'Escape', 'Esc',
      'PrintScreen', 'ScrollLock', 'Pause', 'CapsLock', 'NumLock', 'Plus']) keys.add(k);
    const byLower = new Map();
    for (const k of keys) byLower.set(k.toLowerCase(), k);
    return byLower;
  })();

  function canonicalKey(key) {
    if (key.length === 1) return key.toUpperCase();
    return CANONICAL_KEYS.get(key.toLowerCase()) || key;
  }

  // Canonical modifier order and casing, so two spellings of one shortcut compare equal.
  function normalize(accel) {
    if (typeof accel !== 'string' || !accel.trim()) return null;
    const raw = accel.split('+').map((s) => s.trim()).filter(Boolean);
    if (!raw.length) return null;
    const alias = {
      ctrl: 'Control', control: 'Control', cmd: 'Super', command: 'Super',
      commandorcontrol: 'Control', cmdorctrl: 'Control',
      alt: 'Alt', option: 'Alt', shift: 'Shift',
      super: 'Super', win: 'Super', meta: 'Super'
    };
    const mods = new Set();
    let key = null;
    for (const part of raw) {
      const m = alias[part.toLowerCase()];
      if (m) { mods.add(m); continue; }
      if (key) return null; // two non-modifier keys is not an accelerator
      key = canonicalKey(part);
    }
    if (!key) return null;
    const order = ['Control', 'Alt', 'Shift', 'Super'];
    return [...order.filter((m) => mods.has(m)), key].join('+');
  }

  function isValid(accel) {
    const n = normalize(accel);
    return !!n && n.includes('+');
  }

  // Human-readable form for labels: Ctrl + Alt + Space.
  function pretty(accel) {
    if (!isValid(accel)) return '';
    const n = normalize(accel);
    return n.split('+')
      .map((p) => (p === 'Control' ? 'Ctrl' : p === 'Super' ? 'Win' : p))
      .join(' + ');
  }

  return { fromEvent, normalize, isValid, pretty, keyFromCode, isModifierCode };
});
