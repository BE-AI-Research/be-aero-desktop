# BE-Aero Desktop v1.1.3

A fix for Whisper dictation.

## Fixed

- **Dictation could fail with "Whisper: fetch failed".** BE-Aero now opens a fresh
  connection to the local speech server for every phrase, retries once automatically, and
  restarts the speech server if it stopped. If it still fails, the message now says exactly
  why (the connection error, or how the server stopped and its last log lines), and the
  server's log is kept in the app's data folder (`whisper/server.log`).

Installed Windows copies update automatically.

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```
