import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  loadPresets,
  mergePresets,
  parsePresets,
  type LoadedPresets,
  type Presets,
  type ThinkingLevel,
} from "./config.ts";
import {
  PRESET_CYCLE,
  PresetController,
  default as presetExtension,
  type PresetActions,
  type PresetContext,
} from "./index.ts";

interface FakeModel {
  readonly provider: string;
  readonly id: string;
}

const ORIGINAL_MODEL = {
  provider: "original",
  id: "original-model",
} satisfies FakeModel;
const SOL_MODEL = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
} satisfies FakeModel;
const LUNA_MODEL = {
  provider: "openai-codex",
  id: "gpt-5.6-luna",
} satisfies FakeModel;

function loaded(presets: Presets): LoadedPresets {
  return {
    presets,
    errors: Object.freeze([]),
    globalPath: "/fake/presets.json",
  };
}

function allPresetTools() {
  return [
    "read",
    "bash",
    "edit",
    "write",
    "fd",
    "rg",
    "ask_user",
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
    "aside_repl",
    "mcp",
    "load_tools",
  ].map((name) => ({
    name,
    description: `${name} tool`,
  }));
}

class FakeHarness {
  activeTools = ["read", "bash", "edit"];
  thinkingLevel: ThinkingLevel = "low";
  model: FakeModel | undefined = ORIGINAL_MODEL;
  allTools: Array<{
    name: string;
    description: string;
    sourceInfo?: {
      path: string;
      source: string;
    };
  }> = allPresetTools();
  notifications: Array<{
    message: string;
    type?: "info" | "warning" | "error";
  }> = [];
  statuses: Array<{ key: string; text: string | undefined }> = [];
  appended: Array<{ customType: string; data: { name: string | null } }> = [];
  events: string[] = [];
  sessionEntries: unknown[] = [];
  trusted = true;
  selected: string | undefined;
  flag: string | undefined;
  modelAuthenticated = true;
  models = new Map(
    [ORIGINAL_MODEL, SOL_MODEL, LUNA_MODEL].map((model) => [
      `${model.provider}/${model.id}`,
      model,
    ]),
  );

  actions(): PresetActions<FakeModel> {
    return {
      getActiveTools: () => [...this.activeTools],
      getAllTools: () => this.allTools,
      setActiveTools: (names) => {
        this.activeTools = [...names];
      },
      getThinkingLevel: () => this.thinkingLevel,
      setThinkingLevel: (level) => {
        this.events.push(`thinking:${level}`);
        this.thinkingLevel = level;
      },
      setModel: async (model) => {
        if (!this.modelAuthenticated) return false;
        this.events.push(`model:${model.provider}/${model.id}`);
        this.model = model;
        return true;
      },
      appendEntry: (customType, data) => {
        this.appended.push({ customType, data });
      },
      getPresetFlag: () => this.flag,
    };
  }

  context(): PresetContext<FakeModel> {
    return {
      cwd: "/fake/project",
      model: this.model,
      isProjectTrusted: () => this.trusted,
      findModel: (provider, model) => this.models.get(`${provider}/${model}`),
      getSessionEntries: () => this.sessionEntries,
      select: async () => this.selected,
      notify: (message, type) => {
        this.notifications.push({ message, type });
      },
      setStatus: (key, text) => {
        this.statuses.push({ key, text });
      },
    };
  }
}

function checkedInPresets() {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../../presets.json", import.meta.url), "utf8"),
  );
  const result = parsePresets(value);
  assert.deepEqual(result.errors, []);
  return result.presets;
}

test("checked-in config preserves model quality while deferring optional tools", () => {
  const presets = checkedInPresets();

  assert.deepEqual(Object.keys(presets), [
    "quick",
    "review",
    "research",
    "build",
  ]);
  assert.deepEqual(presets.quick, {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "medium",
    tools: ["read", "fd", "rg", "ask_user"],
  });
  assert.deepEqual(presets.review, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinkingLevel: "high",
    tools: ["read", "fd", "rg"],
    instructions:
      "Operate read-only. Inspect and report; do not modify files or execute commands.",
  });
  assert.deepEqual(presets.research, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinkingLevel: "high",
    tools: ["read", "fd", "rg", "ask_user", "load_tools"],
  });
  assert.deepEqual(presets.build, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinkingLevel: "high",
    tools: [
      "read",
      "bash",
      "edit",
      "write",
      "fd",
      "rg",
      "ask_user",
      "load_tools",
    ],
  });
  assert.ok(Object.isFrozen(presets.quick.tools));
});

test("malformed preset fields reject each entire named preset", () => {
  const parsed = parsePresets({
    valid: { tools: ["read"] },
    badProvider: { provider: 42 },
    badModel: { model: 42 },
    badThinking: { thinkingLevel: "extreme" },
    badTools: { tools: ["read", 42] },
    badInstructions: { instructions: ["do something"] },
  });

  assert.deepEqual(Object.keys(parsed.presets), ["valid"]);
  assert.deepEqual(
    parsed.errors.map((error) => error.name),
    ["badProvider", "badModel", "badThinking", "badTools", "badInstructions"],
  );
});

test("trusted project presets override global names while untrusted are ignored", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-presets-test-"));
  const agentDir = join(tempRoot, "agent");
  const projectDir = join(tempRoot, "project");

  try {
    mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "presets.json"),
      JSON.stringify({
        shared: { tools: ["read"] },
        globalOnly: { tools: ["rg"] },
      }),
    );
    writeFileSync(
      join(projectDir, CONFIG_DIR_NAME, "presets.json"),
      JSON.stringify({
        shared: { tools: ["write"] },
        projectOnly: { tools: ["bash"] },
      }),
    );

    const trusted = loadPresets(projectDir, true, agentDir);
    const untrusted = loadPresets(projectDir, false, agentDir);

    assert.deepEqual(trusted.presets.shared.tools, ["write"]);
    assert.deepEqual(trusted.presets.projectOnly.tools, ["bash"]);
    assert.deepEqual(untrusted.presets.shared.tools, ["read"]);
    assert.equal(untrusted.presets.projectOnly, undefined);
    assert.equal(untrusted.projectPath, undefined);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("mergePresets does not mutate either input", () => {
  const globalPresets = parsePresets({
    shared: { tools: ["read"] },
  }).presets;
  const projectPresets = parsePresets({
    shared: { tools: ["write"] },
  }).presets;

  const merged = mergePresets(globalPresets, projectPresets);

  assert.deepEqual(globalPresets.shared.tools, ["read"]);
  assert.deepEqual(projectPresets.shared.tools, ["write"]);
  assert.deepEqual(merged.shared.tools, ["write"]);
});

test("unknown tools are filtered and warned once, with the actual MCP gateway name", async () => {
  const harness = new FakeHarness();
  harness.allTools = [
    { name: "read", description: "Read files" },
    {
      name: "actual_gateway",
      description: "MCP gateway - connect to servers",
      sourceInfo: {
        path: "/extensions/pi-mcp-adapter/index.ts",
        source: "pi-mcp-adapter",
      },
    },
  ];
  const presets = parsePresets({
    custom: { tools: ["read", "missing", "mcp"] },
  }).presets;
  const controller = new PresetController(harness.actions(), {
    load: () => loaded(presets),
  });
  await controller.start(harness.context());

  assert.equal(await controller.activate("custom", harness.context()), true);
  assert.deepEqual(harness.activeTools, ["read", "actual_gateway"]);
  assert.equal(await controller.activate("custom", harness.context()), true);
  assert.equal(
    harness.notifications.filter((notification) =>
      notification.message.includes("unknown tools omitted"),
    ).length,
    1,
  );
  assert.deepEqual(harness.appended, [
    { customType: "preset-state", data: { name: "custom" } },
  ]);
});

test("review activates exactly the read-only tool boundary", async () => {
  const harness = new FakeHarness();
  const controller = new PresetController(harness.actions(), {
    load: () => loaded(checkedInPresets()),
  });
  await controller.start(harness.context());

  assert.equal(await controller.activate("review", harness.context()), true);

  assert.deepEqual(harness.activeTools, ["read", "fd", "rg"]);
  assert.equal(controller.activeName, "review");
  assert.equal(
    controller.activeInstructions,
    "Operate read-only. Inspect and report; do not modify files or execute commands.",
  );
  assert.equal(harness.model, SOL_MODEL);
  assert.equal(harness.thinkingLevel, "high");
  assert.deepEqual(harness.events.slice(0, 2), [
    "model:openai-codex/gpt-5.6-sol",
    "thinking:high",
  ]);
});

test("a preset resolving to zero tools fails closed", async () => {
  const harness = new FakeHarness();
  const presets = parsePresets({
    unavailable: { tools: ["not_registered"] },
  }).presets;
  const controller = new PresetController(harness.actions(), {
    load: () => loaded(presets),
  });
  await controller.start(harness.context());
  const originalTools = [...harness.activeTools];

  assert.equal(
    await controller.activate("unavailable", harness.context()),
    false,
  );
  assert.deepEqual(harness.activeTools, originalTools);
  assert.equal(controller.activeName, undefined);
  assert.deepEqual(harness.appended, []);
});

test("none restores the exact original model, reasoning, and tools", async () => {
  const harness = new FakeHarness();
  const originalTools = [...harness.activeTools];
  const controller = new PresetController(harness.actions(), {
    load: () => loaded(checkedInPresets()),
  });
  await controller.start(harness.context());
  await controller.activate("review", harness.context());

  await controller.clear(harness.context());

  assert.equal(harness.model, ORIGINAL_MODEL);
  assert.equal(harness.thinkingLevel, "low");
  assert.deepEqual(harness.activeTools, originalTools);
  assert.equal(controller.activeName, undefined);
  assert.deepEqual(harness.statuses.at(-1), {
    key: "preset",
    text: undefined,
  });
  assert.deepEqual(harness.appended.at(-1), {
    customType: "preset-state",
    data: { name: null },
  });
});

test("shortcut cycle is deterministic", async () => {
  const harness = new FakeHarness();
  const controller = new PresetController(harness.actions(), {
    load: () => loaded(checkedInPresets()),
  });
  await controller.start(harness.context());
  const observed: Array<string | undefined> = [];

  for (let index = 1; index < PRESET_CYCLE.length; index += 1) {
    await controller.cycle(harness.context());
    observed.push(controller.activeName);
  }
  await controller.cycle(harness.context());
  observed.push(controller.activeName);

  assert.deepEqual(observed, [
    "quick",
    "review",
    "research",
    "build",
    undefined,
  ]);
});

test("restored sessions never apply an untrusted project preset", async () => {
  const harness = new FakeHarness();
  harness.trusted = false;
  harness.sessionEntries = [
    {
      type: "custom",
      customType: "preset-state",
      data: { name: "projectOnly" },
    },
  ];
  const globalPresets = parsePresets({
    quick: { tools: ["read"] },
  }).presets;
  let observedTrust: boolean | undefined;
  const controller = new PresetController(harness.actions(), {
    load: (_cwd, projectTrusted) => {
      observedTrust = projectTrusted;
      return loaded(globalPresets);
    },
  });

  await controller.start(harness.context());

  assert.equal(observedTrust, false);
  assert.equal(controller.activeName, undefined);
  assert.deepEqual(harness.activeTools, ["read", "bash", "edit"]);
  assert.deepEqual(harness.appended, []);
});

test("default extension registers and runs preset lifecycle without duplicate persistence", async () => {
  type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
  type FlagOptions = Parameters<ExtensionAPI["registerFlag"]>[1];
  type ShortcutOptions = Parameters<ExtensionAPI["registerShortcut"]>[1];
  type LifecycleHandler = (
    event: unknown,
    context: ExtensionContext,
  ) => unknown;

  const tempRoot = mkdtempSync(join(tmpdir(), "pi-preset-extension-test-"));
  const agentDir = join(tempRoot, "agent");
  const projectDir = join(tempRoot, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const flags = new Map<string, FlagOptions>();
  const commands = new Map<string, CommandOptions>();
  const shortcuts = new Map<string, ShortcutOptions>();
  const handlers = new Map<string, LifecycleHandler>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  let activeTools = ["read", "bash", "edit"];
  let thinkingLevel: ThinkingLevel = "low";

  try {
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(agentDir, "presets.json"),
      JSON.stringify({
        review: {
          thinkingLevel: "high",
          tools: ["read", "fd", "rg"],
          instructions: "Test review instructions.",
        },
      }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const api = {
      registerFlag: (name: string, options: FlagOptions) => {
        flags.set(name, options);
      },
      registerCommand: (name: string, options: CommandOptions) => {
        commands.set(name, options);
      },
      registerShortcut: (shortcut: string, options: ShortcutOptions) => {
        shortcuts.set(shortcut, options);
      },
      on: (event: string, handler: LifecycleHandler) => {
        handlers.set(event, handler);
      },
      getActiveTools: () => [...activeTools],
      getAllTools: () => allPresetTools(),
      setActiveTools: (names: string[]) => {
        activeTools = [...names];
      },
      getThinkingLevel: () => thinkingLevel,
      setThinkingLevel: (level: ThinkingLevel) => {
        thinkingLevel = level;
      },
      setModel: async () => true,
      appendEntry: (customType: string, data: unknown) => {
        appended.push({ customType, data });
      },
      getFlag: (name: string) => (name === "preset" ? "review" : undefined),
    } as unknown as ExtensionAPI;

    const context = {
      cwd: projectDir,
      model: ORIGINAL_MODEL,
      isProjectTrusted: () => true,
      modelRegistry: {
        find: () => undefined,
      },
      sessionManager: {
        getEntries: () => [],
      },
      ui: {
        select: async () => undefined,
        notify: () => undefined,
        setStatus: () => undefined,
      },
    } as unknown as ExtensionContext;

    presetExtension(api);

    assert.equal(flags.get("preset")?.type, "string");
    assert.ok(commands.has("preset"));
    assert.ok(shortcuts.has("ctrl+shift+u"));
    assert.deepEqual(
      [...handlers.keys()],
      ["before_agent_start", "session_start", "turn_start"],
    );

    const sessionStart = handlers.get("session_start");
    const beforeAgentStart = handlers.get("before_agent_start");
    const turnStart = handlers.get("turn_start");
    assert.ok(sessionStart);
    assert.ok(beforeAgentStart);
    assert.ok(turnStart);

    await sessionStart({ type: "session_start", reason: "startup" }, context);
    assert.deepEqual(activeTools, ["read", "fd", "rg"]);
    assert.equal(thinkingLevel, "high");
    assert.deepEqual(
      await beforeAgentStart(
        {
          type: "before_agent_start",
          systemPrompt: "Base system prompt.",
        },
        context,
      ),
      {
        systemPrompt: "Base system prompt.\n\nTest review instructions.",
      },
    );
    assert.deepEqual(appended, [
      {
        customType: "preset-state",
        data: { name: "review" },
      },
    ]);

    await turnStart({ type: "turn_start", turnIndex: 0 }, context);
    await turnStart({ type: "turn_start", turnIndex: 1 }, context);
    assert.equal(appended.length, 1);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
