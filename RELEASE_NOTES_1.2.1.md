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
- **Evicted models are noticed.** Before each request BE-Aero checks whether the model is
  still loaded. If another model or idle expiry unloaded it, the chat says the reply will
  take longer while it reloads.
- **The context buffer follows the model's real window.** If a model is reloaded with a
  smaller context window, the conversation is summarized to fit instead of being cut off
  by the server.
- **The model stays loaded between messages:** BE-Aero asks Ollama to keep it loaded for 30
  minutes after each reply.
- **Waits are explained.** If the model is silent for 45 seconds (loading, re-reading a long
  conversation, or busy with another request), the status line says so. After 3 minutes it
  reminds you that Stop is safe.
- Dropped connections keep the existing protection: automatic retries, then waiting for
  the server and resuming your message.

Installed Windows copies update automatically.

## Linux install / update

```bash
curl -fsSL https://github.com/BE-AI-Research/be-aero-desktop/releases/latest/download/install-linux.sh | sudo bash
```
