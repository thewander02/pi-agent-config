import {
  uuidv7,
  type AssistantMessage,
  type Context,
  type ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { serializeHandoffTranscript } from "./transcript.ts";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's next goal, write a focused prompt for a replacement session.

The prompt must:
1. Include only context relevant to the next goal.
2. Capture important decisions, constraints, approaches, and findings.
3. List relevant files that were discussed or modified.
4. Clearly state the next task.
5. Be self-contained so the replacement session can proceed without the old conversation.

Be concise but preserve necessary detail. Output only the prompt, with no preamble such as "Here's the prompt".`;

type ActiveModel = NonNullable<ExtensionCommandContext["model"]>;
type Completion = (
  model: ActiveModel,
  context: Context,
  options?: ProviderStreamOptions,
) => Promise<AssistantMessage>;

interface HandoffDependencies {
  complete: Completion;
  createSessionId: () => string;
  createLoader: (
    ...args: ConstructorParameters<typeof BorderedLoader>
  ) => BorderedLoader;
}

type GenerationResult =
  | { kind: "success"; draft: string }
  | { kind: "cancelled" }
  | { kind: "failed" };

const defaultDependencies: HandoffDependencies = {
  complete,
  createSessionId: uuidv7,
  createLoader: (...args) => new BorderedLoader(...args),
};

function generationMessage(transcript: string, goal: string) {
  return `## Conversation History

${transcript}

## Next Goal

${goal}`;
}

async function generateDraft(
  ctx: ExtensionCommandContext,
  model: ActiveModel,
  transcript: string,
  goal: string,
  dependencies: HandoffDependencies,
) {
  return ctx.ui.custom<GenerationResult>((tui, theme, _keybindings, done) => {
    const loader = dependencies.createLoader(
      tui,
      theme,
      "Generating handoff draft...",
    );
    let settled = false;
    const finish = (result: GenerationResult) => {
      if (settled) return;
      settled = true;
      done(result);
    };

    loader.onAbort = () => finish({ kind: "cancelled" });

    void (async () => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error("Active model authentication failed");

      const response = await dependencies.complete(
        model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: generationMessage(transcript, goal),
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          signal: loader.signal,
          cacheRetention: "none",
          sessionId: dependencies.createSessionId(),
        },
      );

      if (response.stopReason === "aborted") {
        finish({ kind: "cancelled" });
        return;
      }
      if (response.stopReason === "error") {
        finish({ kind: "failed" });
        return;
      }

      const draft = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      finish(draft ? { kind: "success", draft } : { kind: "failed" });
    })().catch(() => finish({ kind: "failed" }));

    return loader;
  });
}

export function createHandoffExtension(
  overrides: Partial<HandoffDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return (pi: ExtensionAPI) => {
    pi.registerCommand("handoff", {
      description: "Prepare a focused replacement session",
      handler: async (args, ctx) => {
        const goal = args.trim();
        if (!goal) {
          ctx.ui.notify("Usage: /handoff <next goal>", "error");
          return;
        }
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/handoff requires interactive TUI mode.", "error");
          return;
        }
        if (!ctx.model) {
          ctx.ui.notify("/handoff requires an active model.", "error");
          return;
        }

        const transcript = serializeHandoffTranscript(
          ctx.sessionManager.getBranch(),
        );
        if (!transcript) {
          ctx.ui.notify(
            "No conversation text is available to hand off.",
            "error",
          );
          return;
        }

        const parentSession = ctx.sessionManager.getSessionFile();
        if (!parentSession) {
          ctx.ui.notify(
            "The current session is not persisted; handoff cannot continue.",
            "error",
          );
          return;
        }

        const generation = await generateDraft(
          ctx,
          ctx.model,
          transcript,
          goal,
          dependencies,
        );
        if (generation.kind === "cancelled") {
          ctx.ui.notify("Handoff generation cancelled.", "info");
          return;
        }
        if (generation.kind === "failed") {
          ctx.ui.notify("Handoff generation failed.", "error");
          return;
        }

        const editedPrompt = await ctx.ui.editor(
          "Review handoff draft",
          generation.draft,
        );
        if (editedPrompt === undefined) {
          ctx.ui.notify("Handoff cancelled.", "info");
          return;
        }

        const result = await ctx.newSession({
          parentSession,
          withSession: async (replacementCtx) => {
            replacementCtx.ui.setEditorText(editedPrompt);
            replacementCtx.ui.notify(
              "Handoff draft ready. Review and submit when ready.",
              "info",
            );
          },
        });

        if (result.cancelled) {
          ctx.ui.notify(
            "New session cancelled; the original session is unchanged.",
            "info",
          );
        }
      },
    });
  };
}

export default createHandoffExtension();
