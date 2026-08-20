import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolSearch, {
  aggregateCacheUsage,
  estimateToolSchemaCharacters,
  initialToolSet,
  preserveStableOpenAIInstructions,
  rankOptionalTools,
  stripOptionalToolSnippets,
  supportsNativeToolLoading,
} from "./index.ts";

const optionalTools = [
  { name: "read", description: "Read files" },
  { name: "bg_start", description: "Start a background command" },
  { name: "bg_status", description: "Check a background command" },
  { name: "subagent_spawn", description: "Spawn a child agent" },
  { name: "subagent_wait", description: "Wait for child agents" },
  { name: "aside_repl", description: "Automate a browser" },
  { name: "workflow", description: "Orchestrate several agents" },
];

test("ranks only optional tools using names, descriptions, and capability aliases", () => {
  assert.deepEqual(rankOptionalTools(optionalTools, "browser screenshot", 4), [
    "aside_repl",
  ]);
  assert.deepEqual(rankOptionalTools(optionalTools, "subagent_spawn", 2), [
    "subagent_spawn",
    "subagent_wait",
  ]);
  assert.deepEqual(rankOptionalTools(optionalTools, "files", 4), []);
});

test("initial tool set removes optional definitions and keeps one loader", () => {
  assert.deepEqual(
    initialToolSet([
      "read",
      "bash",
      "workflow",
      "aside_repl",
      "load_tools",
      "load_tools",
    ]),
    ["read", "bash", "load_tools"],
  );
});

test("detects native additive tool-loading compatibility", () => {
  assert.equal(
    supportsNativeToolLoading({ supportsAdditionalTools: true }),
    true,
  );
  assert.equal(supportsNativeToolLoading({ supportsToolSearch: true }), true);
  assert.equal(supportsNativeToolLoading({ supportsToolSearch: false }), false);
  assert.equal(supportsNativeToolLoading(undefined), false);
});

test("removes only optional tool snippets from a system prompt", () => {
  assert.equal(
    stripOptionalToolSnippets(
      [
        "Available tools:",
        "- read: Read files",
        "- aside_repl: Automate the browser",
        "- mcp: Access MCP servers",
        "- custom: Keep this tool",
        "",
        "Guidelines:",
        "- Keep colons in unrelated lines: yes",
        "- mcp: Preserve project guidance outside Available tools",
      ].join("\n"),
    ),
    [
      "Available tools:",
      "- read: Read files",
      "- custom: Keep this tool",
      "",
      "Guidelines:",
      "- Keep colons in unrelated lines: yes",
      "- mcp: Preserve project guidance outside Available tools",
    ].join("\n"),
  );
});

test("freezes main-session OpenAI instructions without touching other payloads", () => {
  assert.deepEqual(
    preserveStableOpenAIInstructions(
      {
        prompt_cache_key: "session-1",
        instructions: "rebuilt prompt",
        input: [],
      },
      "stable prompt",
      "session-1",
    ),
    {
      prompt_cache_key: "session-1",
      instructions: "stable prompt",
      input: [],
    },
  );
  assert.equal(
    preserveStableOpenAIInstructions(
      { prompt_cache_key: "summary", instructions: "summary prompt" },
      "stable prompt",
      "session-1",
    ),
    undefined,
  );
});

test("estimates only model-facing tool schema fields", () => {
  const toolWithExtraMetadata = {
    name: "read",
    description: "Read files",
    parameters: { type: "object" },
    ignored: "not serialized",
  };
  assert.equal(
    estimateToolSchemaCharacters([toolWithExtraMetadata]),
    JSON.stringify([
      {
        name: "read",
        description: "Read files",
        parameters: { type: "object" },
      },
    ]).length,
  );
});

test("aggregates assistant prompt-cache usage without counting other entries", () => {
  assert.deepEqual(
    aggregateCacheUsage([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 100, cacheRead: 900, cacheWrite: 0 },
        },
      },
      { type: "message", message: { role: "user", content: "ignored" } },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 50, cacheRead: 450, cacheWrite: 20 },
        },
      },
    ]),
    {
      input: 150,
      cacheRead: 1350,
      cacheWrite: 20,
      promptTokens: 1520,
      hitRate: 1350 / 1520,
    },
  );
});

test("extension activates matched tools additively", async () => {
  let active = ["read", "bash", "workflow", "subagent_spawn"];
  let sessionStart: (() => void) | undefined;
  let resourcesDiscover: (() => void) | undefined;
  let loadTool:
    | {
        execute: (
          id: string,
          params: { query: string; limit?: number },
        ) => Promise<{
          details: { matches: string[]; added: string[] };
        }>;
      }
    | undefined;

  const api = {
    registerTool: (tool: typeof loadTool) => {
      loadTool = tool;
    },
    registerCommand: () => undefined,
    on: (event: string, handler: () => void) => {
      if (event === "session_start") sessionStart = handler;
      if (event === "resources_discover") resourcesDiscover = handler;
    },
    getActiveTools: () => [...active],
    setActiveTools: (tools: string[]) => {
      active = [...tools];
    },
    getAllTools: () => optionalTools,
  } as unknown as ExtensionAPI;

  toolSearch(api);
  assert.ok(sessionStart);
  assert.ok(resourcesDiscover);
  assert.ok(loadTool);

  sessionStart();
  assert.deepEqual(active, ["read", "bash", "load_tools"]);

  active.push("aside_repl");
  resourcesDiscover();
  assert.deepEqual(active, ["read", "bash", "load_tools"]);

  const result = await loadTool.execute("call-1", {
    query: "subagent spawn",
  });
  assert.deepEqual(result.details.added, ["subagent_spawn", "subagent_wait"]);
  assert.deepEqual(active, [
    "read",
    "bash",
    "load_tools",
    "subagent_spawn",
    "subagent_wait",
  ]);
});
