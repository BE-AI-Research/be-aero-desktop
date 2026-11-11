# BE-Aero Desktop v1.2.1

Scheduled tasks rebuilt on BE-Code's proven model, support for every model's way of calling
tools (including Qwen's XML), and better handling when a local model is evicted or reloaded.

## Scheduled tasks

Tasks now use the same scheduling model as BE-Code.

- **Say when in plain words.** One "When" field accepts `daily 09:00`, `weekdays 08:30`,
  `every 2h`, `in 20m`, `mon,thu 14:30`, `at 2026-12-01 09:00` or a cron line, and also
  everyday phrasing like "every weekday at 8:30 am". The form previews the next three run
  times and explains anything it can't read. A quick-pick menu fills in common times.
- **Missed times run once.** If the computer was asleep or BE-Aero was closed, a missed
  daily or weekly time now runs once when you're back. Before, it was skipped if more than
  an hour late.
- **Failing tasks pause themselves** after 3 failures in a row, with a notification. Each
  task shows its last result, and has pause/resume and a two-click delete.
- **A runtime cap** (30 minutes by default) stops a run that hangs.
- **Choose the model tasks run on.** Settings > AI assistant > "Model for scheduled tasks",
  and each task can pick its own. Using the model another program on the same server
  already has loaded avoids swapping models in and out.
- **Tasks can use their own provider.** Settings > AI assistant > "Provider for scheduled
  tasks" lets tasks run on a different server from chat, both at once: for example chat on
  a model on this PC and tasks on a shared server on your network.
- **Tasks finish with an answer.** A run that reaches its tool-step limit (10 for tasks)
  now gets a final answer from what it found instead of stopping with nothing. A lookup
  repeated within one run (same page, same search) isn't fetched again, and when sources
  disagree the model reports both rather than re-checking over and over.
- **Read the result aloud.** A task can say its result on your speakers when it finishes,
  handy for a morning briefing. Turn it on in the task's form; the assistant can set it too.
- **Easier for the assistant.** Small local models now create tasks reliably, and the
  assistant can pause and resume tasks. Tasks it creates are marked "AI".

### Fixed
- A task that fired while its conversation was busy was reported as finished before it
  ran. It then ran later without its permission setting, so it could stop to ask for
  permission with nobody there. Tasks now wait for the conversation to be free.
- A task's status could stay "running" forever if BE-Aero closed mid-run.
- Tasks repeating more often than every 5 minutes are no longer allowed (existing ones are
  raised to 5 minutes).

Your existing tasks are converted automatically.

## Every model's way of calling tools
BE-Aero now understands the tool-call formats local models actually use, as BE-Code does:
native JSON calls, `<tool_call>{json}</tool_call>`, **Qwen's XML layout**
(`<function=...><parameter=...>`), Llama's bare JSON, Mistral's `[TOOL_CALLS]`, Gemma's
`tool_code` blocks, and fenced JSON. A tool call written as text is run, never mistaken for
the final answer.
- **Thinking models** (Qwen3, DeepSeek-R1, gpt-oss): reasoning is kept off the screen and out
  of the conversation, and while the model thinks the chat shows "Thinking..." instead of
  looking stuck.
- **Per-model settings:** models without reliable native tool support (Gemma, Phi,
  DeepSeek-R1) automatically use text tool calls. If a server rejects tool calls, BE-Aero
  switches to text tool calls for that model. You can force either mode under Settings >
  AI assistant > Tool call format.
- **Forgiving:** double-encoded arguments, "parameters" instead of "arguments", trailing
  commas and similar slips are accepted. A tool call cut off mid-way, or an empty reply
  after a long think, gets one automatic retry.

## Local models (Ollama, LM Studio)
- **Ollama (LAN server)** is a new provider for a shared Ollama server on your network. Type
  just the address (e.g. `192.168.1.20`); the port and `/v1` are added for you.
- **Evicted models are noticed.** Before each request BE-Aero checks whether the model is
  still loaded. If another model or idle expiry unloaded it, the chat says the reply will
  take longer while it reloads.
- **The context buffer follows the model's real window.** If a model is reloaded with a
  smaller context window, the conversation is summarized to fit instead of being cut off
  by the server.
- **Models unload when you're done.** A minute after the last reply or task (your choice: 30
  seconds to 30 minutes, or the server's own setting), BE-Aero tells Ollama to unload the
  model, so a shared server's memory is free for other models. Another message in the
  meantime keeps it loaded.
- **Unload a model that's holding the server.** If your request waits because another model
  occupies the server, the chat offers "Unload <model> and continue": one click frees the
  server and sends your request again. Settings can make this automatic or turn it off;
  scheduled tasks, with nobody there to click, do it on their own after a wait.
- **Waits are explained.** If the model is silent for 45 seconds (loading, re-reading a long
  conversation, or busy with another request), the status line says so. After 3 minutes it
  reminds you that Stop is safe.
- Dropped connections keep the existing protection: automatic retries, then waiting for
  the server and resuming your message.

## Also in this release
- **The assistant opens pages in your own browser.** browser_open now uses your normal
  browser and profile (signed in, with your bookmarks) instead of a separate empty profile
  that looked like a private window. When the assistant needs to click or type in a page it
  still uses its own profile, because browsers don't allow automating your main one.
  Settings > AI assistant > "When the assistant opens a web page" can restore the old
  behaviour.
- **Choose the assistant's browser.** Settings > AI assistant > "Browser the assistant uses"
  lists the browsers installed (Chrome, Edge, Brave, Chromium, Firefox), so the assistant can
  use a different browser from your default. Firefox opens pages; clicking and typing use a
  Chromium browser, since Firefox can't be automated this way.
- **Linux: notifications from every app.** The notification center now also collects other
  apps' desktop notifications (mail, calendar, chat, Flatpak apps...), labelled with the app.
  It only listens - GNOME still shows its own pop-ups. Settings > Notifications turns it off.
- **The notification panel is readable on any background.** It had no background at all
  (a broken style), so it disappeared over matching wallpaper; it's now a frosted pane.
- **Chat scrolling stays where you put it.** At the bottom, the chat follows new replies; scroll
  up and it stays put (a "New messages" button appears) until you come back down or send a
  message. Each tab keeps its place, and so does the chat after being minimized - it used to
  jump back to the top, or open partway up instead of at the latest message.
- **Chat:** the edit / resend / delete buttons under messages are visible again.
- **Linux:** the per-core CPU heatmap no longer flickers between 0% and 100%.

## UAC shield in the dock (Windows)
A shield beside the notification bell shows User Account Control at a glance:
- **Amber while an admin prompt is open**, and pulsing when Windows is holding a prompt back
  (a program in the background asked); click it to show that prompt.
- **Its menu sets the prompt level**, the same four positions as the Windows slider: always
  notify, the Windows default, notify without dimming the desktop, or never notify (shown in
  red). Changing it asks for approval once, and the result is checked back.
- Turn it off under Settings > Dock.

Installed Windows copies update automatically.

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```
