# BE-Aero Desktop SDK

Two ways to put your own content in the sidebar:

| | **Plugin widget** | **App pane** |
|---|---|---|
| What it is | Your HTML/CSS/JS rendered as a widget | Structured status pushed in by a running program |
| You write | A folder with a manifest and a page | HTTP calls from any language |
| Runs | Inside BE-Aero Desktop, sandboxed | In your own process |
| Use it when | You want custom visuals and interaction | An app you already have should report into the sidebar |

---

# 1. Plugin widgets

## Quick start

Create a folder in `%APPDATA%\BE-Aero Desktop\plugins\` — Settings → Extensions →
**Open plugins folder** takes you there.

```
%APPDATA%\BE-Aero Desktop\plugins\hello\
    aero-widget.json
    index.html
```

**aero-widget.json**

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "description": "My first widget",
  "entry": "index.html",
  "height": 140,
  "permissions": ["telemetry", "theme"]
}
```

**index.html**

```html
<!DOCTYPE html>
<meta charset="UTF-8">
<style>
  body { margin: 0; font-family: 'Segoe UI', sans-serif; color: var(--text, #fff); }
  .cpu { font-size: 28px; font-weight: 700; color: var(--accent, #38bdf8); }
</style>
<div class="cpu" id="cpu">--</div>

<script src="aero-sdk.js"></script>
<script>
  (async () => {
    await aero.ready();
    await aero.useHostTheme();                    // adopt the host's colours
    aero.telemetry.subscribe((t) => {
      document.getElementById('cpu').textContent = Math.round(t.cpu) + '%';
    });
  })();
</script>
```

Then Settings → Extensions → **Reload**. Your widget appears in the sidebar with
a resize grip, and it can be dragged anywhere in free-form mode like any
built-in widget.

> `aero-sdk.js` is served by the host — do **not** copy it into your folder.
> Referencing `aero-sdk.js` always gets the version matching the running app.

## Manifest reference

| Field | Required | Notes |
|---|---|---|
| `id` | yes | 2–40 chars, `a-z 0-9 -`, must start alphanumeric. Lowercased. Must be unique. |
| `name` | no | Shown in the widget header. Defaults to `id`. |
| `entry` | yes | Relative `.html` path inside your folder. `..` and absolute paths are rejected. |
| `version` | no | Free-form string, shown in Settings. |
| `description` | no | Shown in Settings and the header tooltip. |
| `author` | no | Shown in the header tooltip. |
| `height` | no | Default pane height, 80–1200. Default 220. |
| `minHeight` / `minWidth` | no | Resize floors. Defaults 120 / 200. |
| `permissions` | no | Array; see below. Unknown entries are dropped. |
| `settings` | no | Schema the host renders as **editable controls** in Settings (`key`, `label`, `type`, `default`, `options`). Types: `text`, `number`, `checkbox`, `color`, `select`. Values are coerced to the declared type and saved into your plugin's storage. |

A manifest that fails validation is skipped with a reason logged to the console —
the rest of your plugins still load.

## Permissions

**Your manifest requests; the user grants.** Listing a permission in
`aero-widget.json` gives you nothing on its own — it only makes you *able to
ask*. The first time your plugin actually uses a capability, Aero Widgets shows
a consent dialog naming your plugin and what it wants. The answer is
remembered, and the user can change it at any time.

| Permission | Unlocks | Risk |
|---|---|---|
| `telemetry` | `aero.telemetry.get()`, `aero.telemetry.subscribe()` | low |
| `storage` | `aero.storage.get()`, `aero.storage.set()` | low |
| `theme` | `aero.theme.get()`, `aero.theme.apply()`, `aero.useHostTheme()` | low |
| `open-external` | `aero.openExternal(url)` — http(s) only | medium |
| `notifications` | `aero.notify({ title, body })` | medium |

### The three states

| State | Meaning |
|---|---|
| `undecided` | Never asked. The next use prompts the user. |
| `granted` | Allowed until revoked. |
| `denied` | Refused. Calls fail immediately and do **not** re-prompt. |

The consent dialog defaults to **Deny**, so consent is always a deliberate act.

### Rules worth knowing

- **Declared but not granted is still denied.** A permission missing from your
  manifest is refused outright, even if it was granted before — so adding a
  capability in an update cannot inherit old consent.
- **Revocation is immediate.** It applies to the very next call, and it also
  tears down live push streams such as `telemetry.subscribe`.
- **Dropping a permission forgets its grant.** If you stop requesting something,
  the stored answer is pruned. Uninstalling forgets everything.
- **Prompts are not spammable.** Only one dialog per (plugin, permission) is
  ever in flight, no matter how many calls you fire.
- **Usage is visible.** Settings shows when each capability was last used.

### Writing a plugin that handles refusal well

Check before you call, and react when the user changes their mind. Never assume
the grant you had at startup still holds.

```js
await aero.ready();

// Feature-detect without prompting.
if (await aero.permissions.has('telemetry')) {
  start();
} else {
  showPlaceholder();
}

// Ask politely at a moment the user will understand (e.g. a button click).
button.onclick = async () => {
  if (await aero.permissions.request('notifications') === 'granted') {
    aero.notify({ title: 'Done', body: 'Build finished' });
  }
};

// Follow the user's decision for the rest of the session.
aero.permissions.onChange((state) => {
  if (state.telemetry === 'granted') start(); else showPlaceholder();
});
```

`aero.permissions.query(name)` returns the state without ever prompting, so it
is safe to call on load. `request(name)` prompts only if still undecided.

A capability your plugin asked for but the user blocked should degrade, not
crash: the example plugin keeps rendering with default colours when `theme` is
blocked, and shows a short message instead of a chart when `telemetry` is.

### What the user sees

Settings → Extensions lists every plugin with each requested capability, its
plain-language description, an **Allow / Block / Ask** control, and when it was
last used. "Ask" forgets the answer so the next use prompts again, and
"Forget all answers for this plugin" resets the lot. A plugin with an
unanswered request is badged **needs review**.

## API

```js
await aero.ready()                     // { id, name, requested, granted, api }

await aero.storage.get()               // your saved object            [storage]
await aero.storage.set({ count: 3 })   // merges, returns the result   [storage]

await aero.settings.get()              // manifest-declared settings   (no permission)
aero.settings.onChange(fn)             // fires when the user edits one

await aero.telemetry.get()             // one sample                   [telemetry]
const off = aero.telemetry.subscribe(fn)  // live samples; call off() to stop

await aero.theme.get()                 // { '--accent': '#38bdf8', ... } [theme]
await aero.theme.apply()               // writes them onto :root        [theme]
await aero.useHostTheme()              // apply + keep in sync          [theme]
aero.onTheme(fn)                       // theme change callback         [theme]

await aero.openExternal('https://…')   //                        [open-external]
await aero.notify({ title, body })     //                        [notifications]

await aero.permissions.query(name)     // granted | denied | undecided (no prompt)
await aero.permissions.has(name)       // boolean                      (no prompt)
await aero.permissions.request(name)   // granted | denied         (may prompt)
aero.permissions.onChange(fn)          // { telemetry: 'granted', … }
```

A telemetry sample looks like:

```js
{ cpu, ram, usedMemGB, totalMemGB, cores, cpuModel, uptime,
  perCore: [...], disk: { drive, percent, usedGB, totalGB }, net: { rx, tx, percent } }
```

`disk` and `net` are present only when those metrics are enabled in Settings.

### Settings vs storage

Your manifest's `settings` array is rendered as real controls in the host's
Settings panel. `aero.settings.get()` returns those values (defaults filled
in) and needs **no permission** — it is your own configuration, edited by the
user. `aero.settings.onChange(fn)` fires live when the user changes one, so a
widget can react without a reload. Setting values share a namespace with
`aero.storage`, so `storage.get()` sees them too; the panel, however, only
ever shows and edits the keys you declared.

## Styling

The SDK sets `color-scheme: dark` and a transparent background on load, so your
widget sits on the host's glass instead of a white rectangle. Use the theme
variables after `useHostTheme()`:

`--accent`, `--accent-rgb`, `--text`, `--text-rgb`, `--glass-rgb`,
`--glass-alpha`, `--glass-border`, `--glass-glow`, `--radius`

## Security model

Your plugin runs in an `<iframe sandbox="allow-scripts">` served from
`aero-plugin://<id>/`. That means:

- **No `allow-same-origin`** — an opaque origin. You cannot reach the host page,
  its DOM, storage or cookies.
- **No Node, no Electron, no file system.** The SDK bridge is the entire surface.
- **Scoped file serving.** `aero-plugin://<id>/…` only ever resolves inside that
  plugin's own folder; traversal returns 403.
- **A page CSP** allowing your own scripts/styles (inline included), images from
  `self`/`data:`/`https:`, and `connect-src https:` so you can fetch public APIs.
  Framing, forms and `base-uri` are blocked.
- **The host decides who you are.** The plugin id attached to every bridge call
  comes from the frame the message physically arrived on, never from the message
  body, so one plugin cannot impersonate another.
- **Consent gates every privileged call**, including subscriptions — the push
  stream is not a way around the prompt.

A working example lives in [`examples/plugins/cpu-sparkline`](../examples/plugins/cpu-sparkline).

---

# 2. App panes (the local API)

Let a program you already run — a build, a trading bot, a home-automation
script — push a live status pane into the sidebar.

## Turning it on

Settings → Extensions → **Let local apps push widget panes**. The sidebar then
listens on `http://127.0.0.1:8787`.

## Pairing: every app gets its own identity

There is no shared password. Each program **pairs once**: it asks, you approve
in a dialog naming it and what it wants, and it receives **its own token with
its own capabilities**. After that every request is attributable to one app,
which you can inspect, restrict or disconnect on its own.

```
┌── your program ──┐        ┌── Aero Widgets ──┐
│ reads pairing    │ ─────▶ │ POST /v1/pair     │
│ code from        │        │   ↓               │
│ api-token.json   │        │ asks the user     │  ← you click Allow or Deny
│                  │ ◀───── │ returns app token │
│ stores app token │        └───────────────────┘
└──────────────────┘
```

The **pairing code** lives in a file only your account can read:

```
%APPDATA%\BE-Aero Desktop\api-token.json
{ "host": "127.0.0.1", "port": 8787, "pairingToken": "…" }
```

It grants nothing by itself — it only lets a local process *raise the prompt*.
Two gates have to pass: the process must already be running as you (to read the
file), and you must say yes.

### Tokens are bound to your executable - and to what it IS

Beyond the path, pairing records the binary's identity:

- **Signed programs** are bound to their **Authenticode signer**. Updating in
  place keeps working as long as the new binary is validly signed by the same
  certificate; a binary at the same path signed by anyone else - or no longer
  signed at all - is refused (`403`, `verdict: "changed"`).
- **Unsigned programs** are pinned to their **SHA-256**. Any change to the
  file requires re-pairing, and the consent dialog warned the user it was
  unsigned when they approved it.

Verification is cached by the file's (mtime, size), so requests cost nothing
until the binary on disk actually changes - exactly the event worth checking.
The consent dialog shows the publisher line ("Publisher: CN=OpenJS Foundation
... (signature verified)") or an UNSIGNED warning, and Settings lists it per
connected program.

### Tokens are bound to your executable

When you pair, Aero Widgets asks Windows which process owns the connection and
records your executable's path. The consent dialog shows it ("Program:
C:\Tools\build.exe"), and from then on **your token only works from that
binary** — on every request the caller's executable is resolved again (cached
per connection, ~30ms per new connection) and compared to the recorded one. A
token copied out of your config file is useless to any other program:

```jsonc
// presented by a different executable
// 403
{ "error": "this token belongs to a different program",
  "expected": "C:\\Tools\\build.exe",
  "hint": "pair again from the new binary if the program moved or was updated" }
```

Consequences worth planning for:

- **Updating or moving your program changes its path** (unless it updates in
  place). A `403` with `expected` set means re-pair from the new location.
- **Script runtimes blur identity.** If your client runs under `node.exe` or
  `python.exe`, the binding is to the interpreter, not your script — any script
  run by the same interpreter can use the token. Ship a packaged binary if that
  distinction matters to you.
- **Pairing fails closed.** If Windows cannot identify the caller, pairing is
  refused before any dialog is shown, and a bound token presented over an
  unidentifiable connection is refused too.

```http
POST /v1/pair
Authorization: Bearer <pairingToken>
Content-Type: application/json

{ "name": "Build Monitor", "capabilities": ["panes"] }
```

```jsonc
// 200 - keep this token; it is your identity from now on
{ "appId": "a3eb…", "name": "Build Monitor", "token": "…", "capabilities": ["panes"] }
// 403 - the user declined
// 429 - a prompt is already open, or this name was declined recently
```

Ask only for what you need: the user sees the list, and a modest request is far
more likely to be approved.

## App capabilities

| Capability | Unlocks | Risk |
|---|---|---|
| `panes` | Create, update and delete **its own** panes | low |
| `telemetry` | `GET /v1/telemetry` | medium |

- **Asking is not getting.** A capability you did not request at pairing is
  refused, and the user can block any you did.
- **Blocking is immediate** — the next request gets `403`.
- **Apps are isolated.** Pane ids are scoped per app, so two programs can both
  own a pane called `status`. You can never read, overwrite or delete another
  app's panes, and a listing only ever returns your own.
- **Quotas are per app** (8 panes each, 24 overall), so one chatty program
  cannot crowd out the rest.
- **Disconnecting removes the app's panes** along with its token.
- **Every pane shows who pushed it** in its footer, so the user always knows
  which program put something on their desktop.

Rotating the pairing code in Settings stops *new* pairings; apps already paired
keep working until you disconnect them individually. Settings shows each
connected program's bound executable alongside its capabilities.

## Endpoints

All paths are under `/v1`. Send `Authorization: Bearer <appToken>`.

| Method | Path | Needs | Does |
|---|---|---|---|
| `POST` | `/pair` | pairing code | Ask the user for an identity |
| `GET` | `/ping` | app token | `{ ok, app, api, you: { id, name, capabilities } }` |
| `GET` | `/telemetry` | `telemetry` | Current CPU/RAM/disk/net sample |
| `GET` | `/panes` | `panes` | **Your** panes |
| `GET` | `/panes/:id` | `panes` | One of your panes |
| `PUT` / `POST` | `/panes/:id` | `panes` | Create or replace one of your panes |
| `DELETE` | `/panes/:id` | `panes` | Remove one of your panes |
| `DELETE` | `/panes` | `panes` | Remove all of **your** panes |

## Handling revocation

The user can disconnect you at any time. Treat `401` as "I am no longer
paired": discard the stored token and pair again rather than retrying.

```js
const res = await call('GET', '/v1/ping');
if (res.status === 401) {
  fs.unlinkSync(SAVED_TOKEN);     // we were disconnected
  throw new Error('run again to ask for access');
}
```

A `403` is different — you are still paired, but either that capability is
blocked (the body names it) or the token is being presented from a different
executable than the one it was issued to (the body carries `expected`). In the
second case re-pair from the current binary.

## Pane shape

```jsonc
{
  "title": "Deploy",              // header, ≤60 chars
  "subtitle": "prod",             // ≤80 chars
  "icon": "🚀",                   // ≤8 chars
  "accent": "#34d399",            // #rrggbb; tints the border and bars
  "progress": 43,                 // 0-100, draws a progress bar
  "lines": ["Building image…"],   // ≤12 lines, ≤200 chars each
  "text": "or one\nstring",       // used when "lines" is absent
  "metrics": [                    // ≤8
    { "label": "tests", "value": "128/130", "percent": 98, "color": "#34d399" }
  ],
  "actions": [                    // ≤4; http(s) urls only
    { "label": "Open build", "url": "https://example.com/build/42" }
  ]
}
```

Everything is optional. Out-of-range numbers are clamped, bad colours dropped,
non-http(s) action URLs discarded, and lists truncated — a malformed field never
fails the whole call.

**Pane content is drawn as text, never as HTML.** There is no way to inject
markup or script into the sidebar through this API.

Panes are intentionally **not persisted**: they describe another program's live
state, so they are cleared when Aero Widgets restarts.

## Examples

A complete, runnable client is in
[`examples/clients/pair-and-push.js`](../examples/clients/pair-and-push.js) —
it pairs on first run, saves its token, pushes a progress pane, and re-pairs if
it is disconnected.

**Node**

```js
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(`${process.env.APPDATA}/BE-Aero Desktop/api-token.json`));
const base = `http://${cfg.host}:${cfg.port}`;

// Once: ask the user for an identity.
const paired = await (await fetch(`${base}/v1/pair`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${cfg.pairingToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Build Monitor', capabilities: ['panes'] })
})).json();                                  // save paired.token

// Thereafter: use your own token.
await fetch(`${base}/v1/panes/build`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Build', progress: 70, lines: ['Compiling…'] })
});
```

**PowerShell**

```powershell
$cfg = Get-Content "$env:APPDATA\Aero Widgets\api-token.json" -Raw | ConvertFrom-Json
$base = "http://$($cfg.host):$($cfg.port)"

$pair = Invoke-RestMethod "$base/v1/pair" -Method POST `
  -Headers @{ Authorization = "Bearer $($cfg.pairingToken)" } -ContentType "application/json" `
  -Body (@{ name = "Backup Tool"; capabilities = @("panes") } | ConvertTo-Json)

Invoke-RestMethod "$base/v1/panes/backup" -Method PUT `
  -Headers @{ Authorization = "Bearer $($pair.token)" } -ContentType "application/json" `
  -Body (@{ title = "Backup"; progress = 70; lines = @("Copying…") } | ConvertTo-Json)
```

**Python**

```python
import json, os, urllib.request

cfg = json.load(open(os.path.expandvars(r'%APPDATA%\BE-Aero Desktop\api-token.json')))
base = f"http://{cfg['host']}:{cfg['port']}"

def post(path, token, payload, method='POST'):
    req = urllib.request.Request(f'{base}{path}', method=method,
        data=json.dumps(payload).encode(),
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req))

paired = post('/v1/pair', cfg['pairingToken'],
              {'name': 'Sensor Bridge', 'capabilities': ['panes']})
post('/v1/panes/sensors', paired['token'],
     {'title': 'Sensors', 'metrics': [{'label': 'temp', 'value': '21C'}]}, method='PUT')
```

## Errors

| Status | Meaning |
|---|---|
| `400` | Malformed pane or body — the message says what |
| `401` | Unknown or revoked app token — pair again |
| `403` | Capability not granted, user declined pairing, or an `Origin` header was present |
| `404` | Unknown endpoint, or a pane that is not yours |
| `413` | Body over 256 KB |
| `429` | A pairing prompt is already open, or this name was declined recently |

Disconnecting an app in Settings invalidates its token immediately and removes
its panes.
