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

- `quick` uses a faster model with inspection-only tools for lightweight
  questions.
- `review` limits the current main session to read-only inspection tools and
  adds read-only review instructions. This is a main-session boundary, not a
  sandbox for external subagents.
- `research` enables read-only file inspection, Aside Browser, MCP, and user
  questions for research work.
- `build` enables the full model, reasoning, file-editing, terminal, research,
  workflow, and subagent toolset for implementation.

Choose interactively with `/preset`, pass a preset at startup with
`pi --preset quick`, or press `ctrl+shift+u` to cycle through `quick`, `review`,
`research`, `build`, and no preset. Use `/preset none` to restore the model,
thinking level, and tools that were active before the preset.

User-wide presets are loaded from `~/.pi/agent/presets.json`. A project can
override or add presets in `.pi/presets.json`, but Pi loads project-local
presets only after the project is trusted. Use `/scoped-models` if a preset's
model needs to be made available in the relevant scope.

Optionally set `PI_CACHE_RETENTION=long` when starting Pi to request longer
prompt-cache retention from supported providers:

```sh
PI_CACHE_RETENTION=long pi --preset research
```

Longer provider-side cache retention can improve cache reuse, but it also
retains cached prompt data at the provider for longer. Consider that privacy
tradeoff before enabling it, especially for sensitive work.

## Prompt commands

Pi auto-discovers the checked-in files in `prompts/` after a restart or
`/reload`; no separate installation is needed.

- `/debug npm test fails only on CI` — debug a problem with a hypothesis-driven loop
- `/verify` — independently verify the current work and report evidence
- `/final-check` — run bounded, read-only review rounds over the current diff
- `/second-opinion is this concurrency fix safe?` — request an independent read-only assessment

`/final-check` fans out read-only reviewers and can consume provider quota.

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
