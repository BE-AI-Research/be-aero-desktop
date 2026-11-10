# BE-Aero Desktop v1.1.0

Feature release: a media controller, voice for the assistant, a context buffer and
reconnection for local models, a real window dock on Linux, and a round of desktop polish.
Installed Windows copies update automatically.

## New

- **Media controller widget.** What is playing anywhere on the machine (Spotify, a browser,
  a player), with cover art, progress, play/pause, previous/next and volume up/down/mute.
  Windows reads the system media session; Linux uses `playerctl` (MPRIS) and
  `wpctl`/`pactl`. The assistant gets `media_status` and `media_control`.
- **Voice mode for the assistant.** A microphone button dictates into the message box.
  Transcription uses **Whisper** (whisper.cpp), downloaded once from Settings > Voice input
  in three sizes, checked against pinned checksums and run on your computer; Windows
  Speech Recognition is the basic fallback. **Auto send** sends the dictated message after
  a silence you choose (1-30 s), with an on/off button right on the chat widget. A new
  **Text to speech** section reads replies aloud on the speaker you pick, with voice,
  rate, volume, pitch and a test line. Microphone picker with a level test. Nothing
  leaves the machine.
- **Context buffer.** Conversations stay inside a token budget the way BE-Code keeps small
  local models honest: old tool output is trimmed first, then the older conversation is
  summarized by the model and carried forward, and the chat history itself is never
  deleted. The budget is automatic per provider (16k for local servers) or set it yourself;
  `/compact` does it on demand and the status line shows how full the context is.
- **Reconnection for local servers.** A server that restarts, swaps models or drops a stream
  no longer loses your turn: calls retry with backoff (rate limits honour Retry-After, a
  rejected key never retries). If the server stays away, the chat waits, polls, and resumes
  the pending message by itself when it is back. A connection dot in the chat header shows
  the state; click it to check.
- **Shared inference presets.** llama.cpp, the BE AI Engine fabric and a running **BE-Code
  session** (its Application API over the local socket, answers only) join Ollama and
  LM Studio as providers. Any OpenAI-compatible server on your LAN still works as before.
- **Linux dock mirrors real windows.** A small GNOME Shell helper (installed by the Linux
  installer, enable it once) gives the dock the compositor's window list on Wayland: titles,
  focus and minimized state, click to focus or minimize, close. X11 sessions use
  `wmctrl`/`xprop`; without either the dock falls back to running applications as before.
  Settings shows which source is active and can install the helper.
- **Minimize any widget to the dock.** Hover a widget for its minimize button; it parks in
  the dock as a glyph tile and comes back with a click (web widgets and the AI chat already
  did this).
- **Dock click works like a taskbar.** Click a running app's tile to bring it forward, click
  again to minimize it, click a minimized one to restore it; apps with several windows cycle.
- **Stacked widgets in free-form mode.** Clicking or dragging a widget raises it above the
  others, and the order is remembered.
- **Spell checking and right-click menus.** Text fields in the sidebar and pages inside web
  widgets get spelling suggestions, add-to-dictionary, cut/copy/paste, link and image
  actions, and back/forward/reload/open-in-browser for web widgets. Toggle it in Settings.
- **AI chat text size** buttons (persisted), and new web widgets open in the middle of the
  display in free-form mode instead of the sidebar column.

## Fixed

- **Linux telemetry** showed no disk or network figures. Disk reads the root filesystem (or
  any mount point you type), network reads `/proc/net/dev`.
- The assistant's window tools (`list_running_apps`, `focus_app`, `minimize_app`...) were
  wired to the scheduler instead of the window list and could not work.

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
gnome-extensions enable be-aero-dock@be-ai-research   # then log out and back in (Wayland)
```
