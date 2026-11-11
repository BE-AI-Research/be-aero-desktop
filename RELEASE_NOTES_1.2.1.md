# BE-Aero Desktop v1.2.1

A big update for the AI assistant and for Linux.

- **Scheduled tasks**: rebuilt on BE-Code's model, and they can run on their own model and server.
- **Tool calls**: every common local-model format is understood, including Qwen's XML.
- **Local models**: BE-Aero now handles Ollama and LM Studio servers shared with other programs.
- **Browsing**: the assistant opens pages in your own browser.
- **Chat**: scrolling stays where you put it.
- **Windows**: a UAC shield in the dock.
- **Linux**: app notifications in the notification center, and clicks reach the windows behind
  your widgets.

## Scheduled tasks

Tasks now use the same scheduling model as BE-Code. Your existing tasks are converted
automatically.

- **Say when in plain words.** One "When" field accepts `daily 09:00`, `weekdays 08:30`,
  `every 2h`, `in 20m`, `mon,thu 14:30`, `at 2026-12-01 09:00` or a cron line, and also
  everyday phrasing like "every weekday at 8:30 am". The form previews the next three run times
  and explains anything it can't read. A quick-pick menu fills in common times.
- **Missed times run once.** If the computer was asleep or BE-Aero was closed, a missed daily or
  weekly time runs once when you're back. Before, it was skipped if more than an hour late.
- **Their own model and server.** Settings > AI assistant has "Provider for scheduled tasks" and
  "Model for scheduled tasks", and each task can also pick its own model. Chat and tasks can
  use different servers at the same time: for example, chat on a model on this PC and tasks on a
  shared server on your network.
- **Tasks finish with an answer.** A run gets up to 10 tool steps. If it reaches that limit, it
  gets one last turn to answer from what it found, instead of stopping with nothing.
  - The same page or search is never fetched twice in one run, so a task can no longer
    re-check one site until it starts refusing requests.
  - When sources disagree, the model reports what each says instead of checking again and again.
- **Read the result aloud.** A task can say its result on your speakers when it finishes, which
  suits a morning briefing. Turn it on in the task's form; the assistant can set it too.
- **Failing tasks pause themselves** after 3 failures in a row, with a notification. Each task
  shows its last result, and has pause/resume and a two-click delete.
- **A runtime cap** (30 minutes by default) stops a run that hangs.
- **Easier for the assistant.** Small local models now create tasks reliably, and the assistant
  can pause and resume tasks. Tasks it creates are marked "AI".

### Fixed

- **Tasks no longer run without their permission setting.** A task that fired while its
  conversation was busy was reported as finished before it ran. It then ran later without its
  permission setting, so it could stop to ask for permission with nobody there. Tasks now wait
  for the conversation to be free.
- A task's status could stay "running" forever if BE-Aero closed mid-run.
- Tasks repeating more often than every 5 minutes are no longer allowed. Existing ones are raised
  to 5 minutes.

## Every model's way of calling tools

BE-Aero now understands the tool-call formats local models actually use, as BE-Code does:
- native JSON calls
- `<tool_call>{json}</tool_call>`
- **Qwen's XML layout** (`<function=...><parameter=...>`)
- Llama's bare JSON
- Mistral's `[TOOL_CALLS]`
- Gemma's `tool_code` blocks
- fenced JSON

A tool call written as text is run, never mistaken for the final answer.

- **Thinking models** (Qwen3, DeepSeek-R1, gpt-oss): reasoning stays off the screen and out of
  the conversation. While the model thinks, the chat shows "Thinking..." instead of looking stuck.
- **Per-model settings:** models without reliable native tool support (Gemma, Phi, DeepSeek-R1)
  automatically use text tool calls. If a server rejects tool calls, BE-Aero switches to text
  tool calls for that model. You can force either mode under Settings > AI assistant > Tool call
  format.
- **Forgiving:** double-encoded arguments, "parameters" instead of "arguments", trailing commas
  and similar slips are accepted. A tool call cut off mid-way, or an empty reply after a long
  think, gets one automatic retry.

## Local models (Ollama, LM Studio)

- **New "Ollama (LAN server)" provider** for a shared Ollama server on your network. Type just
  the address (for example `192.168.1.20`); the port and `/v1` are added for you.
- **Unload a model that's holding the server.** If your request waits because another model
  occupies the server, the chat offers "Unload <model> and continue". One click frees the server
  and sends your request again. Settings can make this automatic or turn it off. Scheduled tasks,
  with nobody there to click, do it on their own after a wait.
- **Models unload when you're done.** A minute after the last reply or task, BE-Aero tells Ollama
  to unload the model, so a shared server's memory is free for other models. Another message in
  the meantime keeps it loaded. You can choose anything from 30 seconds to 30 minutes, or leave
  it to the server's own setting.
- **Evicted models are noticed.** Before each request, BE-Aero checks the model is still loaded.
  If another model or idle expiry unloaded it, the chat says the reply will take longer while it
  reloads.
- **The context buffer follows the model's real window.** If a model is reloaded with a smaller
  context window, the conversation is summarized to fit instead of being cut off by the server.
- **Waits are explained.** If the model is silent for 45 seconds (loading, re-reading a long
  conversation, or busy with another request), the status line says so. After 3 minutes it
  reminds you that Stop is safe.
- Dropped connections keep the existing protection: automatic retries, then waiting for the
  server and resuming your message.

## Browsing with the assistant

- **Pages open in your own browser.** When the assistant opens a web page, it uses your normal
  browser and profile, signed in and with your bookmarks. Before, it used a separate, empty
  profile that looked like a private window.
- **It switches to its own profile only to click or type.** Browsers don't allow automating your
  main profile, which protects your sign-ins. So for clicking and typing, the assistant opens the
  page in its own browser profile.
- **Choose the browser.** Settings > AI assistant > "Browser the assistant uses" lists the
  installed browsers: Chrome, Edge, Brave, Chromium and Firefox. Firefox can open pages, but
  clicking and typing use a Chromium browser, since Firefox can't be automated this way.
- "When the assistant opens a web page" can restore the old behaviour of always using the
  assistant's profile.

## Chat

- **Scrolling stays where you put it.** At the bottom, the chat follows new replies, right to the
  end of long streaming answers. Scroll up and it stays put, with a "New messages" button when
  something arrives, until you come back down or send a message.
  - Each tab keeps its place, and so does the chat after being minimized and restored. Before, it
    jumped back to the top, or opened partway up instead of at the latest message.
- **The edit, resend and delete buttons** under messages are visible again. The v1.2.0 speed-up
  had hidden them behind the message list.

## Notifications

- **Linux: notifications from every app.** The notification center now also collects other
  apps' desktop notifications (mail, calendar, chat, Flatpak apps and more), labelled with the
  app.
  - It works with both standard and GNOME-style notifications, and only listens: your desktop
    still shows its own pop-ups.
  - Settings > Notifications turns it off.
- **The notification panel is readable on any background.** Because of a broken style it had no
  background at all, so it disappeared over matching wallpaper. It's now a frosted pane, with
  clearer rows.

## UAC shield in the dock (Windows)

A shield beside the notification bell shows User Account Control at a glance.

- **Amber while an admin prompt is open.** It pulses when Windows holds a prompt back because a
  program in the background asked; click it to show that prompt.
- **Its menu sets the prompt level**, with the same four positions as the Windows slider:
  - Always notify
  - The Windows default
  - Notify without dimming the desktop
  - Never notify (the shield turns red)

  Changing the level asks for approval once, and the result is checked back. UAC itself is never
  switched off.
- Turn the shield off under Settings > Dock.

## Linux

- **Click through to windows behind the widgets.** In free-form layout on GNOME and other Wayland
  desktops, the transparent space between widgets took every click, so windows behind it couldn't
  be used. Only the widgets take the mouse now: click an app through the gaps to bring it forward,
  or click a widget to bring the widgets over your apps.
- **App notifications** in the notification center (see above).
- **The per-core CPU heatmap** no longer flickers between 0% and 100%. Several parts of the app
  were each restarting the CPU measurement, which left windows too short to measure.

## Install and update

Installed Windows copies update automatically.

Linux install or update:

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```
