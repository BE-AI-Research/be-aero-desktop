# BE-Aero Desktop v1.1.1

Two Linux fixes: the media controller and Piper voices.

## Fixed

- **The media widget said "unavailable" on Linux.** It relied on `playerctl`, which most
  distributions (Debian included) do not install. It now talks to media players directly
  over D-Bus, which every desktop session has, so Spotify, Firefox, Chrome, VLC and other
  players show up with title, artist, cover art and a live progress line. Play/pause,
  next/previous and dragging to seek work the same way. If `playerctl` is installed it is
  still used.
- **Piper voices failed on Linux with a phoneme error.** Piper's helper libraries are
  loaded by names the download provides only as links; when a link was missing, Linux
  used the system's older espeak-ng instead, which Piper cannot work with. BE-Aero now
  makes sure Piper's own libraries are in place, repairing existing installs without a
  new download. If Piper still fails, the chat shows its full error.

Installed Windows copies update automatically (no change in behaviour on Windows).

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```
