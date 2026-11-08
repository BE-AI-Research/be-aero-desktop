# BE-Aero Desktop v1.0.6

Two Linux follow-ups from live testing on Debian GNOME, now that 1.0.5 has
the platform right.

## Fixed

- **Searching can no longer wedge the desktop.** The sidebar's search bar
  hands typed text to the launcher window and used to re-show and re-focus
  it on every keystroke. On X11/XWayland that is a focus steal per key, and
  two windows fighting for focus at typing speed can lock up the
  compositor's input handling. The launcher now takes focus only when it
  actually appears - afterwards keystrokes just update the query - and the
  sidebar's handoff reset no longer depends on a blur event that dock-type
  windows may never receive.
- **The dock mirrors running applications on Linux.** Wayland compositors do
  not let one application list another's windows (GNOME ships no API for it),
  so the dock takes the task manager's view instead: processes are matched to
  the system's .desktop applications (including Flatpaks and Snaps via their
  cgroups), and tiles show every running application with its real name and
  icon. Clicking re-activates the app - for single-instance applications,
  the common case on GNOME, that raises its existing window; the context
  menu offers launch, pin and quit. Without a window list there are no
  window titles or counts, and minimized web widgets still park here.
- The dock's empty state no longer claims "No open applications" on Linux.

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```
