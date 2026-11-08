# BE-Aero Desktop v1.0.0

The first public release of BE-Aero Desktop — an Aero/Mica desktop shell for Windows 11
that grew out of a widget board and became an app platform: widgets, a Spotlight-style
launcher, a macOS-style application dock, sandboxed web apps, and an SDK with real
permissions so other applications can hook in.

## Highlights

**Widgets** — clock (7 styles), weather with a 7-day forecast, system telemetry
(5 styles, live CPU/RAM/disk/net), scratchpad with save-to-file, and a search bar.
Docked or free-form layouts per monitor, snap-to-grid, lockable, all saved to a plain
`settings.json` you can export/import — updates never touch it.

**Aero Search** — Spotlight-style launcher on a reconfigurable hotkey. Indexes Win32
apps, Store/UWP apps, settings and files; previews with real icons; web search through
your default browser; calculator; themed to match the shell.

**Application dock** — macOS-style dock that mirrors open windows, supports pinning,
click-cycling between windows of an app, favicons for parked web apps, native context
menus, and left/center/right alignment.

**Web widgets** — turn any URL into a desktop widget. Full Chromium rendering (sites
that refuse iframes still work), isolated persistent storage, per-widget zoom and
reload, minimize-to-dock, downloads, and browser-style certificate gating with
pinning for self-signed certs.

**App platform** — a sandboxed plugin SDK (`aero-plugin://`) with user-granted
permissions, live plugin settings, host theming; plus a local HTTP API with pairing
consent, per-app tokens, pane isolation, and app identity bound to the executable's
Authenticode signature (or SHA-256 hash) — a swapped binary loses its access.

**Shell behavior** — multi-monitor with mixed DPI handled correctly, widgets sit on
the desktop layer behind your apps (or float on top if you prefer), tray menu with
per-widget toggles, launch at startup.

**Updates** — the app checks GitHub releases and notifies you when a newer build is
published here. Notify-only: you choose when to download.

## Downloads

| File | What it is |
| --- | --- |
| `BE-Aero Desktop Setup 1.0.0.exe` | Windows installer (Start Menu entry, uninstaller) |
| `BE-Aero Desktop 1.0.0.exe` | Windows portable — run it from anywhere, no install |
| `be-aero-desktop-1.0.0.tar.gz` | Linux build |
| `install-linux.sh` | One-shot Linux installer (`sudo ./install-linux.sh be-aero-desktop-1.0.0.tar.gz`) |

## Install

**Windows:** run the Setup exe, or just launch the portable exe. Windows SmartScreen
may warn because the build is not code-signed yet — choose "More info → Run anyway"
if you trust this source.

**Linux:** download the tar.gz and `install-linux.sh` into the same folder, then
`sudo ./install-linux.sh be-aero-desktop-1.0.0.tar.gz`. Uninstall later with
`sudo ./install-linux.sh --uninstall`. Windows-only subsystems (app dock window
enumeration, Authenticode identity) degrade cleanly.

## Notes

- Settings, layout, pins, themes, trusted certificates and paired apps live in
  `settings.json` in your profile; a backup copy is written at every start.
- SDK and local API documentation: `docs/SDK.md`.
