# BE-Aero Desktop

A modern take on an old concept. Fully modular, widget and applet based desktop environment that is universal, and cross-platform.

<img width="2752" height="1536" alt="be-aero-desktop-logo" src="https://github.com/user-attachments/assets/83489174-cc12-498e-ae13-f62903981443" />

A Windows 11 "Aero-Mica" desktop platform - widget sidebar, application dock, Spotlight-style search, web widgets, a sandboxed plugin SDK and a local app API. Built with Electron from the original `aero-widgets.html` prototype; runs on Linux too.

## Install

**Windows** (PowerShell) - downloads the installer (~120 MB, with a progress bar) from the
latest release and runs it. The installer asks for administrator permission - if nothing
seems to happen, look for the Windows permission prompt behind your other windows:

```powershell
curl.exe -fL --progress-bar -o BE-Aero-Desktop-Setup.exe https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/BE-Aero-Desktop-Setup.exe
.\BE-Aero-Desktop-Setup.exe
```

Prefer no install? Grab the portable build instead and just run it:

```powershell
curl.exe -fL --progress-bar -o BE-Aero-Desktop-Portable.exe https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/BE-Aero-Desktop-Portable.exe
```

**Linux** - one command: the installer downloads the latest release (~120 MB) itself and
installs to `/opt` with a menu entry and CLI shim:

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```

(Already have the tar.gz? `sudo bash install-linux.sh be-aero-desktop.tar.gz` installs that instead.)

Uninstall later with `sudo bash install-linux.sh --uninstall`. Windows SmartScreen may warn on
first run because the builds are not code-signed yet - choose "More info -> Run anyway" if you
trust this source. All downloads are also on the [releases page](https://github.com/BE-AI-Research/be-aero-desktop/releases).

## Widgets
- **Search** - a Spotlight-style launcher (see below). The search bar at the top of the sidebar opens it.
- **Chronometer** - seven faces: analog, classic (all numerals), minimal ticks, hybrid, digital, flip clock and rings. Optional digital readout, seconds, date, sweeping second hand and its own accent colour.
- **Weather** - live conditions from Open-Meteo (free, no API key). Animated sun/moon/cloud/rain/snow/storm/fog, plus a 7-day forecast strip that appears once you make the widget tall enough (it can also be switched off in Settings). Pick any city in Settings.
- **System telemetry** - real CPU, RAM, disk, network and battery readings in five styles: rings, speedometer arcs, bars, live graphs or compact chips. Per-core heatmap, configurable colours, sample interval, history length, warning threshold and stroke thickness.
- **Application dock** - a macOS-style dock on glass: pin apps to it (click launches them), every open application shows with its real icon, a running dot and a window-count badge; click focuses (repeated clicks cycle an app's windows), right-click manages (that app's windows, new window, pin/unpin, minimize all, close all). Icon alignment (left / center / right) is configurable, minimized web widgets park here with their site favicons, and the dock - like every widget, plugin and web widget - can be toggled individually from the tray. A reconfigurable **dock hotkey** (Ctrl+Alt+D by default) summons the dock above whatever is on screen - a full-screen game included - and it sinks back to the desktop layer as soon as you pick an app or press the key again.
- **Scratchpad** - notes saved to disk automatically (they survive restarts), with a Save button to write the note out as a .md or .txt file.

## AI assistant
A chat widget that can **operate the desktop**: switch themes, change settings, read and
write the scratchpad, search the index and launch apps, list/focus/close running
applications, create web widgets, and drive web frames (read the page, navigate, click,
type, run JavaScript). Conversations are saved and can be revisited, renamed and deleted.
Pin the widget (📌) to keep the sidebar above other windows while an agentic task runs.

- **Web access:** `web_search` returns results (no key or browser needed) and `fetch_url` reads
  a page as text; `open_web_search` hands a query to your default browser and engine.
- **Driving apps and web frames:** focus/minimize/maximize/restore/close windows, send
  keystrokes to the focused app (`send_keys`), read/write the clipboard, run commands
  (`run_command`, or `exec_capture` to get the output); in web widgets: list interactive
  elements with selectors, find by text, click, type, select, hover, submit, back/forward,
  reload, and wait for navigation.
- **Attachments:** the 📎 button attaches images, PDFs and text/code files to a message - images
  and PDFs go to the model as content (PDFs with Anthropic; OpenAI-compatible providers get
  images only), text files inline. Gated `read_file` / `list_directory` tools cover files you
  refer to by path.
- **Message queue:** keep typing while it works - messages queue (shown dashed) and run in
  order when the current turn finishes; Stop clears the queue too.
- **Labels:** double-click the conversation title (or the ✎ button) to name a conversation.
- **Providers:** Anthropic (Claude) through the official SDK, or anything OpenAI-compatible -
  OpenAI, **Ollama** and **LM Studio** locally, or a custom server. Pick one in
  Settings > AI assistant, add a key if the provider needs one (stored encrypted with the OS
  keychain), and *Fetch models* to choose a model.
- **Persona & instructions:** a master prompt sent ahead of every conversation - who the
  assistant is and how it should behave.
- **Permissions:** reading never asks; anything that changes state (settings, launching,
  operating web widgets, closing windows) is gated: ask each time, always allow, or never.
- **Power-user prefixes in search:** `run> notepad` launches like the Run dialog (Win+R
  semantics - GUI apps open, console programs get their own window); `cmd> ipconfig` opens a
  terminal that runs the command and stays open (`cmd>` alone just opens a terminal). On Linux
  the first terminal found is used (x-terminal-emulator, gnome-terminal, konsole, ...).
- **Ask AI from search:** every Spotlight query gets an *Ask AI* row (start with `?` to put it
  first); Enter sends it to the chat widget.
- **Disable AI** with one toggle in the tray or Settings - the widget, the search row and
  every AI call go away.

## Notification center
A bell in the dock collects everything that wants attention: notifications raised by web
widgets' pages (the host shims `window.Notification` inside each frame), the AI assistant's
`notify` tool, downloads and update notices. Unread count on the bell, popover with the
list, click an item to jump to the web widget or open its link; right-click the bell to
clear. System toasts for web/AI notifications can be switched off in Settings.

## Themes
Nine presets (Aero, Midnight, Frost, Emerald, Sunset, Rose, Amber, Mono, Clear) from the tray menu or Settings. Any preset can be customised - glass tint and strength, accent, text colour, border brightness, highlight sheen and corner radius - and reset again in one click. The Aero Search launcher and plugin widgets follow the theme too.

## Web widgets
Tray - "Create widget from web address..." (or Settings - Extensions - Web widgets) turns any page into a sidebar pane: a Grafana board, a Proxmox console, a Home Assistant dashboard, any LAN device. Web widgets resize, dock and free-float like every other widget, and each pane has hover controls to reload the page and zoom it from 33% to 200% (browser-style steps, remembered per widget).

Each pane is a full, isolated browser view (an Electron webview guest), not an iframe - so:
- Sites that refuse to be iframed (Google, GitHub, most login pages) render normally, because to the site it IS the top-level page.
- Logins work and persist: cookies and localStorage are first-party and live in their own persistent storage partition, surviving restarts.
- Self-signed certificates get a browser-style warning page in the pane - who the certificate claims to be, who issued it, its fingerprint - and only clicking Proceed pins that exact certificate for that address. If the certificate ever changes, the pane blocks again with a sterner warning. Pins can be revoked; nothing the app itself fetches is ever exempted.
- Downloads started inside a widget land in your Downloads folder under a non-clobbering name, with a notification when they finish.
- The minimize button parks a widget in the Task switcher; its page stays alive, so a dashboard is current the moment you restore it.
- A page that genuinely cannot load shows a plain-language explanation in the pane (wrong host name, connection refused, timeout, ...) with a Retry button instead of a silent blank box.
- The guest is hardened: no Node, no preload, sandboxed, and links it opens land in your default browser.

## Using it
- The sidebar sits on the desktop, docked to the right edge. Transparent areas let clicks pass through to whatever is behind.
- Hover the top of the sidebar to see the toolbar: settings (gear) and hide.
- **Tray icon**: click to show/hide. Right-click for widgets, position, always-on-top, launch at startup, and quit.
- **Ctrl+Alt+W** shows or hides the sidebar from anywhere.
- The search hotkey is fully reconfigurable: Settings - Search & general, click the box and
  press any combination. If it is already owned by another app, Aero Search says so and falls
  back to one that is free.
- Position: dock right, dock left, or free-form - on any monitor.
- **Multiple monitors**: docked mode has a display picker (tray - Position, or Settings - Layout) and falls back to the primary if that monitor is unplugged. Free-form mode spans every display, so widgets drag between monitors; positions are clamped onto real screens, so a widget can never strand in the dead zones of an offset or mixed-size arrangement. Mixed DPI is handled properly - the span is computed in physical pixels and enforced through Win32, so a 4K display at 150% next to a 100% display maps exactly.
- **Resizing**: every widget has a corner grip. Drag it to resize, double-click it to go back to the default size. Docked widgets resize in height; free-form widgets resize in both directions. Text and gauges scale with the widget.
- **Free-form mode**: the window becomes a transparent, click-through canvas over the whole monitor and each widget can be dragged anywhere on it. Turn on "Snap to grid" to align them.
- Sizes and positions are remembered **separately for each mode**, so switching between docked and free-form never disturbs the other layout. "Reset widget sizes & positions" in Settings (or the tray) clears them.
- Settings are saved to `%APPDATA%\BE-Aero Desktop\settings.json`.

## Aero Search (Spotlight-style)
- Press **Alt+Space** from anywhere. If another app already uses it, Aero Search falls back to Ctrl+Space, then Ctrl+Alt+Space, then Win+Shift+Space. The sidebar search bar shows which hotkey is active, and you can choose one in Settings.
- What it searches: Start Menu apps, **installed Store/UWP apps and PWAs** (Calculator, Photos, Terminal and friends, which are not in the Start Menu's shortcut tree), Windows Settings pages, and files and folders in Desktop, Documents, Downloads, Pictures, Music and Videos (OneDrive folders included). The index is rebuilt every 30 minutes, or from the tray with "Rebuild search index".
- Results are grouped by type (Applications, Settings, Documents, Images, ...). Matching tolerates typos ("calculater"), acronyms ("vsc" finds Visual Studio Code) and partial words. Items you open often rank higher.
- Typing a calculation such as `2+3*4`, `sqrt(16)` or `15%` shows the result; Enter copies it.
- The last result is always a web search, shown under its own "Web search" heading naming the engine so it is never confused with a local file. It opens in whichever browser Windows has set as default; the engine (Bing, Google, DuckDuckGo or Brave) is chosen in Settings.
- Applications show their real icon: Start Menu shortcuts are resolved to the program they point at rather than showing the generic shortcut glyph.
- Keys: Up/Down to move, Enter to open, Ctrl+Enter to show in folder, Tab to accept the suggestion, Esc to close.
- A preview pane shows a thumbnail, size, dates and a text snippet.
- Commands: `aero:reindex`, `aero:clear-history`.

The design borrows ideas from [HorusSearch](examples/HorusSearch-master): result categories, edit-distance ranking, launch-frequency boosting, the Alt+Space hotkey and the 30-minute re-index. The code is a new JavaScript implementation, not copied from HorusSearch, which is GPL-3.0.

## Extending it
Aero Widgets has two extension points, both documented in **[docs/SDK.md](docs/SDK.md)**.

- **Plugin widgets** - drop a folder with an `aero-widget.json` manifest and an HTML entry
  point into `%APPDATA%\Aero Widgets\plugins\` and it becomes a widget, with a resize grip
  and free-form placement like any built-in one. Plugins run in a sandboxed iframe on an
  opaque origin and reach the host only through the SDK bridge, gated by the permissions
  they declare (`telemetry`, `storage`, `theme`, `open-external`). A working example is in
  [`examples/plugins/cpu-sparkline`](examples/plugins/cpu-sparkline).
- **App panes** - turn on the local API in Settings and a program on the machine can push
  a live status pane (title, lines, metrics, progress, links) over HTTP from any language.
  The server listens on loopback only, rejects browser origins, and renders pane content as
  text, never HTML.
- **Per-app pairing** - there is no shared password. Each program pairs once: it asks, you
  approve a dialog naming it and what it wants, and it gets its own token with its own
  capabilities (`panes`, `telemetry`). Apps are isolated - pane ids are scoped per app, so
  one program can never read, overwrite or delete another's panes - and every pane shows
  which program pushed it. Settings lists connected programs with per-capability Allow /
  Block and a Disconnect button that revokes the token and removes its panes.
- **Tokens are bound to the program's executable - and its content.** Signed programs are
  bound to their Authenticode publisher (in-place updates by the same signer keep working;
  a swapped or stripped binary is refused), unsigned programs to their exact SHA-256. The
  pairing dialog shows the verified publisher, or warns when the program is unsigned.
- **Tokens are bound to the program's executable.** At pairing, Windows is asked which
  process owns the connection; the dialog shows the binary and the token is tied to it.
  Every later request re-checks the caller, so a token stolen from one program is useless
  in the hands of any other binary. Pairing fails closed if the caller cannot be identified.

## Linux
`npm run dist:linux` produces `release/be-aero-desktop-<version>.tar.gz`. Install it with the
one-shot script:

```bash
sudo ./install-linux.sh be-aero-desktop.tar.gz     # installs /opt + menu entry + CLI
sudo ./install-linux.sh --uninstall                   # removes it again
```

On Linux the app runs on X11/XWayland (Wayland offers no window positioning), takes input
through an X11 shape region (docked: the whole strip; free-form: the widget rects), indexes
`.desktop` applications (including Flatpak and Snap exports) in Aero Search, and launches
them via `gio launch`. Launch-at-startup writes an XDG autostart entry. Stock GNOME has no
system tray - use the toolbar's menu button, or install the AppIndicator extension if you
want the tray too.

Something off on your desktop? Run `be-aero-desktop --doctor` - it prints the session type,
display map and capability report to paste into a bug report.

Windows-only features degrade cleanly on Linux: the app dock and app-identity binding are
Windows subsystems (Win32 window enumeration, Authenticode), so the dock shows only parked
web widgets and the local API runs with token + pairing consent but without binary binding.
deb/AppImage targets need a Linux build host; the tar.gz builds anywhere.

## Updates
The app checks the project's GitHub releases a few times a day (and on demand from
Settings or the tray's "Check for updates..."). On the installed Windows build it
updates itself: the new installer downloads in the background, its hash is verified
against the release manifest, and the app restarts into the new version with a brief
notification. Turn "Install updates automatically" off in Settings to go back to
notify-only. The portable exe and the Linux build can't replace themselves in place,
so they show a notification that opens the release page instead. The repository it
watches comes from the `repository` field in `package.json`.

## Development
```powershell
npm.cmd install
npm.cmd start          # run from source
npm.cmd run dist       # build installer + portable exe into release/
npm.cmd run icons      # regenerate build/icon.png and build/icon.ico
```
(`npm.cmd` is used because PowerShell script execution is disabled on this machine.)

## Output
- `release/BE-Aero Desktop Setup 1.0.0.exe` - installer (Start Menu + desktop shortcut, uninstaller).
- `release/BE-Aero Desktop 1.0.0.exe` - portable single exe, no install needed.

## Layout
```
src/main/main.js        window, tray, shortcuts, IPC, docking
src/main/preload.js     safe bridge (window.aero)
src/main/store.js       JSON settings store
src/main/telemetry.js   CPU/RAM sampling
src/main/spotlight.js   search window, hotkey, open/reveal/preview
src/main/indexer.js     builds the search index (apps, settings, files)
src/main/search.js      fuzzy ranking, categories, calculator
src/renderer/spotlight.*  search window UI
scripts/cdp-check.js    dev smoke test (run the app with --remote-debugging-port=9333)
src/main/themes.js      theme presets -> CSS variables
src/main/uwp.js         Store/UWP app discovery and package logos
src/main/plugins.js     plugin manifest discovery and validation
src/main/panes.js       app-pane model (sanitising everything the API accepts)
src/main/apps.js        paired client apps: identity, capabilities, revocation
src/main/peer.js        resolves which executable owns a loopback connection
src/main/tasks.js       open-window enumeration and control (task switcher)
src/shared/displays.js  multi-monitor geometry: union span, dead-zone clamping
src/main/api-server.js  the local HTTP API for other applications
src/shared/hotkey.js    accelerator parsing, shared by main and renderer
sdk/aero-sdk.js         the client library plugins load
src/renderer/           index.html, styles.css, app.js (the widget UI)
src/renderer/clock.js   the seven clock faces
src/renderer/telemetry-view.js  the telemetry gauge styles
src/renderer/layout.js  widget drag, resize and per-mode geometry
src/renderer/extensions.js  hosts plugin iframes and app panes
scripts/make-icon.js    dependency-free icon generator
scripts/cdp-widgets.js  dev smoke test for clock/telemetry/layout/themes
scripts/cdp-layout.js   dev check that each mode's layout persists
scripts/cdp-shot.js     screenshot a running window over CDP
```


<img width="1919" height="1079" alt="BE-Aero-Desktop-promo" src="https://github.com/user-attachments/assets/77813651-e513-4ee7-82c2-dc379ffc4104" />

<img width="1919" height="1079" alt="BE-Aero-Desktop" src="https://github.com/user-attachments/assets/4e12c61a-76ea-46b8-82b2-3a27cbd3880b" />

