import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildNotificationTransport,
  type NotificationTransport,
} from "./protocol.ts";

export const DEFAULT_NOTIFICATION_CONFIG = {
  mode: "long",
  minimumDurationMs: 15_000,
} as const;

const MAXIMUM_DURATION_MS = 86_400_000;
const NOTIFICATION_TITLE = "Pi";
const NOTIFICATION_BODY = "Run complete — ready for input";
const CONFIG_PATH = fileURLToPath(
  new URL("../../notifications.json", import.meta.url),
);

export type NotificationMode = "off" | "long" | "always";

export interface NotificationConfig {
  readonly mode: NotificationMode;
  readonly minimumDurationMs: number;
}

export type ProcessLauncher = (
  file: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  onExit: (error: Error | null) => void,
) => void;

interface NotifyDependencies {
  readonly now: () => number;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly isTTY: () => boolean;
  readonly write: (data: string) => void;
  readonly launch: ProcessLauncher;
  readonly readConfig: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotificationMode(value: unknown): value is NotificationMode {
  return value === "off" || value === "long" || value === "always";
}

export function parseNotificationConfig(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "mode") ||
    !Object.hasOwn(value, "minimumDurationMs") ||
    !isNotificationMode(value.mode) ||
    typeof value.minimumDurationMs !== "number" ||
    !Number.isSafeInteger(value.minimumDurationMs) ||
    value.minimumDurationMs < 0 ||
    value.minimumDurationMs > MAXIMUM_DURATION_MS
  ) {
    return undefined;
  }

  return {
    mode: value.mode,
    minimumDurationMs: value.minimumDurationMs,
  } satisfies NotificationConfig;
}

export function parseNotificationConfigText(text: string) {
  try {
    const config = parseNotificationConfig(JSON.parse(text));
    return config
      ? { config, valid: true as const }
      : { config: DEFAULT_NOTIFICATION_CONFIG, valid: false as const };
  } catch {
    return {
      config: DEFAULT_NOTIFICATION_CONFIG,
      valid: false as const,
    };
  }
}

function defaultLaunch(
  file: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  onExit: (error: Error | null) => void,
) {
  execFile(file, [...args], { env: environment, windowsHide: true }, (error) =>
    onExit(error),
  );
}

const DEFAULT_DEPENDENCIES: NotifyDependencies = {
  now: () => performance.now(),
  environment: () => process.env,
  isTTY: () => Boolean(process.stdout.isTTY),
  write: (data) => {
    process.stdout.write(data);
  },
  launch: defaultLaunch,
  readConfig: () => readFileSync(CONFIG_PATH, "utf8"),
};

function safeWrite(write: (data: string) => void, data: string) {
  try {
    write(data);
  } catch {
    // Terminal notifications are best-effort and must never fail Pi.
  }
}

export function dispatchNotification(
  transport: NotificationTransport,
  dependencies: Pick<NotifyDependencies, "environment" | "write" | "launch">,
) {
  if (transport.kind === "osc") {
    safeWrite(dependencies.write, transport.data);
    return;
  }

  try {
    dependencies.launch(
      transport.file,
      transport.args,
      {
        ...dependencies.environment(),
        ...transport.environment,
      },
      (error) => {
        if (error) safeWrite(dependencies.write, transport.fallbackData);
      },
    );
  } catch {
    safeWrite(dependencies.write, transport.fallbackData);
  }
}

function formatStatus(config: NotificationConfig) {
  const duration = `${config.minimumDurationMs / 1_000} seconds`;
  if (config.mode === "off") return "Notifications: off";
  if (config.mode === "always") return "Notifications: always";
  return `Notifications: long (runs of at least ${duration})`;
}

export function createNotifyExtension(
  overrides: Partial<NotifyDependencies> = {},
) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

  return function notifyExtension(pi: ExtensionAPI) {
    let loaded;
    try {
      loaded = parseNotificationConfigText(dependencies.readConfig());
    } catch {
      loaded = {
        config: DEFAULT_NOTIFICATION_CONFIG,
        valid: false as const,
      };
    }

    let mode: NotificationMode = loaded.config.mode;
    let runStartedAt: number | undefined;
    let warnedAboutConfig = false;

    pi.on("session_start", (_event, ctx) => {
      runStartedAt = undefined;
      if (
        !loaded.valid &&
        !warnedAboutConfig &&
        ctx.mode === "tui" &&
        ctx.hasUI
      ) {
        warnedAboutConfig = true;
        ctx.ui.notify(
          "Invalid notifications.json; using long mode with a 15 second minimum.",
          "warning",
        );
      }
    });

    pi.on("agent_start", () => {
      runStartedAt ??= dependencies.now();
    });

    pi.on("agent_settled", (_event, ctx) => {
      const startedAt = runStartedAt;
      runStartedAt = undefined;
      if (
        startedAt === undefined ||
        ctx.mode !== "tui" ||
        !dependencies.isTTY() ||
        mode === "off"
      ) {
        return;
      }

      const elapsedMs = dependencies.now() - startedAt;
      if (mode === "long" && elapsedMs < loaded.config.minimumDurationMs) {
        return;
      }

      dispatchNotification(
        buildNotificationTransport(
          dependencies.environment(),
          NOTIFICATION_TITLE,
          NOTIFICATION_BODY,
        ),
        dependencies,
      );
    });

    pi.on("session_shutdown", () => {
      runStartedAt = undefined;
    });

    pi.registerCommand("notify", {
      description: "Configure settled-run terminal notifications",
      handler: async (rawArgs, ctx) => {
        const argument = rawArgs.trim().toLowerCase();
        if (
          argument === "off" ||
          argument === "long" ||
          argument === "always"
        ) {
          mode = argument;
          ctx.ui.notify(
            formatStatus({
              mode,
              minimumDurationMs: loaded.config.minimumDurationMs,
            }),
            "info",
          );
          return;
        }

        if (argument === "" || argument === "status") {
          ctx.ui.notify(
            formatStatus({
              mode,
              minimumDurationMs: loaded.config.minimumDurationMs,
            }),
            "info",
          );
          return;
        }

        ctx.ui.notify("Usage: /notify [off|long|always|status]", "warning");
      },
    });
  };
}

export default createNotifyExtension();
