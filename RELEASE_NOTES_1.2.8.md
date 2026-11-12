# BE-Aero Desktop v1.2.8

The assistant gets a workspace of its own: it can build desktop widgets and its own tools. Your
devices stay in touch through a relay even when they are never online together. There's a sound
mixer with Bluetooth, and easy setup for online AI services.

- **AI widgets**: ask the assistant for a widget and it builds one for your desktop.
- **AI tool workspace**: the assistant writes, tests and reuses its own tools, sandboxed by
  default.
- **BE-Aero Relay Server**: a separate, end-to-end encrypted relay for your devices, with Shared
  storage and a copy of your File Pool.
- **Sound widget**: the output device, each app's volume, and Bluetooth devices.
- **Online AI providers**: Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI and more, ready to use.
- **Scratchpad**: several notes.
- **Fixes**: chat messages wait for running tasks, notifications open their app, and the
  assistant no longer opens a private-looking browser window uninvited.

## AI widgets

Ask "make me a widget that…" and the assistant builds it as a widget on your desktop: a
countdown, a to-do list, a converter, a dashboard for an online service.

- **Each widget is a folder** in your AI Folder under **AI Widgets** (`index.html`). Edit it
  yourself and the widget reloads.
- **Sandboxed:** a widget can't touch the app, your files or your other widgets.
- **Network only where you allow it.** A widget that needs a website asks once:
  "Allow *widget* to reach these sites?" Without your approval, those sites stay blocked. The
  approvals are kept out of the assistant's reach, and you can review or revoke them in Settings
  > AI assistant.
- **Widgets can remember things** (a to-do list, settings) and fetch from approved sites, even
  ones that don't normally accept requests from a page like this.
- **Any .html file can become a widget:** right-click it in the file browser > **Create widget**.
  Its stylesheets and images come with it.
- **AI Artifacts:** the AI Folder's "Visuals" folder is now **AI Artifacts**, a general home for
  what the assistant makes. Existing visuals move over automatically.

## AI tool workspace

The assistant can build itself tools for things you do often, test them, then use them like its
built-in ones. Its tools live in the AI Folder under **AI Tools**.

- **Sandbox tools (the default)** run isolated: no files, no network, no access to the system.
  They can only use the assistant's existing tools, with the same permission prompts as the
  assistant itself. A runaway tool is stopped after 30 seconds.
- **Script tools** (PowerShell, bash or Python) can do what the sandbox can't, but **only after
  you approve that exact code** in a prompt that shows it. Any change, even an edit by hand,
  needs your approval again.
- **Settings > AI assistant** lists the assistant's tools and widgets: review, approve, revoke,
  open or delete them.

## BE-Aero Relay Server

Your devices can now stay in sync even when they are never online at the same time. The relay is
a separate small server for any always-on machine (a home server, a NAS, a cloud VM). See
[BE-Aero Relay Server 1.0.0](https://github.com/BE-AI-Research/be-aero-relay-server/releases/latest):
a Windows `.exe`, or a one-line install on Linux.

- **Store and forward.** While one of your devices is offline, the others leave its updates on
  the relay, and it collects them when it next connects:
  - theme, notes, pinned apps, conversations and task changes
  - AI requests and answers
  - clipboard and web-widget sends
- **Shared storage:** the relay appears under **Devices** in the file browser. Its **Shared
  storage** folder is open to all your devices, even when the others are off: copy files in,
  drag them in, make folders, rename and delete.
- **File Pool copy:** your File Pool, kept on the relay by whichever device is online, so you
  can open its files while your other devices are off.
- **End-to-end encrypted.** Messages are sealed for the one device they are meant for. Files and
  their names are encrypted on your devices with a key only your paired devices share. The relay
  machine can't read any of it.
- **Pair it like a device:** Settings > Devices > Pair by address, then the code the relay
  shows. It appears as a **Relay Server**, and it gets none of a device's permissions.
- **Send clipboard to / Send widget to** also list devices that are offline but reachable
  through a relay.

## Sound widget

A new widget, **Sound**:
- **Output device:** pick where sound plays.
- **Master volume** and mute.
- **One slider per app** playing sound, with its icon and its own mute.
- **Bluetooth:**
  - your paired devices, and whether each is connected
  - Connect / Disconnect
  - turn Bluetooth on or off
  - Bluetooth settings
  - battery level on Linux

On Linux it works with PulseAudio or PipeWire. The Linux installer now adds `pactl` (only the
command-line tool) when it's missing.

## Online AI providers

- **Ready to use:** Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI (Grok), Together AI,
  Fireworks and Perplexity, next to Anthropic and OpenAI. Their addresses are built in.
- **A clearer menu,** grouped: online services / on this computer / on your network / other.
- **Get a key ↗** opens the service's API-key page. **Saving a key checks it** by listing the
  service's models, and picks one. A refused key says so plainly.
- **A key per provider:** switch services and back without losing your keys. The provider for
  scheduled tasks can reuse the same key.
- **Your API keys stay in the app's background process** (encrypted) and are never sent to its
  window.

## Scratchpad

- **Several notes:** **+** starts a new note, **‹ ›** move between them, and a count shows where
  you are. An empty note is tidied away when you leave it.
- **With note sync on, all your notes sync.**
- **A minimize button** in the header, like the other widgets. Save is now an icon, so
  everything fits.

## Fixed

- **Chat messages no longer collide with scheduled tasks.** A message sent while a task is
  running waits, with a note saying which task, and goes as soon as it finishes.
- **Clicking a notification opens the app that sent it.** On Windows this uses the
  notification's own link where there is one, otherwise the app's open window, otherwise it
  launches the app. On Linux it uses the app's window or launches it.
- **The assistant no longer opens a private-looking browser window uninvited.**
  - It opens pages in **your own browser**.
  - It uses its own browser window (a separate profile, not signed in) only when it must click
    or type in a page, and by default it **asks you first**: Settings > AI assistant > "When the
    assistant needs to click or type in a page".
  - Looking at tabs never opens that window, and scheduled tasks never open it.
- **The file browser** shows devices that come online after the app started.

## Install and update

Installed Windows copies update automatically.

Linux install or update:

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```

The BE-Aero Relay Server is optional and separately installed:
[be-aero-relay-server](https://github.com/BE-AI-Research/be-aero-relay-server).
