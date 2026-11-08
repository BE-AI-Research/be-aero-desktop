# BE-Aero Desktop v1.0.7

Linux: a reinstall over a running copy can no longer leave the app
"not launching". Installed Windows copies update automatically.

## Fixed

- **Reinstalling over a running instance.** The installer replaced
  `/opt/be-aero-desktop` while the old copy kept running headless - and kept
  the single-instance lock, so every new launch quit silently. Three layers
  now make that impossible:
  - the installer stops a running copy before replacing its files;
  - the app clears stale instances itself at startup - on Linux a process
    whose binary was replaced is marked `(deleted)` in `/proc`, an
    unambiguous fingerprint - before taking the lock;
  - a launch refused by the lock says so on the terminal instead of exiting
    without a word.
- The X11 relaunch no longer races its own child for the instance lock.
- The dock's `/proc` scan is cached between polls.

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```

If an older copy is wedged right now: `pkill -f be-aero-desktop`, then launch.
