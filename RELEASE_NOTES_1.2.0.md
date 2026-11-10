# BE-Aero Desktop v1.2.0

The assistant can now **show** you things, not just tell you, and the chat is a lot
smoother.

## New

### Visuals from the assistant
Ask for a comparison, a trend, a schedule or a summary and the assistant can answer with a
**visual**: a chart, table, dashboard or diagram drawn right in the chat.
- Visuals size themselves to fit, and the assistant adds a short comment below.
- Click **↗** on a visual to keep it on the desktop as its own resizable widget. From there
  you can reload it, send it back to the chat, or delete it.
- The assistant can update a visual it already made instead of starting over.
- **Safe by design:** each visual runs in a locked-down frame. It cannot reach the app, your
  files or your settings, and it cannot send anything over the network. It can only load
  chart libraries from a few well-known public sources.

## Improved

### A faster chat
- **Smooth streaming:** long replies no longer make the sidebar stutter while they arrive.
  The slowest frames dropped from about 134 ms to 34 ms in our tests.
- **Long conversations open about 10x faster.** The latest 80 messages show first; a
  **Show earlier messages** button loads the rest.
- **No more jump at the end of each reply.** The chat no longer redraws itself.
- **Reading back while a reply streams** no longer pulls you down to the bottom.

### Layering
- The settings panel and the toolbar with the main menu always stay on top of widgets,
  however you stack them.

## Fixed
- **Whisper dictation could fail with "fetch failed".** Each phrase now uses a fresh
  connection to the local speech server, with one automatic retry that restarts the server
  if it stopped. If it still fails, the message says why, and the server's log is kept in the
  app's data folder (`whisper/server.log`).

Installed Windows copies update automatically.

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```
