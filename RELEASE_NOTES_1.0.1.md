# BE-Aero Desktop v1.0.1

Bug-fix release from first-round QA. This is also the first release existing
installs pick up automatically: installed Windows copies of v1.0.0 download it
in the background, verify it, and restart into it on their own.

## Fixed

- **Launch at startup (Windows) now heals itself.** Startup registration used
  to be written once and could go stale when the exe moved (reinstall, rename,
  dev build vs installed build), leaving a toggle that looked on but did
  nothing. The app now reconciles on every boot: it re-asserts the correct
  registry entry while the setting is on and removes any stale BE-Aero/Aero
  Widgets entries pointing at old paths. Other apps' entries are never touched.
- **Launch at startup on Linux.** The same setting now writes an XDG autostart
  entry (`~/.config/autostart/be-aero-desktop.desktop`), rewritten each boot so
  a moved install heals itself the same way.
- **Linux install: app icon and terminal command work.** The tar.gz is built on
  Windows, which strips Unix permission bits, so nothing in it was executable -
  the menu entry silently failed and `be-aero-desktop` could not run from the
  terminal. `install-linux.sh` now restores the modes (app binary, crashpad
  handler, and the setuid chrome-sandbox) and refreshes the icon cache.
  Re-run the installer to fix an existing install:
  `sudo ./install-linux.sh be-aero-desktop.tar.gz`

## Downloads

Stable-named copies of each artifact are attached (`BE-Aero-Desktop-Setup.exe`,
`BE-Aero-Desktop-Portable.exe`, `be-aero-desktop.tar.gz`, `install-linux.sh`),
so the install commands in the README always fetch the latest release.
