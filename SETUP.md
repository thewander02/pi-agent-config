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

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.
