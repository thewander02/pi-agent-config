import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface Preset {
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly tools?: readonly string[];
  readonly instructions?: string;
}

export type Presets = Readonly<Record<string, Preset>>;

export interface PresetConfigError {
  readonly name: string;
  readonly message: string;
  readonly source?: string;
}

export interface ParsedPresets {
  readonly presets: Presets;
  readonly errors: readonly PresetConfigError[];
}

export interface LoadedPresets extends ParsedPresets {
  readonly globalPath: string;
  readonly projectPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isToolArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    THINKING_LEVELS.some((level) => level === value)
  );
}

export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return isThinkingLevel(value) ? value : undefined;
}

function malformedField(name: string, field: string, expected: string) {
  return {
    name,
    message: `${field} must be ${expected}`,
  } satisfies PresetConfigError;
}

function parsePreset(name: string, value: unknown) {
  if (!isRecord(value)) {
    return {
      error: {
        name,
        message: "preset must be an object",
      } satisfies PresetConfigError,
    };
  }

  if ("provider" in value && !isNonEmptyString(value.provider)) {
    return { error: malformedField(name, "provider", "a non-empty string") };
  }
  if ("model" in value && !isNonEmptyString(value.model)) {
    return { error: malformedField(name, "model", "a non-empty string") };
  }
  if (
    "thinkingLevel" in value &&
    parseThinkingLevel(value.thinkingLevel) === undefined
  ) {
    return {
      error: malformedField(
        name,
        "thinkingLevel",
        `one of ${THINKING_LEVELS.join(", ")}`,
      ),
    };
  }
  if ("tools" in value && !isToolArray(value.tools)) {
    return {
      error: malformedField(name, "tools", "an array of non-empty strings"),
    };
  }
  if ("instructions" in value && typeof value.instructions !== "string") {
    return {
      error: malformedField(name, "instructions", "a string"),
    };
  }

  const tools = isToolArray(value.tools)
    ? Object.freeze([...value.tools])
    : undefined;
  const preset = Object.freeze({
    ...(isNonEmptyString(value.provider) ? { provider: value.provider } : {}),
    ...(isNonEmptyString(value.model) ? { model: value.model } : {}),
    ...(isThinkingLevel(value.thinkingLevel)
      ? { thinkingLevel: value.thinkingLevel }
      : {}),
    ...(tools ? { tools } : {}),
    ...(typeof value.instructions === "string"
      ? { instructions: value.instructions }
      : {}),
  }) satisfies Preset;

  return { preset };
}

export function parsePresets(value: unknown): ParsedPresets {
  if (!isRecord(value)) {
    return {
      presets: Object.freeze({}),
      errors: Object.freeze([
        {
          name: "(root)",
          message: "preset config must be an object",
        },
      ]),
    };
  }

  const presets: Record<string, Preset> = {};
  const errors: PresetConfigError[] = [];

  for (const [name, candidate] of Object.entries(value)) {
    const result = parsePreset(name, candidate);
    if (result.error) {
      errors.push(result.error);
    } else if (result.preset) {
      presets[name] = result.preset;
    }
  }

  return {
    presets: Object.freeze({ ...presets }),
    errors: Object.freeze([...errors]),
  };
}

export function mergePresets(globalPresets: Presets, projectPresets: Presets) {
  return Object.freeze({
    ...globalPresets,
    ...projectPresets,
  }) satisfies Presets;
}

function withSource(
  errors: readonly PresetConfigError[],
  source: string,
): readonly PresetConfigError[] {
  return errors.map((error) => Object.freeze({ ...error, source }));
}

function readPresets(path: string) {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const parsed = parsePresets(value);
    return {
      presets: parsed.presets,
      errors: withSource(parsed.errors, path),
    };
  } catch (error) {
    const code =
      isRecord(error) && typeof error.code === "string"
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      return {
        presets: Object.freeze({}),
        errors: Object.freeze([]),
      };
    }

    return {
      presets: Object.freeze({}),
      errors: Object.freeze([
        {
          name: "(root)",
          message: error instanceof Error ? error.message : String(error),
          source: path,
        },
      ]),
    };
  }
}

export function loadPresets(
  cwd: string,
  projectTrusted: boolean,
  agentDir = getAgentDir(),
): LoadedPresets {
  const globalPath = join(agentDir, "presets.json");
  const globalConfig = readPresets(globalPath);

  if (!projectTrusted) {
    return {
      presets: globalConfig.presets,
      errors: globalConfig.errors,
      globalPath,
    };
  }

  const projectPath = join(cwd, CONFIG_DIR_NAME, "presets.json");
  const projectConfig = readPresets(projectPath);

  return {
    presets: mergePresets(globalConfig.presets, projectConfig.presets),
    errors: Object.freeze([...globalConfig.errors, ...projectConfig.errors]),
    globalPath,
    projectPath,
  };
}
