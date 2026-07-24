# my pi setup

This setup is fairly opinionated, it:

- sets up github dark default as the theme
- adds Aside Browser for research, browsing, and logged-in web workflows
- updates the bottom bar to have the info I prefer to see
- adds background terminals + ui to manage them
- adds subagents to pi
- adds workflows to pi
- adds workflow presets for quick tasks, read-only review, research, and building
- adds an ask user tool, which lets the model ask multiple choice questions
- adds first-class `fd` (file discovery) and `rg` (content search) tools
- adds concise prompt commands for debugging, verification, final review, and second opinions
- adds `/handoff <next goal>` for preparing a focused, related session

![Pi setup interface](assets/pi-setup.jpeg)

## Workflow presets

Use `/preset` to choose a preset, start Pi with `--preset <name>`, or press
`ctrl+shift+u` to cycle through `quick`, `review`, `research`, `build`, and no
preset.

- `quick` is for fast inspection and lightweight questions.
- `review` makes the main session read-only for code review. It is not a
  sandbox for external subagents.
- `research` enables browser and MCP research tools without file-writing tools.
- `build` enables the full implementation toolset.

Global presets live in `~/.pi/agent/presets.json`. Project-local presets load
from `.pi/presets.json` only when the project is trusted. Use `/scoped-models`
to manage which models are available in the current scope.

For longer supported provider-side prompt caching, optionally start Pi with
`PI_CACHE_RETENTION=long`. Longer provider-side cache retention can improve
cache reuse, but retains cached prompt data at the provider for longer and
therefore has a privacy tradeoff.

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
