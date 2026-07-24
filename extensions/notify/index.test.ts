import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createNotifyExtension,
  dispatchNotification,
  parseNotificationConfig,
  parseNotificationConfigText,
  type ProcessLauncher,
} from "./index.ts";
import {
  buildNotificationTransport,
  buildOsc777Notification,
  sanitizeNotification,
} from "./protocol.ts";

type EventHandler = (
  event: { type: string },
  context: ExtensionContext,
) => void | Promise<void>;
type CommandHandler = (
  args: string,
  context: ExtensionCommandContext,
) => void | Promise<void>;

interface HarnessOptions {
  readonly config?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly tty?: boolean;
  readonly launchError?: Error;
}

function makeContext(
  mode: ExtensionContext["mode"] = "tui",
  notifications: Array<{ message: string; type?: string }> = [],
) {
  return {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;
}

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, EventHandler>();
  const commands = new Map<string, CommandHandler>();
  const writes: string[] = [];
  const launches: Array<{
    file: string;
    args: readonly string[];
    environment: NodeJS.ProcessEnv;
  }> = [];
  const uiNotifications: Array<{ message: string; type?: string }> = [];
  let currentTime = 0;
  let configReads = 0;

  const launch: ProcessLauncher = (file, args, environment, onExit) => {
    launches.push({ file, args, environment });
    onExit(options.launchError ?? null);
  };
  const api = {
    on: (event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, command: { handler: CommandHandler }) => {
      commands.set(name, command.handler);
    },
  } as unknown as ExtensionAPI;

  createNotifyExtension({
    now: () => currentTime,
    environment: () => options.environment ?? {},
    isTTY: () => options.tty ?? true,
    write: (data) => writes.push(data),
    launch,
    readConfig: () => {
      configReads += 1;
      return options.config ?? '{ "mode": "long", "minimumDurationMs": 15000 }';
    },
  })(api);

  const context = makeContext("tui", uiNotifications);
  const emit = (event: string, eventContext = context) => {
    const handler = handlers.get(event);
    assert.ok(handler, `missing ${event} handler`);
    return handler({ type: event }, eventContext);
  };
  const command = (args: string, commandContext = context) => {
    const handler = commands.get("notify");
    assert.ok(handler, "missing notify command");
    return handler(args, commandContext as ExtensionCommandContext);
  };

  return {
    handlers,
    writes,
    launches,
    uiNotifications,
    emit,
    command,
    setTime: (value: number) => {
      currentTime = value;
    },
    configReads: () => configReads,
  };
}

test("strictly parses off, long, and always configs", () => {
  for (const mode of ["off", "long", "always"] as const) {
    assert.deepEqual(
      parseNotificationConfig({ mode, minimumDurationMs: 15_000 }),
      { mode, minimumDurationMs: 15_000 },
    );
  }
});

test("malformed and out-of-range configs fall back to defaults", () => {
  for (const value of [
    "{",
    JSON.stringify({ mode: "sometimes", minimumDurationMs: 15_000 }),
    JSON.stringify({ mode: "long", minimumDurationMs: -1 }),
    JSON.stringify({ mode: "long", minimumDurationMs: 86_400_001 }),
    JSON.stringify({
      mode: "long",
      minimumDurationMs: 15_000,
      extra: true,
    }),
  ]) {
    assert.deepEqual(parseNotificationConfigText(value), {
      config: { mode: "long", minimumDurationMs: 15_000 },
      valid: false,
    });
  }
});

test("rejects non-object config values", () => {
  assert.equal(parseNotificationConfig(null), undefined);
  assert.equal(parseNotificationConfig([]), undefined);
  assert.equal(parseNotificationConfig("long"), undefined);
});

test("sanitizes controls and bounds Unicode text", () => {
  const sanitized = sanitizeNotification(
    `A\u001bB\u0007C\r\nD\u009dE\u001b\\F${"x".repeat(100)}`,
    `body\u001b]777;notify;bad\u0007\r\n${"😀".repeat(300)}`,
  );

  assert.equal(sanitized.title, `ABCDEF${"x".repeat(74)}`);
  assert.equal(Array.from(sanitized.title).length, 80);
  assert.equal(Array.from(sanitized.body).length, 240);
  assert.doesNotMatch(
    `${sanitized.title}${sanitized.body}`,
    /[\u0000-\u001f\u007f-\u009f]/,
  );
});

test("selects Kitty OSC 99 and fallback OSC 777 transports", () => {
  const kitty = buildNotificationTransport(
    { KITTY_WINDOW_ID: "1" },
    "Pi",
    "Ready",
  );
  assert.equal(kitty.kind, "osc");
  assert.equal(kitty.protocol, "osc99");
  assert.match(kitty.data, /^\u001b\]99;/);
  assert.match(kitty.data, /Pi/);
  assert.match(kitty.data, /Ready/);

  const fallback = buildNotificationTransport({}, "Pi", "Ready");
  assert.deepEqual(fallback, {
    kind: "osc",
    protocol: "osc777",
    data: buildOsc777Notification("Pi", "Ready"),
  });
});

test("builds a static Windows command with base64 text outside source", () => {
  const title = "Pi'; throw 'unsafe";
  const body = "Ready $(Get-Process)";
  const transport = buildNotificationTransport(
    { WT_SESSION: "1", KITTY_WINDOW_ID: "1" },
    title,
    body,
  );

  assert.equal(transport.kind, "windows");
  assert.equal(transport.file, "powershell.exe");
  assert.equal(transport.args.includes("-NoProfile"), true);
  assert.equal(transport.args.join(" ").includes(title), false);
  assert.equal(transport.args.join(" ").includes(body), false);
  assert.equal(
    Buffer.from(transport.environment.PI_NOTIFY_TITLE_B64, "base64").toString(
      "utf8",
    ),
    title,
  );
  assert.equal(
    Buffer.from(transport.environment.PI_NOTIFY_BODY_B64, "base64").toString(
      "utf8",
    ),
    body,
  );
});

test("warns once in the TUI when config is invalid", () => {
  const harness = createHarness({ config: "not json" });
  harness.emit("session_start");
  harness.emit("session_start");

  assert.equal(harness.uiNotifications.length, 1);
  assert.equal(harness.uiNotifications[0]?.type, "warning");
  assert.match(harness.uiNotifications[0]?.message ?? "", /15 second/);
  assert.equal(harness.configReads(), 1);
});

test("long mode skips short runs and emits for threshold runs", () => {
  const below = createHarness();
  below.emit("agent_start");
  below.setTime(14_999);
  below.emit("agent_settled");
  assert.deepEqual(below.writes, []);

  const above = createHarness();
  above.emit("agent_start");
  above.setTime(15_000);
  above.emit("agent_settled");
  assert.equal(above.writes.length, 1);
  assert.match(above.writes[0] ?? "", /Run complete — ready for input/);
});

test("always mode emits for a short run and off mode emits none", () => {
  const always = createHarness({
    config: '{ "mode": "always", "minimumDurationMs": 15000 }',
  });
  always.emit("agent_start");
  always.setTime(1);
  always.emit("agent_settled");
  assert.equal(always.writes.length, 1);

  const off = createHarness({
    config: '{ "mode": "off", "minimumDurationMs": 15000 }',
  });
  off.emit("agent_start");
  off.setTime(60_000);
  off.emit("agent_settled");
  assert.deepEqual(off.writes, []);
});

test("repeated starts keep the original time and one settle emits once", () => {
  const harness = createHarness();
  harness.emit("agent_start");
  harness.setTime(10_000);
  harness.emit("agent_start");
  harness.setTime(15_000);
  harness.emit("agent_settled");
  harness.setTime(30_000);
  harness.emit("agent_settled");

  assert.equal(harness.writes.length, 1);
});

test("does not register agent_end", () => {
  const harness = createHarness();
  assert.deepEqual([...harness.handlers.keys()].sort(), [
    "agent_settled",
    "agent_start",
    "session_shutdown",
    "session_start",
  ]);
});

test("print, json, and non-TTY contexts emit no control sequences", () => {
  for (const mode of ["print", "json"] as const) {
    const harness = createHarness({
      config: '{ "mode": "always", "minimumDurationMs": 15000 }',
    });
    harness.emit("agent_start");
    harness.setTime(1);
    harness.emit("agent_settled", makeContext(mode));
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.launches, []);
  }

  const nonTTY = createHarness({
    config: '{ "mode": "always", "minimumDurationMs": 15000 }',
    tty: false,
    environment: { WT_SESSION: "1" },
  });
  nonTTY.emit("agent_start");
  nonTTY.setTime(1);
  nonTTY.emit("agent_settled");
  assert.deepEqual(nonTTY.writes, []);
  assert.deepEqual(nonTTY.launches, []);
});

test("session shutdown clears run timing", () => {
  const harness = createHarness({
    config: '{ "mode": "always", "minimumDurationMs": 15000 }',
  });
  harness.emit("agent_start");
  harness.emit("session_shutdown");
  harness.setTime(60_000);
  harness.emit("agent_settled");

  assert.deepEqual(harness.writes, []);
});

test("Windows launch success writes no OSC and launch failure falls back", () => {
  const success = createHarness({
    config: '{ "mode": "always", "minimumDurationMs": 15000 }',
    environment: { WT_SESSION: "1" },
  });
  success.emit("agent_start");
  success.setTime(1);
  success.emit("agent_settled");
  assert.equal(success.launches.length, 1);
  assert.deepEqual(success.writes, []);

  const failure = createHarness({
    config: '{ "mode": "always", "minimumDurationMs": 15000 }',
    environment: { WT_SESSION: "1" },
    launchError: new Error("powershell unavailable"),
  });
  failure.emit("agent_start");
  failure.setTime(1);
  failure.emit("agent_settled");
  assert.equal(failure.launches.length, 1);
  assert.equal(failure.writes.length, 1);
  assert.match(failure.writes[0] ?? "", /^\u001b\]777;/);
});

test("writer and process-launcher errors never escape", () => {
  const osc = buildNotificationTransport({}, "Pi", "Ready");
  assert.doesNotThrow(() =>
    dispatchNotification(osc, {
      environment: () => ({}),
      write: () => {
        throw new Error("closed output");
      },
      launch: () => {
        throw new Error("unexpected launch");
      },
    }),
  );

  const windows = buildNotificationTransport(
    { WT_SESSION: "1" },
    "Pi",
    "Ready",
  );
  assert.doesNotThrow(() =>
    dispatchNotification(windows, {
      environment: () => ({}),
      write: () => {
        throw new Error("closed output");
      },
      launch: () => {
        throw new Error("powershell unavailable");
      },
    }),
  );
});

test("notify command changes only in-memory mode and reports status", () => {
  const harness = createHarness();
  harness.command("off");
  harness.emit("agent_start");
  harness.setTime(60_000);
  harness.emit("agent_settled");
  assert.deepEqual(harness.writes, []);

  harness.command("always");
  harness.emit("agent_start");
  harness.setTime(60_001);
  harness.emit("agent_settled");
  assert.equal(harness.writes.length, 1);

  harness.command("status");
  harness.command("invalid");
  assert.match(
    harness.uiNotifications.at(-2)?.message ?? "",
    /Notifications: always/,
  );
  assert.equal(
    harness.uiNotifications.at(-1)?.message,
    "Usage: /notify [off|long|always|status]",
  );
  assert.equal(harness.configReads(), 1);
});
