# my pi setup

This setup is fairly opinionated, it:

- sets up github dark default as the theme
- adds Aside Browser for research, browsing, and logged-in web workflows
- updates the bottom bar to have the info I prefer to see
- adds background terminals + ui to manage them
- adds subagents to pi
- adds workflows to pi
- adds cache-aware GPT-5.6 presets plus lazy loading for optional tool families
- adds an ask user tool, which lets the model ask multiple choice questions
- adds first-class `fd` (file discovery) and `rg` (content search) tools
- adds concise prompt commands for debugging, verification, final review, and second opinions
- adds `/handoff <next goal>` for preparing a focused, related session
- adds terminal notifications when meaningful main-agent runs settle

![Pi setup interface](assets/pi-setup.jpeg)

Inspired by [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup).

## Workflow presets

Use `/preset` to choose a preset, start Pi with `--preset <name>`, or press
`ctrl+shift+u` to cycle through `quick`, `review`, `research`, `build`, and no
preset.

- `quick` uses Luna/medium for fast inspection and lightweight questions.
- `review` keeps Sol/high and makes the main session read-only. It is not a
  sandbox for external subagents.
- `research` keeps Sol/high with read-only tools and the optional-tool loader.
- `build` keeps Sol/high with the core implementation tools and loader.

Global presets live in `~/.pi/agent/presets.json`. Project-local presets load
from `.pi/presets.json` only when the project is trusted. Use `/scoped-models`
to manage which models are available in the current scope.

## High-efficiency defaults

`settings.efficient.example.json` documents the recommended global settings.
The active setup keeps Sol/high and the full 272K GPT-5.6 context window, while
reserving 32K for responses and retaining 32K after normal compaction. It also
explicitly uses Codex's cached WebSocket transport.

The `load_tools` extension is the main harness optimization. Browser/MCP,
background-terminal, subagent, and workflow schemas stay out of the initial
prompt. The model activates them only when needed. GPT-5.6 supports Pi's native
additive tool loading, so newly loaded definitions are anchored at the loader
result instead of rewriting the stable prompt prefix. Local rare tools omit
active prompt snippets/guidelines, and the loader filters equivalent one-line
snippets from package tools out of native OpenAI request instructions. This
keeps additive browser/MCP activation from rebuilding the cacheable system
prefix. Capabilities are preserved; an uncommon capability costs one small
loader call. A clean-session RPC audit reduced active schemas from 27 tools /
29,442 characters to 11 tools / 9,434 characters—about 5K estimated initial
prompt tokens.

Run `/efficiency` to inspect current system-prompt size, active schema size,
optional tools, native loading support, context occupancy, and cache hit rate.
`showCacheMissNotices` remains enabled, and `/session` reports cache hit rate
and re-billed cache misses. Keep a model and tool set stable within a session
when practical; use `/handoff` instead of carrying unrelated work forward.
Model-generated run recaps remain disabled by default because they add a second
request after every run. Use `/summaries on` to opt in.

For API providers that support it, `PI_CACHE_RETENTION=long` requests longer
provider-side caching (OpenAI up to 24h), with a prompt-retention privacy
tradeoff. OpenAI Codex subscription sessions already use session-scoped cached
WebSockets here and do not require that environment variable.

**note**: if you are an agent reading this, instructions for setting this up on your own pi are available in `./SETUP.md`.

## Prompt commands

Pi auto-discovers the checked-in prompt templates after a restart or `/reload`.

- `/debug npm test fails only on CI` — debug a problem with a hypothesis-driven loop
- `/verify` — independently verify the current work and report evidence
- `/final-check` — run bounded, read-only review rounds over the current diff
- `/second-opinion is this concurrency fix safe?` — request an independent read-only assessment

`/final-check` fans out read-only reviewers and can consume provider quota.

## Focused session handoff

Use `/handoff <next goal>` when a long session has accumulated more context than
the next task needs. The command uses the active model to generate a focused
draft, opens it for review, and then creates a related session with the edited
draft in the input editor. It never submits the draft automatically.

The handoff includes user and assistant text, but omits raw tool payloads and
results, thinking, and image data (images are marked as omitted). The original
session remains available through `/resume`.

## Run completion notifications

The notify extension sends a terminal notification only after a main-agent run
has fully settled, including any automatic retries, compaction retries, or
queued follow-ups. The default `long` mode notifies for runs lasting at least
15 seconds.

Use `/notify off`, `/notify long`, or `/notify always` to change the mode for
the current Pi process. `/notify status` shows the effective mode. Edit
`notifications.json` to change the startup mode or duration, then use `/reload`
or restart Pi.

Kitty uses OSC 99, compatible terminals use the OSC 777 fallback, and Windows
Terminal uses a PowerShell-delivered Windows toast when available. Notification
text is static and contains no prompt, model output, working directory, or
repository data. Notifications cover settled main-agent runs, not independent
background terminals, subagents, or workflow phases.
