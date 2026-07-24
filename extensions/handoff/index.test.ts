import assert from "node:assert/strict";
import test from "node:test";
import type {
  Context,
  Model,
  ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import type {
  BorderedLoader,
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createHandoffExtension } from "./index.ts";
import {
  OLDER_CONTEXT_MARKER,
  serializeHandoffTranscript,
} from "./transcript.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function messageEntry(
  id: string,
  message: Extract<SessionEntry, { type: "message" }>["message"],
  parentId: string | null = null,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(0).toISOString(),
    message,
  };
}

function userEntry(id: string, content: string): SessionEntry {
  return messageEntry(id, { role: "user", content, timestamp: 0 });
}

test("serializes user and assistant text in chronological order", () => {
  const transcript = serializeHandoffTranscript([
    userEntry("user-1", "First request"),
    messageEntry("assistant-1", {
      role: "assistant",
      content: [{ type: "text", text: "First answer" }],
      api: "test",
      provider: "test",
      model: "test",
      usage,
      stopReason: "stop",
      timestamp: 1,
    }),
    userEntry("user-2", "Second request"),
  ]);

  assert.ok(
    transcript.indexOf("First request") < transcript.indexOf("First answer"),
  );
  assert.ok(
    transcript.indexOf("First answer") < transcript.indexOf("Second request"),
  );
});

test("marks images and omits thinking, tool payloads, results, and fake tokens", () => {
  const fakeToken = ["sk", "synthetic", "do", "not", "copy", "123456789"].join(
    "-",
  );
  const transcript = serializeHandoffTranscript([
    messageEntry("user", {
      role: "user",
      content: [
        { type: "text", text: "Inspect this image" },
        { type: "image", data: fakeToken, mimeType: "image/png" },
      ],
      timestamp: 0,
    }),
    messageEntry("assistant", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: `private ${fakeToken}` },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: fakeToken },
        },
        { type: "text", text: "The visible answer" },
      ],
      api: "test",
      provider: "test",
      model: "test",
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    }),
    messageEntry("tool-result", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: `raw result ${fakeToken}` }],
      isError: false,
      timestamp: 2,
    }),
  ]);

  assert.match(transcript, /\[image omitted\]/);
  assert.match(transcript, /The visible answer/);
  assert.doesNotMatch(transcript, /private/);
  assert.doesNotMatch(transcript, /toolCall|arguments|raw result|read/);
  assert.doesNotMatch(transcript, new RegExp(fakeToken));
});

test("uses only the latest compaction summary and its retained context", () => {
  const entries: SessionEntry[] = [
    userEntry("old", "old message that was summarized"),
    userEntry("first-kept", "first retained message"),
    {
      type: "compaction",
      id: "compaction-1",
      parentId: "first-kept",
      timestamp: new Date(1).toISOString(),
      summary: "obsolete compaction summary",
      firstKeptEntryId: "first-kept",
      tokensBefore: 100,
    },
    userEntry("between", "message covered by the later compaction"),
    userEntry("latest-kept", "latest retained message"),
    {
      type: "compaction",
      id: "compaction-2",
      parentId: "latest-kept",
      timestamp: new Date(2).toISOString(),
      summary: "latest focused summary",
      firstKeptEntryId: "latest-kept",
      tokensBefore: 200,
    },
    userEntry("new", "newest message"),
  ];

  const transcript = serializeHandoffTranscript(entries);
  assert.match(transcript, /latest focused summary/);
  assert.match(transcript, /latest retained message/);
  assert.match(transcript, /newest message/);
  assert.doesNotMatch(transcript, /old message|obsolete|covered by/);
  assert.equal(transcript.match(/latest retained message/g)?.length, 1);
});

test("returns empty when there is no meaningful handoff content", () => {
  const transcript = serializeHandoffTranscript([
    messageEntry("assistant", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "omit me" },
        {
          type: "toolCall",
          id: "call",
          name: "bash",
          arguments: { command: "omit me too" },
        },
      ],
      api: "test",
      provider: "test",
      model: "test",
      usage,
      stopReason: "toolUse",
      timestamp: 0,
    }),
  ]);

  assert.equal(transcript, "");
});

test("caps by UTF-8 bytes, retains newest context, and keeps Unicode valid", () => {
  const transcript = serializeHandoffTranscript(
    [
      userEntry("old", `old-prefix-${"🙂".repeat(200)}`),
      userEntry("new", "newest-context-🏁"),
    ],
    120,
  );

  assert.ok(Buffer.byteLength(transcript, "utf8") <= 120);
  assert.match(transcript, new RegExp(OLDER_CONTEXT_MARKER));
  assert.match(transcript, /newest-context-🏁/);
  assert.doesNotMatch(transcript, /old-prefix/);

  for (let index = 0; index < transcript.length; index += 1) {
    const code = transcript.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = transcript.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff);
      index += 1;
    } else {
      assert.ok(code < 0xdc00 || code > 0xdfff);
    }
  }
});

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type NewSessionOptions = NonNullable<
  Parameters<ExtensionCommandContext["newSession"]>[0]
>;
type ReplacedSessionContext = Parameters<
  NonNullable<NewSessionOptions["withSession"]>
>[0];

interface CommandHarnessOptions {
  mode?: ExtensionCommandContext["mode"];
  model?: ExtensionCommandContext["model"];
  branch?: SessionEntry[];
  sessionFile?: string;
  generation?:
    | { kind: "success"; draft: string }
    | { kind: "cancelled" }
    | { kind: "failed" };
  editedPrompt?: string;
  editorCancelled?: boolean;
  newSessionCancelled?: boolean;
}

function commandHarness(options: CommandHarnessOptions = {}) {
  let command: Command | undefined;
  let newSessionCalls = 0;
  let parentSession: string | undefined;
  let replacementEditorText: string | undefined;
  let sendUserMessageCalls = 0;
  const notifications: Array<{ message: string; type?: string }> = [];
  const branch = options.branch ?? [userEntry("user", "existing context")];
  const generation = options.generation ?? {
    kind: "success" as const,
    draft: "generated draft",
  };
  const model =
    "model" in options
      ? options.model
      : ({
          id: "active-model",
          provider: "test",
          api: "test",
        } as unknown as NonNullable<ExtensionCommandContext["model"]>);

  const replacementCtx = {
    ui: {
      setEditorText: (text: string) => {
        replacementEditorText = text;
      },
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
    },
    sendUserMessage: async () => {
      sendUserMessageCalls += 1;
    },
  } as unknown as ReplacedSessionContext;

  const ctx = {
    mode: options.mode ?? "tui",
    model,
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () =>
        "sessionFile" in options
          ? options.sessionFile
          : "/sessions/current.jsonl",
    },
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      custom: async () => generation,
      editor: async () =>
        options.editorCancelled
          ? undefined
          : (options.editedPrompt ?? "edited draft"),
    },
    newSession: async (newSessionOptions: {
      parentSession?: string;
      withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    }) => {
      newSessionCalls += 1;
      parentSession = newSessionOptions.parentSession;
      if (options.newSessionCancelled) return { cancelled: true };
      await newSessionOptions.withSession?.(replacementCtx);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

  const api = {
    registerCommand: (name: string, registered: Command) => {
      assert.equal(name, "handoff");
      command = registered;
    },
  } as unknown as ExtensionAPI;

  createHandoffExtension({
    complete: async () => {
      throw new Error("network completion must not run in command tests");
    },
    createSessionId: () => "fresh-session-id",
  })(api);

  return {
    ctx,
    get command() {
      assert.ok(command);
      return command;
    },
    notifications,
    get newSessionCalls() {
      return newSessionCalls;
    },
    get parentSession() {
      return parentSession;
    },
    get replacementEditorText() {
      return replacementEditorText;
    },
    get sendUserMessageCalls() {
      return sendUserMessageCalls;
    },
  };
}

test("registers the handoff command", () => {
  const harness = commandHarness();
  assert.equal(
    harness.command.description,
    "Prepare a focused replacement session",
  );
});

test("generation uses active-model auth, no cache, a fresh id, and the loader signal", async () => {
  const syntheticAuth = ["synthetic", "auth"].join("-");
  const controller = new AbortController();
  const loader = {
    signal: controller.signal,
    set onAbort(_handler: (() => void) | undefined) {},
  } as unknown as BorderedLoader;
  const activeModel = {
    id: "active-model",
    provider: "active-provider",
    api: "test",
  } as unknown as NonNullable<ExtensionCommandContext["model"]>;
  let authModel: Model<string> | undefined;
  let completionModel:
    NonNullable<ExtensionCommandContext["model"]> | undefined;
  let completionContext: Context | undefined;
  let completionOptions: ProviderStreamOptions | undefined;
  let editorPrefill: string | undefined;
  let command: Command | undefined;

  const ctx = {
    mode: "tui",
    model: activeModel,
    modelRegistry: {
      getApiKeyAndHeaders: async (model: Model<string>) => {
        authModel = model;
        return {
          ok: true as const,
          apiKey: syntheticAuth,
          headers: { "x-test": "header" },
          env: { TEST_ENV: "value" },
        };
      },
    },
    sessionManager: {
      getBranch: () => [userEntry("user", "existing context")],
      getSessionFile: () => "/sessions/current.jsonl",
    },
    ui: {
      notify: () => {},
      custom: async (
        factory: (
          tui: never,
          theme: never,
          keybindings: never,
          done: (result: unknown) => void,
        ) => unknown,
      ) =>
        new Promise((resolve) => {
          factory(
            undefined as never,
            undefined as never,
            undefined as never,
            resolve,
          );
        }),
      editor: async (_title: string, prefill?: string) => {
        editorPrefill = prefill;
        return undefined;
      },
    },
  } as unknown as ExtensionCommandContext;
  const api = {
    registerCommand: (_name: string, registered: Command) => {
      command = registered;
    },
  } as unknown as ExtensionAPI;

  createHandoffExtension({
    complete: async (model, context, options) => {
      completionModel = model;
      completionContext = context;
      completionOptions = options;
      return {
        role: "assistant",
        content: [{ type: "text", text: "focused generated draft" }],
        api: "test",
        provider: "active-provider",
        model: "active-model",
        usage,
        stopReason: "stop",
        timestamp: 0,
      };
    },
    createSessionId: () => "fresh-session-id",
    createLoader: () => loader,
  })(api);

  assert.ok(command);
  await command.handler("finish the next task", ctx);

  assert.equal(authModel, activeModel);
  assert.equal(completionModel, activeModel);
  assert.equal(completionOptions?.apiKey, syntheticAuth);
  assert.deepEqual(completionOptions?.headers, { "x-test": "header" });
  assert.deepEqual(completionOptions?.env, { TEST_ENV: "value" });
  assert.equal(completionOptions?.cacheRetention, "none");
  assert.equal(completionOptions?.sessionId, "fresh-session-id");
  assert.equal(completionOptions?.signal, controller.signal);
  assert.match(completionContext?.systemPrompt ?? "", /self-contained/);
  assert.match(
    String(completionContext?.messages[0]?.content),
    /existing context/,
  );
  assert.match(
    String(completionContext?.messages[0]?.content),
    /finish the next task/,
  );
  assert.equal(editorPrefill, "focused generated draft");
});

test("rejects a missing goal", async () => {
  const harness = commandHarness();
  await harness.command.handler("   ", harness.ctx);
  assert.equal(harness.newSessionCalls, 0);
  assert.match(harness.notifications[0]?.message ?? "", /Usage/);
});

test("rejects non-TUI mode", async () => {
  const harness = commandHarness({ mode: "rpc" });
  await harness.command.handler("next goal", harness.ctx);
  assert.equal(harness.newSessionCalls, 0);
  assert.match(harness.notifications[0]?.message ?? "", /TUI/);
});

test("rejects a missing active model", async () => {
  const harness = commandHarness({ model: undefined });
  await harness.command.handler("next goal", harness.ctx);
  assert.equal(harness.newSessionCalls, 0);
  assert.match(harness.notifications[0]?.message ?? "", /active model/);
});

test("rejects an empty transcript", async () => {
  const harness = commandHarness({ branch: [] });
  await harness.command.handler("next goal", harness.ctx);
  assert.equal(harness.newSessionCalls, 0);
  assert.match(harness.notifications[0]?.message ?? "", /No conversation text/);
});

test("generation cancellation does not create a session", async () => {
  const harness = commandHarness({ generation: { kind: "cancelled" } });
  await harness.command.handler("next goal", harness.ctx);
  assert.equal(harness.newSessionCalls, 0);
  assert.match(harness.notifications.at(-1)?.message ?? "", /cancelled/);
});

test("editor cancellation does not create a session", async () => {
  const harness = commandHarness({ editorCancelled: true });
  await harness.command.handler("next goal", harness.ctx);
  assert.equal(harness.newSessionCalls, 0);
  assert.match(harness.notifications.at(-1)?.message ?? "", /cancelled/);
});

test("success creates a related session and leaves an editable draft without submitting", async () => {
  const harness = commandHarness({ editedPrompt: "reviewed handoff prompt" });
  await harness.command.handler("next goal", harness.ctx);

  assert.equal(harness.newSessionCalls, 1);
  assert.equal(harness.parentSession, "/sessions/current.jsonl");
  assert.equal(harness.replacementEditorText, "reviewed handoff prompt");
  assert.equal(harness.sendUserMessageCalls, 0);
  assert.match(
    harness.notifications.at(-1)?.message ?? "",
    /submit when ready/,
  );
});

test("replacement cancellation keeps the original session and reports it", async () => {
  const harness = commandHarness({ newSessionCancelled: true });
  await harness.command.handler("next goal", harness.ctx);

  assert.equal(harness.newSessionCalls, 1);
  assert.equal(harness.replacementEditorText, undefined);
  assert.match(
    harness.notifications.at(-1)?.message ?? "",
    /original session is unchanged/,
  );
});
