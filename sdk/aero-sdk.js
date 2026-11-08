/*!
 * BE-Aero Desktop plugin SDK (v1)
 *
 * Drop this file next to your plugin's HTML and include it:
 *   <script src="aero-sdk.js"></script>
 *
 * Your plugin runs inside a sandboxed iframe with an opaque origin, so it
 * cannot reach the host page. This SDK is the whole surface: it turns
 * postMessage into a small promise-based API. Every call needs the matching
 * permission in your aero-widget.json, otherwise it rejects.
 *
 *   await aero.ready()                      -> { id, name, requested, granted, api }
 *
 * Permissions are granted by the USER, not by your manifest. The manifest only
 * says what you may ask for. The first time you call something, BE-Aero Desktop
 * asks the user and remembers the answer; they can change it any time in
 * Settings, so treat a rejection as normal and degrade gracefully.
 *
 *   await aero.permissions.query('telemetry')    -> granted | denied | undecided
 *   await aero.permissions.request('telemetry')  -> granted | denied  (may prompt)
 *   aero.permissions.onChange(fn)                -> { telemetry: 'granted', ... }
 *   await aero.storage.get()                -> your saved object      [storage]
 *   await aero.storage.set({ key: value })  -> the merged object      [storage]
 *   await aero.settings.get()               -> manifest-declared settings (no permission)
 *   aero.settings.onChange(fn)              -> fires when the user edits them
 *   await aero.telemetry.get()              -> one sample             [telemetry]
 *   aero.telemetry.subscribe(fn)            -> live samples           [telemetry]
 *   await aero.theme.get()                  -> css variables          [theme]
 *   aero.theme.apply()                      -> write them onto :root  [theme]
 *   aero.onTheme(fn)                        -> theme changes          [theme]
 *   await aero.openExternal(url)            -> open http(s) in browser [open-external]
 *   await aero.notify({title, body})        -> desktop notification  [notifications]
 */
(function (global) {
  'use strict';

  const pending = new Map();
  const listeners = { telemetry: new Set(), theme: new Set(), permissions: new Set(), settings: new Set() };
  let nextId = 1;

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      // The host replies to the frame it heard from, so "*" is safe here: the
      // message only ever travels to our own parent.
      global.parent.postMessage({ __aero: 1, id, method, params: params || {} }, '*');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`aero: "${method}" timed out`));
        }
      }, 10000);
    });
  }

  global.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.__aero !== 1) return;

    if (msg.event) {
      const set = listeners[msg.event];
      if (set) for (const fn of set) { try { fn(msg.payload); } catch (err) { console.error(err); } }
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || 'aero: call failed'));
  });

  let info = null;

  const aero = {
    /** Host details, including the permissions actually granted. */
    async ready() {
      if (!info) info = await call('host.info');
      return info;
    },

    storage: {
      get: () => call('storage.get'),
      set: (patch) => call('storage.set', { patch })
    },

    /**
     * The settings your manifest declared, as edited by the user in the
     * host's Settings panel. Reading them needs no permission - they are your
     * own configuration. onChange fires whenever the user edits one.
     */
    settings: {
      get: () => call('settings.get'),
      onChange(fn) {
        listeners.settings.add(fn);
        return () => listeners.settings.delete(fn);
      }
    },

    telemetry: {
      get: () => call('telemetry.get'),
      /** Live samples at the host's configured interval. Returns an unsubscribe. */
      subscribe(fn) {
        listeners.telemetry.add(fn);
        call('telemetry.subscribe').catch(() => {});
        return () => {
          listeners.telemetry.delete(fn);
          if (!listeners.telemetry.size) call('telemetry.unsubscribe').catch(() => {});
        };
      }
    },

    theme: {
      get: () => call('theme.get'),
      /** Copy the host's theme variables onto :root so your CSS can use them. */
      async apply() {
        const vars = await call('theme.get');
        for (const [k, v] of Object.entries(vars || {})) {
          document.documentElement.style.setProperty(k, v);
        }
        return vars;
      }
    },

    /** Re-apply automatically whenever the user changes theme. */
    onTheme(fn) {
      listeners.theme.add(fn);
      return () => listeners.theme.delete(fn);
    },

    openExternal: (url) => call('shell.openExternal', { url }),

    notify: (body) => call('notifications.show', body || {}),

    permissions: {
      /** Current state without prompting: granted | denied | undecided. */
      query: (name) => call('permissions.query', { name }),
      /** Ask for one. Prompts only if the user has not decided yet. */
      request: (name) => call('permissions.request', { name }),
      /** True if usable right now. Never prompts - safe for feature detection. */
      async has(name) {
        return (await call('permissions.query', { name })) === 'granted';
      },
      /**
       * Fires whenever the user changes your permissions in Settings, with a
       * { permission: state } map. Re-subscribe to anything that came back;
       * stop showing anything that went away.
       */
      onChange(fn) {
        listeners.permissions.add(fn);
        return () => listeners.permissions.delete(fn);
      }
    },

    /** Convenience: keep :root in sync with the host theme for the plugin's life. */
    async useHostTheme() {
      await aero.theme.apply().catch(() => {});
      aero.onTheme((vars) => {
        for (const [k, v] of Object.entries(vars || {})) {
          document.documentElement.style.setProperty(k, v);
        }
      });
    }
  };

  // Sane defaults for a widget frame: an iframe's canvas is opaque white under
  // the default light colour scheme, which would punch a white rectangle
  // through the host's glass. Plugins can still override either of these.
  try {
    const root = document.documentElement;
    root.style.colorScheme = 'dark';
    if (!root.style.background) root.style.background = 'transparent';
    if (document.body && !document.body.style.background) {
      document.body.style.background = 'transparent';
    }
  } catch { /* no DOM yet; the plugin can set these itself */ }

  global.aero = aero;
})(typeof window !== 'undefined' ? window : globalThis);
