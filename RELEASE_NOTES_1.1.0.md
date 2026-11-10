# BE-Aero Desktop v1.1.0

The biggest update since launch. The assistant can now **listen and speak** with offline
voice, keeps long conversations healthy on **local models**, and lets you edit and resend
messages. The desktop gains a **media controller**, a **power menu** and a smarter dock, and
on Linux the dock finally **mirrors your real windows** on Wayland.

Installed Windows copies update automatically. Linux: rerun the installer (below).

## Highlights

### Voice for the assistant, fully offline
- **Dictation with Whisper.** Click the microphone in the chat, or press **Ctrl+Alt+M**
  from anywhere, and speak. One phrase is transcribed, then the microphone turns itself
  off; a setting keeps it listening instead. A short tone confirms on and off.
- **Choose your engine and model.** Download Whisper once from Settings > Voice input:
  Tiny (75 MB), Base (148 MB, recommended) or Small (488 MB). Windows Speech Recognition
  remains the built-in fallback.
- **Auto send.** Dictated messages send themselves after a pause you choose (1 to 30
  seconds). An **A** button on the chat turns it on and off.
- **Your devices.** Pick the microphone (with a level test) and the speaker.

### Natural spoken replies
- **Piper neural voices.** 180 voices in 58 languages, including voices with many
  speakers, downloaded from Settings > Text to speech. Long replies start speaking after
  the first sentence.
- **Read any reply aloud.** Every reply has a speaker button in its top right corner;
  click again to stop. You can also have every reply read automatically.
- **Tune the voice.** Rate, volume and pitch, plus expressiveness, rhythm and the pause
  between sentences for Piper voices. The assistant can also speak on request.

### A better chat
- **Edit, resend and delete messages.** Hover one of your messages to edit it in place and
  resend, resend it as is, or delete it with its reply. If you stop a reply, your message
  keeps a **Resend** button.
- **Text size** buttons in the chat header.

### Built for local models
- **Context buffer.** Long conversations stay within the model's window: old tool output
  is trimmed first, then older turns are summarized and carried forward. Your saved
  history is never deleted. Type `/compact` to do it now; the status line shows how full
  the context is.
- **Survives server hiccups.** If a local server restarts, swaps models or drops the
  connection, the request is retried automatically. If it stays down, the chat waits and
  resumes your message when it is back. A dot in the chat header shows the connection.
- **More providers.** llama.cpp, the BE AI Engine fabric and a running BE-Code session
  join Ollama, LM Studio, OpenAI and Anthropic.

### Media controller widget
- See what is playing anywhere on your computer (Spotify, a browser tab, a player) with
  cover art, play/pause, previous/next and volume.
- The progress line moves in real time, and you can **drag the circle to seek**.
- Resize it (art and text grow with it) or minimize it to the dock. The assistant can
  check and control playback too.

### Dock and desktop
- **Power menu.** A power button at the far end of the dock offers Lock, Switch user,
  Log off, Sleep, Restart and Shut down. Log off, Restart and Shut down ask first. Turn it
  off or move it to the left in Settings > Widgets.
- **Drag to reorder** pinned icons.
- **Taskbar-style clicks.** Click an app to bring it forward, click again to minimize it.
- **Minimize any widget** to the dock and click its tile to bring it back.
- **Stacked widgets.** In free-form mode the widget you click comes to the front, and the
  order is remembered. New web widgets open in the middle of the screen.
- **Spell checking and right-click menus** in text fields and web widgets, with spelling
  suggestions, copy and paste, link actions, and back/forward/reload for web pages.

### Linux
- **The dock mirrors real windows on Wayland** through a small GNOME Shell helper that the
  installer sets up. Enable it once and log out and back in. X11 sessions use `wmctrl`.
- **Telemetry** now shows disk and network figures.
- **Media control** works through `playerctl`.

## Fixed
- Linux telemetry showed no disk or network figures.
- The assistant's tools for focusing, minimizing and closing app windows did not work.
- Voice input listened to the Windows default recording device instead of the one you
  chose.

## Privacy
Voice recognition, speech and models run on your computer; nothing is sent anywhere.
Whisper and Piper are downloaded only when you ask, from their official releases, and
every file is checked against a checksum shipped with BE-Aero before it is installed.

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
gnome-extensions enable be-aero-dock@be-ai-research   # then log out and back in (Wayland)
```
