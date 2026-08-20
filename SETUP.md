# Setup

Clone or copy this repository to `~/.pi/agent`, then install its dependencies:

```sh
cd ~/.pi/agent
npm install
```

## Aside Browser

Install and sign in to the Aside CLI, then install Pi's MCP adapter:

```sh
pi install npm:pi-mcp-adapter
```

The included `mcp.json` connects Pi to `aside mcp`. Aside is lazy-loaded the
first time Pi needs browser tools. Use `/mcp reconnect aside` if you want to
connect it immediately after restarting Pi.

No Firecrawl API key or `.env` file is required.

## Workflow presets

The included `presets.json` defines four task-focused configurations:

- `quick` uses GPT-5.6 Luna/medium with inspection-only tools.
- `review` keeps Sol/high, limits the main session to read-only tools, and adds
  bounded review instructions. This is not a sandbox for external agents.
- `research` keeps Sol/high with read-only files and the optional-tool loader.
- `build` keeps Sol/high with core implementation tools and the loader.

Choose interactively with `/preset`, pass a preset at startup with
`pi --preset quick`, or press `ctrl+shift+u` to cycle through `quick`, `review`,
`research`, `build`, and no preset. Use `/preset none` to restore the model,
thinking level, and tools that were active before the preset.

User-wide presets are loaded from `~/.pi/agent/presets.json`. A project can
override or add presets in `.pi/presets.json`, but Pi loads project-local
presets only after the project is trusted. Use `/scoped-models` if a preset's
model needs to be made available in the relevant scope.

## GPT-5.6 efficiency settings

Merge `settings.efficient.example.json` into your global `settings.json`. The
recommended defaults preserve Sol/high and the full 272K GPT-5.6 context while
using explicit `websocket-cached` transport, cache-miss notices, and a 32K
response reserve:

```json
{
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "high",
  "transport": "websocket-cached",
  "compaction": {
    "enabled": true,
    "reserveTokens": 32768,
    "keepRecentTokens": 32000
  }
}
```

The cached WebSocket sends only new conversation items after the first
compatible Codex request while keeping automatic SSE fallback available. This
reduces transport overhead; billed context savings still come from provider
prompt-cache reads, which `/session` reports separately.

The `load_tools` extension removes optional browser/MCP, background-terminal,
subagent, and workflow schemas before the first request. The model can activate
matching tools on demand. GPT-5.6 uses Pi's native additive loading protocol,
which anchors definitions at the loader result and preserves the original
cacheable prefix. Local optional tools intentionally omit `promptSnippet` and
`promptGuidelines`. For package tools that still register one-line snippets,
the loader keeps those lines out of native OpenAI request instructions so
activation does not rebuild the system prompt and cause a cache miss. In a
clean-session RPC audit this reduced active schemas from 27 tools / 29,442
characters to 11 tools / 9,434 characters, or roughly 5K estimated initial
prompt tokens. Use `/efficiency` to inspect the live prompt, schemas, context,
loading mode, and session cache ratio.

Model-generated run recaps are disabled by default because they add a request
after every settled run. Use `/summaries on|off|status`; when enabled, they use
Luna/low unless changed with `/summary-model`.

For non-Codex API providers that support extended prompt caching, optionally
start Pi with `PI_CACHE_RETENTION=long`. OpenAI can retain cached prompts for up
to 24 hours, so consider the privacy tradeoff before enabling it.

## Prompt commands

Pi auto-discovers the checked-in files in `prompts/` after a restart or
`/reload`; no separate installation is needed.

- `/debug npm test fails only on CI` — debug a problem with a hypothesis-driven loop
- `/verify` — independently verify the current work and report evidence
- `/final-check` — run bounded, read-only review rounds over the current diff
- `/second-opinion is this concurrency fix safe?` — request an independent read-only assessment

`/final-check` fans out read-only reviewers and can consume provider quota.

## Run completion notifications

The notify extension is enabled by `notifications.json`. Its default mode is
`long`, which sends a notification when a main-agent run has fully settled
after at least 15 seconds:

```json
{ "mode": "long", "minimumDurationMs": 15000 }
```

Supported modes are `off`, `long`, and `always`. In Pi, use `/notify off`,
`/notify long`, or `/notify always` to change the mode in memory for the current
process, and `/notify status` to inspect it. After editing
`notifications.json`, use `/reload` or restart Pi.

Kitty receives OSC 99 notifications, other compatible terminals receive the
OSC 777 fallback, and Windows Terminal receives a Windows toast when PowerShell
is available. The title and body are static: notifications never include
prompt text, model output, paths, or repository data. This extension notifies
for settled main-agent runs only; it does not promise separate notifications
for background terminals, subagents, or workflow phases.

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## Focused session handoff

Run `/handoff <next goal>` from Pi's interactive TUI to prepare a focused
replacement session. The command uses the active model, so select and
authenticate that model as usual before running it.

The active conversation is bounded before generation. User and assistant text
are included; raw tool arguments and results, thinking, and image data are
omitted, with images represented by an omission marker. Pi opens the generated
handoff as a draft for review and editing, creates a new related session only
after approval, and never submits the draft automatically. The original session
is preserved and can be reopened with `/resume`.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.
