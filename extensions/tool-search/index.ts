import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const OPTIONAL_TOOL_NAMES = new Set([
  "aside_repl",
  "mcp",
  "mcpScript",
  "bg_start",
  "bg_status",
  "bg_list",
  "bg_kill",
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
]);

const TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  aside_repl: [
    "browser",
    "web",
    "website",
    "screenshot",
    "download",
    "logged-in",
    "research",
  ],
  mcp: ["mcp", "integration", "gateway", "remote", "service"],
  mcpScript: ["mcp", "integration", "gateway", "batch", "multiple", "service"],
  bg_start: [
    "background",
    "terminal",
    "server",
    "watcher",
    "long-running",
    "process",
  ],
  bg_status: ["background", "terminal", "status", "process", "output"],
  bg_list: ["background", "terminal", "list", "process"],
  bg_kill: ["background", "terminal", "kill", "stop", "process"],
  subagent_spawn: ["subagent", "delegate", "parallel", "agent", "spawn"],
  subagent_wait: ["subagent", "delegate", "agent", "wait", "collect"],
  subagent_cancel: ["subagent", "delegate", "agent", "cancel", "stop"],
  subagent_check: ["subagent", "delegate", "agent", "check", "status"],
  subagent_list: ["subagent", "delegate", "agent", "list"],
  workflow: [
    "workflow",
    "orchestrate",
    "parallel",
    "fanout",
    "multi-agent",
    "ultracode",
  ],
};

export interface SearchableTool {
  readonly name: string;
  readonly description: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsNativeToolLoading(compat: unknown) {
  return (
    isRecord(compat) &&
    (compat.supportsAdditionalTools === true ||
      compat.supportsToolSearch === true)
  );
}

/**
 * Native deferred definitions already describe lazily added tools at their load
 * point. Keep their optional one-line entries out of the system prompt so an
 * additive activation cannot invalidate the session's cacheable prefix.
 */
export function stripOptionalToolSnippets(systemPrompt: string) {
  let inAvailableTools = false;

  return systemPrompt
    .split("\n")
    .filter((line) => {
      if (line === "Available tools:") {
        inAvailableTools = true;
        return true;
      }
      if (inAvailableTools && line.length === 0) {
        inAvailableTools = false;
        return true;
      }
      if (!inAvailableTools) return true;

      const match = /^- ([^:]+):/.exec(line);
      return !match || !OPTIONAL_TOOL_NAMES.has(match[1]);
    })
    .join("\n");
}

export function preserveStableOpenAIInstructions(
  payload: unknown,
  stableSystemPrompt: string | undefined,
  sessionId: string,
) {
  if (
    !stableSystemPrompt ||
    !isRecord(payload) ||
    payload.prompt_cache_key !== sessionId ||
    typeof payload.instructions !== "string" ||
    payload.instructions === stableSystemPrompt
  ) {
    return undefined;
  }

  return { ...payload, instructions: stableSystemPrompt };
}

function terms(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function rankOptionalTools(
  tools: readonly SearchableTool[],
  query: string,
  limit: number,
) {
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return [];

  return tools
    .filter((tool) => OPTIONAL_TOOL_NAMES.has(tool.name))
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const haystack =
        `${name} ${tool.description} ${(TOOL_ALIASES[tool.name] ?? []).join(" ")}`.toLowerCase();
      const score = queryTerms.reduce((total, term) => {
        if (name === term) return total + 8;
        if (name.includes(term)) return total + 4;
        return haystack.includes(term) ? total + 1 : total;
      }, 0);
      return { name: tool.name, score };
    })
    .filter((match) => match.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.name.localeCompare(right.name),
    )
    .slice(0, limit)
    .map((match) => match.name);
}

export function initialToolSet(activeTools: readonly string[]) {
  return [
    ...new Set([
      ...activeTools.filter((name) => !OPTIONAL_TOOL_NAMES.has(name)),
      "load_tools",
    ]),
  ];
}

interface AssistantUsage {
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export function estimateToolSchemaCharacters(
  tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters?: unknown;
  }[],
) {
  return JSON.stringify(
    tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
  ).length;
}

export function aggregateCacheUsage(entries: readonly unknown[]) {
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !("type" in entry)) continue;
    if (entry.type !== "message" || !("message" in entry)) continue;
    const message = entry.message;
    if (!message || typeof message !== "object" || !("role" in message))
      continue;
    if (message.role !== "assistant" || !("usage" in message)) continue;
    const usage = message.usage as AssistantUsage;
    input += usage.input ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
  }

  const promptTokens = input + cacheRead + cacheWrite;
  return {
    input,
    cacheRead,
    cacheWrite,
    promptTokens,
    hitRate: promptTokens > 0 ? cacheRead / promptTokens : undefined,
  };
}

function formatTokens(value: number) {
  if (value < 1_000) return Math.round(value).toString();
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export default function toolSearch(pi: ExtensionAPI) {
  let stableRunSystemPrompt: string | undefined;

  pi.registerTool({
    name: "load_tools",
    label: "Load Optional Tools",
    description:
      "Search and activate optional capabilities only when needed: browser/web automation, MCP integrations, background terminals, subagents, and multi-agent workflows. Activated tools remain available for the session.",
    promptSnippet:
      "Load optional browser, MCP, background-terminal, subagent, or workflow tools when the active tools lack a needed capability",
    promptGuidelines: [
      "Use load_tools only when the task needs an optional capability that is not already available; search by capability or exact tool name.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Capability or exact tool name to activate, e.g. 'browser screenshot', 'background terminal', or 'subagent_spawn'",
      }),
      limit: Type.Optional(
        Type.Integer({
          description: "Maximum tools to activate (1-8). Defaults to 4.",
          minimum: 1,
          maximum: 8,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const matches = rankOptionalTools(
        pi.getAllTools(),
        params.query,
        params.limit ?? 4,
      );
      if (matches.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No optional tools matched ${JSON.stringify(params.query)}. Search for browser, MCP, background terminal, subagent, or workflow capabilities.`,
            },
          ],
          details: { matches: [], added: [] },
        };
      }

      const active = pi.getActiveTools();
      const added = matches.filter((name) => !active.includes(name));
      if (added.length > 0) {
        pi.setActiveTools([...new Set([...active, ...added])]);
      }

      return {
        content: [
          {
            type: "text",
            text:
              added.length > 0
                ? `Activated optional tools: ${added.join(", ")}. Use them directly now.`
                : `Matching optional tools already active: ${matches.join(", ")}.`,
          },
        ],
        details: { matches, added },
      };
    },
  });

  pi.registerCommand("efficiency", {
    description: "Show prompt, tool-loading, context, and cache efficiency",
    handler: async (_args, ctx) => {
      const active = pi.getActiveTools();
      const optional = active.filter((name) => OPTIONAL_TOOL_NAMES.has(name));
      const promptCharacters = ctx.getSystemPrompt().length;
      const promptTokens = Math.ceil(promptCharacters / 4);
      const activeNames = new Set(active);
      const toolSchemaCharacters = estimateToolSchemaCharacters(
        pi.getAllTools().filter((tool) => activeNames.has(tool.name)),
      );
      const context = ctx.getContextUsage();
      const cache = aggregateCacheUsage(ctx.sessionManager.getBranch());
      const nativeLoading = supportsNativeToolLoading(ctx.model?.compat);

      const lines = [
        "Harness efficiency",
        `System prompt: ~${formatTokens(promptTokens)} tokens (${promptCharacters.toLocaleString()} chars)`,
        `Active tool schemas: ~${formatTokens(Math.ceil(toolSchemaCharacters / 4))} tokens (${toolSchemaCharacters.toLocaleString()} chars across ${active.length} tools)`,
        `Optional loaded: ${optional.length}${optional.length > 0 ? ` (${optional.join(", ")})` : ""}`,
        `Native additive tool loading: ${nativeLoading ? "yes" : "fallback"}`,
      ];
      if (context) {
        const percent =
          context.percent === null || context.percent === undefined
            ? "?"
            : context.percent.toFixed(1);
        lines.push(
          `Current context: ${context.tokens === null ? "?" : formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)} (${percent}%)`,
        );
      }
      if (cache.hitRate !== undefined) {
        lines.push(
          `Session prompt cache: ${(cache.hitRate * 100).toFixed(1)}% hit (${formatTokens(cache.cacheRead)} cached / ${formatTokens(cache.promptTokens)} prompt tokens)`,
        );
      }
      lines.push("Use /session for provider-priced cache-miss accounting.");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!supportsNativeToolLoading(ctx.model?.compat)) {
      stableRunSystemPrompt = undefined;
      return;
    }

    stableRunSystemPrompt = stripOptionalToolSnippets(event.systemPrompt);
    if (stableRunSystemPrompt !== event.systemPrompt) {
      return { systemPrompt: stableRunSystemPrompt };
    }
  });

  pi.on("before_provider_request", (event, ctx) =>
    preserveStableOpenAIInstructions(
      event.payload,
      stableRunSystemPrompt,
      ctx.sessionManager.getSessionId(),
    ),
  );

  const resetOptionalTools = () => {
    stableRunSystemPrompt = undefined;
    pi.setActiveTools(initialToolSet(pi.getActiveTools()));
  };

  pi.on("session_start", resetOptionalTools);
  // Package extensions can activate tools in their own session_start handlers
  // after local extensions run. Resource discovery is the final startup phase,
  // so repeat the idempotent filter there before the first model request.
  pi.on("resources_discover", resetOptionalTools);
}
