import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  loadPresets,
  type LoadedPresets,
  type Preset,
  type Presets,
  type ThinkingLevel,
} from "./config.ts";

const PRESET_STATE_ENTRY = "preset-state";
export const PRESET_CYCLE = [
  "none",
  "quick",
  "review",
  "research",
  "build",
] as const;

interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly sourceInfo?: {
    readonly path: string;
    readonly source: string;
  };
}

export interface PresetContext<TModel> {
  readonly cwd: string;
  readonly model: TModel | undefined;
  isProjectTrusted(): boolean;
  findModel(provider: string, model: string): TModel | undefined;
  getSessionEntries(): readonly unknown[];
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
}

export interface PresetActions<TModel> {
  getActiveTools(): string[];
  getAllTools(): readonly ToolDescriptor[];
  setActiveTools(names: string[]): void;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
  setModel(model: TModel): Promise<boolean>;
  appendEntry(customType: string, data: { name: string | null }): void;
  getPresetFlag(): string | undefined;
}

export interface PresetControllerOptions {
  load?: (
    cwd: string,
    projectTrusted: boolean,
    agentDir?: string,
  ) => LoadedPresets;
  agentDir?: string;
}

interface OriginalState<TModel> {
  readonly model: TModel | undefined;
  readonly thinkingLevel: ThinkingLevel;
  readonly tools: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPersistedPresetName(entries: readonly unknown[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== PRESET_STATE_ENTRY ||
      !isRecord(entry.data)
    ) {
      continue;
    }

    const name = entry.data.name;
    if (typeof name === "string" || name === null) return name;
  }

  return undefined;
}

function isMcpGateway(tool: ToolDescriptor) {
  const description = tool.description.toLowerCase();
  const source =
    `${tool.sourceInfo?.path ?? ""} ${tool.sourceInfo?.source ?? ""}`.toLowerCase();
  const name = tool.name.toLowerCase();

  return (
    (description.includes("mcp gateway") ||
      source.includes("pi-mcp-adapter")) &&
    (name.includes("mcp") || description.includes("mcp"))
  );
}

function isCyclePreset(value: string): value is (typeof PRESET_CYCLE)[number] {
  return PRESET_CYCLE.some((name) => name === value);
}

export function resolvePresetTools(
  requested: readonly string[],
  available: readonly ToolDescriptor[],
) {
  const availableNames = new Set(available.map((tool) => tool.name));
  const gatewayTools = available.filter(isMcpGateway);
  const resolved: string[] = [];
  const unknown: string[] = [];

  for (const requestedName of requested) {
    let resolvedName: string | undefined;
    if (availableNames.has(requestedName)) {
      resolvedName = requestedName;
    } else if (requestedName === "mcp" && gatewayTools.length === 1) {
      resolvedName = gatewayTools[0].name;
    }

    if (resolvedName) {
      if (!resolved.includes(resolvedName)) resolved.push(resolvedName);
    } else {
      unknown.push(requestedName);
    }
  }

  return {
    tools: Object.freeze([...resolved]),
    unknown: Object.freeze([...unknown]),
  };
}

export class PresetController<TModel> {
  readonly #actions: PresetActions<TModel>;
  readonly #load: NonNullable<PresetControllerOptions["load"]>;
  readonly #agentDir: string | undefined;
  readonly #warnedTools = new Set<string>();
  #presets: Presets = Object.freeze({});
  #activeName: string | undefined;
  #activePreset: Preset | undefined;
  #originalState: OriginalState<TModel> | undefined;
  #persistedName: string | null | undefined;

  constructor(
    actions: PresetActions<TModel>,
    options: PresetControllerOptions = {},
  ) {
    this.#actions = actions;
    this.#load = options.load ?? loadPresets;
    this.#agentDir = options.agentDir;
  }

  get activeName() {
    return this.#activeName;
  }

  get activeInstructions() {
    return this.#activePreset?.instructions;
  }

  get presets() {
    return this.#presets;
  }

  #updateStatus(ctx: PresetContext<TModel>) {
    ctx.setStatus(
      "preset",
      this.#activeName ? `preset:${this.#activeName}` : undefined,
    );
  }

  #persist() {
    const name = this.#activeName ?? null;
    if (this.#persistedName === name) return;

    this.#actions.appendEntry(PRESET_STATE_ENTRY, { name });
    this.#persistedName = name;
  }

  persist() {
    if (this.#activeName) this.#persist();
  }

  #warnAboutUnknownTools(
    presetName: string,
    unknown: readonly string[],
    ctx: PresetContext<TModel>,
  ) {
    const newUnknown = unknown.filter((name) => !this.#warnedTools.has(name));
    if (newUnknown.length === 0) return;

    for (const name of newUnknown) this.#warnedTools.add(name);
    ctx.notify(
      `Preset "${presetName}": unknown tools omitted: ${newUnknown.join(", ")}`,
      "warning",
    );
  }

  async activate(name: string, ctx: PresetContext<TModel>, persist = true) {
    const preset = this.#presets[name];
    if (!preset) {
      const available = Object.keys(this.#presets).join(", ") || "(none)";
      ctx.notify(
        `Unknown preset "${name}". Available: ${available}`,
        "warning",
      );
      return false;
    }

    const resolvedTools = preset.tools
      ? resolvePresetTools(preset.tools, this.#actions.getAllTools())
      : undefined;
    if (resolvedTools) {
      this.#warnAboutUnknownTools(name, resolvedTools.unknown, ctx);
      if (resolvedTools.tools.length === 0) {
        ctx.notify(
          `Preset "${name}" has no available tools; keeping current tools`,
          "warning",
        );
        return false;
      }
    }

    if (!this.#originalState) {
      this.#originalState = Object.freeze({
        model: ctx.model,
        thinkingLevel: this.#actions.getThinkingLevel(),
        tools: Object.freeze([...this.#actions.getActiveTools()]),
      });
    }

    if (preset.provider && preset.model) {
      const model = ctx.findModel(preset.provider, preset.model);
      if (!model) {
        ctx.notify(
          `Preset "${name}": model ${preset.provider}/${preset.model} is unavailable; keeping current model`,
          "warning",
        );
      } else if (!(await this.#actions.setModel(model))) {
        ctx.notify(
          `Preset "${name}": model ${preset.provider}/${preset.model} is unauthenticated; keeping current model`,
          "warning",
        );
      }
    }

    if (preset.thinkingLevel) {
      this.#actions.setThinkingLevel(preset.thinkingLevel);
    }
    if (resolvedTools) {
      this.#actions.setActiveTools([...resolvedTools.tools]);
    }

    this.#activeName = name;
    this.#activePreset = preset;
    this.#updateStatus(ctx);
    if (persist) this.#persist();
    return true;
  }

  async clear(ctx: PresetContext<TModel>, persist = true) {
    if (this.#originalState) {
      if (
        this.#originalState.model &&
        !(await this.#actions.setModel(this.#originalState.model))
      ) {
        ctx.notify(
          "Could not restore the original model authentication",
          "warning",
        );
      }
      this.#actions.setThinkingLevel(this.#originalState.thinkingLevel);
      this.#actions.setActiveTools([...this.#originalState.tools]);
    }

    this.#activeName = undefined;
    this.#activePreset = undefined;
    this.#originalState = undefined;
    this.#updateStatus(ctx);
    if (persist) this.#persist();
  }

  async cycle(ctx: PresetContext<TModel>) {
    const current =
      this.#activeName && isCyclePreset(this.#activeName)
        ? this.#activeName
        : "none";
    const currentIndex = PRESET_CYCLE.indexOf(current);
    const next = PRESET_CYCLE[(currentIndex + 1) % PRESET_CYCLE.length];

    if (next === "none") {
      await this.clear(ctx);
      return;
    }

    await this.activate(next, ctx);
  }

  async select(ctx: PresetContext<TModel>) {
    const selection = await ctx.select("Select workflow preset", [
      "none",
      ...Object.keys(this.#presets).sort(),
    ]);
    if (!selection) return;

    if (selection === "none") {
      await this.clear(ctx);
    } else {
      await this.activate(selection, ctx);
    }
  }

  async start(ctx: PresetContext<TModel>) {
    this.#presets = Object.freeze({});
    this.#activeName = undefined;
    this.#activePreset = undefined;
    this.#originalState = undefined;

    const loaded = this.#load(ctx.cwd, ctx.isProjectTrusted(), this.#agentDir);
    this.#presets = loaded.presets;
    for (const error of loaded.errors) {
      const source = error.source ? ` in ${error.source}` : "";
      ctx.notify(
        `Rejected preset "${error.name}"${source}: ${error.message}`,
        "warning",
      );
    }

    const restoredName = readPersistedPresetName(ctx.getSessionEntries());
    this.#persistedName = restoredName;
    const flagName = this.#actions.getPresetFlag();
    const requestedName = flagName || restoredName || undefined;

    if (requestedName) {
      await this.activate(requestedName, ctx, flagName !== undefined);
    } else {
      this.#updateStatus(ctx);
    }
  }
}

function adaptContext(ctx: ExtensionContext): PresetContext<Model<Api>> {
  return {
    cwd: ctx.cwd,
    model: ctx.model,
    isProjectTrusted: () => ctx.isProjectTrusted(),
    findModel: (provider, model) => ctx.modelRegistry.find(provider, model),
    getSessionEntries: () => ctx.sessionManager.getEntries(),
    select: (title, options) => ctx.ui.select(title, options),
    notify: (message, type) => ctx.ui.notify(message, type),
    setStatus: (key, text) => ctx.ui.setStatus(key, text),
  };
}

export default function presetExtension(pi: ExtensionAPI) {
  const controller = new PresetController<Model<Api>>({
    getActiveTools: () => pi.getActiveTools(),
    getAllTools: () => pi.getAllTools(),
    setActiveTools: (names) => pi.setActiveTools(names),
    getThinkingLevel: () => pi.getThinkingLevel(),
    setThinkingLevel: (level) => pi.setThinkingLevel(level),
    setModel: (model) => pi.setModel(model),
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    getPresetFlag: () => {
      const value = pi.getFlag("preset");
      return typeof value === "string" && value.trim()
        ? value.trim()
        : undefined;
    },
  });

  pi.registerFlag("preset", {
    description: "Activate a workflow preset",
    type: "string",
  });

  pi.registerCommand("preset", {
    description: "Select or activate a workflow preset",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        await controller.select(adaptContext(ctx));
      } else if (name === "none") {
        await controller.clear(adaptContext(ctx));
      } else {
        await controller.activate(name, adaptContext(ctx));
      }
    },
  });

  pi.registerShortcut("ctrl+shift+u", {
    description: "Cycle workflow presets",
    handler: async (ctx) => {
      await controller.cycle(adaptContext(ctx));
    },
  });

  pi.on("before_agent_start", (event) => {
    if (!controller.activeInstructions) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${controller.activeInstructions}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    await controller.start(adaptContext(ctx));
  });

  pi.on("turn_start", () => {
    controller.persist();
  });
}
