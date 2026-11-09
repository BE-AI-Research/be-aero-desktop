# BE-Aero Desktop v1.0.8

## New

- **Dock hotkey.** Press Ctrl+Alt+D (reconfigurable in Settings, next to the
  search hotkey, with the same press-any-combination recorder) and the dock
  comes up over whatever is on screen - a full-screen game included. The
  sidebar lifts above every window, the dock glows and scrolls into view, and
  as soon as you pick an application or press the key again it sinks back to
  the desktop layer. If your combination is owned by another program the app
  falls back to a free one and tells you which.

- **AI assistant.** A chat widget that saves conversations and can operate the whole
  desktop through tools: themes and settings, the scratchpad, the search index and
  launching, running applications, web widgets - including reading, navigating,
  clicking and typing inside web frames. Works with Anthropic (Claude) via the official
  SDK or any OpenAI-compatible server (OpenAI, Ollama, LM Studio, custom), configured in
  Settings with API keys encrypted at rest. A persona / master-instructions prompt, a
  permission mode for state-changing actions (ask / allow / read-only), a pin button to
  keep the sidebar on top during agentic tasks, an *Ask AI* row in Spotlight search
  (`?` puts it first), and a single *Disable AI* switch.
- **Notification center.** A bell in the dock with an unread badge and a popover
  collecting web widgets' page notifications (via a `window.Notification` shim in each
  frame), the assistant's notifications, downloads and update notices.

- **Power-user prefixes in search.** `run> notepad` launches like the Run dialog
  (Win+R semantics); `cmd> ipconfig` opens a terminal that runs the command and stays
  open (`cmd>` alone opens a terminal). Linux uses the first terminal emulator found.

## Fixed

- A settings-panel initialisation order bug introduced with the new field
  (caught by the automated check before release).
