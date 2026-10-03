import { Plugin } from "@opencode/plugin";
import { join } from "node:path";
import { buildAutoSave, buildSaveNudge, detectKeyword, shouldFlushOnTurn } from "./capture.ts";
import { loadConfig } from "./config.ts";
import { MemoryHub, defaultGlobalDir, sessionStoreFor } from "./hub.ts";
import { createLogger } from "./logger.ts";
import { safeText } from "./redact.ts";
import { toRepoRelative } from "./scopes.ts";
import { MemoryService } from "./service.ts";
import { truncateChars } from "./text.ts";
import { TOOL_NAMES, TOOL_SPECS } from "./tool-schema.ts";
import { DEFAULT_CONFIG, type MemoryConfig } from "./types.ts";
import type { WorktreeContext } from "./hub.ts";
import type { StagedCandidate } from "./capture.ts";

/**
 * OpenCode v2 adapter.
 *
 * v2 plugins default-export `Plugin.define({ id, setup(ctx) })` and register
 * everything through the context instead of returning hook objects. The memory
 * behaviour is identical to the v1 path; this file only translates the API:
 *
 *   v1 event callback                  -> ctx.event.subscribe()
 *   v1 tool.execute.after              -> ctx.tool.hook("execute.after")
 *   v1 chat.message                    -> ctx.session.hook("prompt")
 *   v1 experimental.chat.system.transform -> ctx.session.hook("context") + event.system
 *   v1 experimental.session.compacting -> ctx.session.hook("compaction")
 *   v1 dispose                         -> cleanup returned by setup
 */

const ADVISORY_DIRECTIVE = [
  "[MEMORY] Persistent memory is available for this project.",
  "Decide whether recalling would help before answering, and call memory_recall if so.",
].join("\n");

export interface V2Options {
  enabled?: boolean;
  recallMode?: "direct" | "advisory" | "off";
  maxInjectChars?: number;
  captureEveryNTurns?: number;
}

export const memoryPluginV2 = Plugin.define({
  id: "opencode-memory",

  async setup(ctx) {
    const logger = createLogger((ctx as unknown as { client?: unknown }).client);
    const worktree = String(ctx.location.project.canonical ?? ctx.location.directory);
    const globalDir = defaultGlobalDir();

    const loaded = await loadConfig(globalDir, join(worktree, ".opencode"), logger);
    const config = applyOverrides(loaded.config, ctx.options as V2Options | undefined);

    const hub = new MemoryHub({ config, logger, globalDir });
    const service = new MemoryService(hub);

    logger.info("memory plugin ready", {
      generation: 2,
      worktree,
      recallMode: config.recallMode,
      configSources: loaded.sources,
    });

    const contextFor = (): WorktreeContext => hub.contextFor(worktree);

    /** Best-effort latest assistant text; never allowed to break a session. */
    const readLatestAssistantText = async (sessionID: string): Promise<string | undefined> => {
      try {
        const messages = await ctx.session.context({ sessionID: sessionID as never });
        if (!Array.isArray(messages)) return undefined;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const message = messages[i] as Record<string, unknown>;
          const parts = message["parts"];
          if (!Array.isArray(parts)) continue;
          const chunks = parts
            .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
            .filter((part) => part["type"] === "text" && typeof part["text"] === "string")
            .map((part) => String(part["text"]));
          if (chunks.length > 0) return chunks.join("\n");
        }
        return undefined;
      } catch (error) {
        logger.debug("could not read session context", {
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    };

    const storeCompactionSummary = async (sessionID: string): Promise<void> => {
      if (!config.compactionEnabled) return;
      const context = contextFor();
      const staged = context.capture.peek(sessionID);
      const citations = staged ? [...staged.files.keys()].slice(0, 5).map((path) => ({ path })) : [];
      if (citations.length === 0) return;

      const summary = await readLatestAssistantText(sessionID);
      if (!summary) return;

      try {
        const record = context.project.add({
          subject: "Session handoff notes",
          fact: safeText(truncateChars(summary.replace(/\s+/g, " ").trim(), 1200), config.redactPrivate),
          citations,
          reason: "Captured at compaction so the next context window can resume without re-reading everything.",
          kind: "conversation",
        });
        context.injector.invalidate();
        context.injector.noteSave();
        logger.debug("stored compaction summary", { id: record.id });
      } catch (error) {
        logger.warn("failed to store compaction summary", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const onTurnIdle = async (sessionID: string): Promise<void> => {
      const context = contextFor();
      const turns = context.capture.noteTurn(sessionID);
      if (!shouldFlushOnTurn(turns, config)) return;

      const candidate = context.capture.drain(sessionID);
      if (!candidate) return;

      if (config.autoSaveRepeatedEdits) {
        const draft = buildAutoSave(candidate);
        if (draft) {
          // Tool args may carry absolute paths; the store keeps repo-relative ones.
          draft.citations = draft.citations.map((citation) => toRepoRelative(citation, worktree));
          try {
            const record = context.project.add(draft);
            context.injector.invalidate();
            context.injector.noteSave();
            logger.debug("auto-saved repeated-edit pattern", { id: record.id, turn: turns });
            return;
          } catch (error) {
            logger.warn("auto-save failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      if (candidate.files.size > 0) {
        context.capture.setNudge(sessionID, buildSaveNudge(candidate), Date.now());
      }
    };

    // --- tools -------------------------------------------------------------
    await ctx.tool.transform((editor) => {
      for (const name of TOOL_NAMES) {
        const spec = TOOL_SPECS[name];
        editor.add({
          name,
          description: spec.description,
          input: spec.json,
          execute: async (input, context) => {
            const args = (input ?? {}) as Record<string, unknown>;
            try {
              const text = await service.call(name, {
                worktree,
                sessionID: String(context.sessionID ?? "unknown"),
                args,
              });
              return { content: text };
            } catch (error) {
              // A tool that throws is an error the agent must handle; returning
              // the reason as content keeps memory problems from killing a turn.
              const message = error instanceof Error ? error.message : String(error);
              logger.warn(`${name} failed`, { error: message });
              return { content: `Memory tool ${name} failed: ${message}` };
            }
          },
        });
      }
    });

    // --- keyword nudges ----------------------------------------------------
    await ctx.session.hook("prompt", (event) => {
      try {
        if (!config.enabled) return;
        const text = String(event.prompt.text ?? "");
        if (!detectKeyword(text, config.keywordPatterns)) return;
        const sessionID = String(event.sessionID);
        contextFor().capture.setNudge(sessionID, buildSaveNudge(contextFor().capture.peek(sessionID)), Date.now());
      } catch (error) {
        logger.debug("prompt hook skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // --- injection ---------------------------------------------------------
    await ctx.session.hook("context", (event) => {
      try {
        if (!config.enabled) return;
        const context = contextFor();
        const sessionID = String(event.sessionID);
        sessionStoreFor(context, sessionID, config);

        if (config.recallMode === "direct") {
          const built = context.injector.build(sessionID);
          if (built?.block) event.system.push({ type: "text", text: built.block });
        } else if (config.recallMode === "advisory") {
          event.system.push({ type: "text", text: ADVISORY_DIRECTIVE });
        }

        const nudge = context.capture.takeNudge(sessionID);
        if (nudge) event.system.push({ type: "text", text: nudge });
      } catch (error) {
        logger.warn("memory injection skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // --- observation -------------------------------------------------------
    await ctx.tool.hook("execute.after", (event) => {
      try {
        if (!config.enabled) return;
        if (!isMutatingTool(event.tool)) return;
        contextFor().capture.noteToolCall(String(event.sessionID), event.tool, event.input, Date.now());
      } catch (error) {
        logger.debug("tool observation skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // --- compaction --------------------------------------------------------
    await ctx.session.hook("compaction", async (event) => {
      try {
        if (!config.enabled || !config.compactionEnabled) return;
        const context = contextFor();
        const sessionID = String(event.sessionID);
        const staged: StagedCandidate | undefined = context.capture.peek(sessionID);
        const facts = context.project.recent(Math.min(5, config.maxMemoriesPerInject));

        const lines = ["## Persistent memory to preserve", "", ...facts.map((record) => `- ${record.subject}: ${truncateChars(record.fact, 200)}`)];
        if (staged && staged.files.size > 0) {
          lines.push("", `## Files touched so far: ${[...staged.files.keys()].slice(0, 10).join(", ")}`);
        }
        if (staged && staged.commands.length > 0) {
          lines.push("", `## Commands run: ${staged.commands.slice(-5).join(" | ")}`);
        }
        lines.push("", "Preserve unresolved decisions and next steps; drop anything already settled.");

        // Prepend so the summary is produced with this guidance in view.
        event.system.unshift({ type: "text", text: lines.join("\n") });
      } catch (error) {
        logger.warn("compaction context skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // --- events ------------------------------------------------------------
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = (event as { type?: unknown }).type;
          const properties = (event as { properties?: unknown }).properties as
            | Record<string, unknown>
            | undefined;
          if (!properties) continue;
          const direct = typeof properties["sessionID"] === "string" ? properties["sessionID"] : undefined;
          const info = properties["info"] as Record<string, unknown> | undefined;
          const sessionID = direct ?? (info && typeof info["id"] === "string" ? info["id"] : undefined);

          if (type === "session.idle" && sessionID) await onTurnIdle(sessionID);
          else if (type === "session.created") hub.sweepAll();
          else if (type === "session.compacted" && sessionID) await storeCompactionSummary(sessionID);
          else if (type === "session.deleted" && sessionID) hub.releaseSession(worktree, sessionID);
        }
      } catch (error) {
        // An aborted subscription is the normal shutdown path.
        if (!controller.signal.aborted) {
          logger.warn("event subscription ended", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      controller.abort();
      hub.close();
    };
  },
});

function isMutatingTool(name: string): boolean {
  return ["edit", "write", "patch", "apply_patch", "multiedit", "bash"].includes(name);
}

function applyOverrides(config: MemoryConfig, options: V2Options | undefined): MemoryConfig {
  if (!options || typeof options !== "object") return config;
  const merged: MemoryConfig = { ...config, keywordPatterns: [...config.keywordPatterns] };
  if (typeof options.enabled === "boolean") merged.enabled = options.enabled;
  if (options.recallMode === "direct" || options.recallMode === "advisory" || options.recallMode === "off") {
    merged.recallMode = options.recallMode;
  }
  if (typeof options.maxInjectChars === "number" && Number.isFinite(options.maxInjectChars)) {
    merged.maxInjectChars = Math.max(200, Math.min(100_000, Math.floor(options.maxInjectChars)));
  }
  if (typeof options.captureEveryNTurns === "number" && Number.isFinite(options.captureEveryNTurns)) {
    merged.captureEveryNTurns = Math.max(0, Math.floor(options.captureEveryNTurns));
  }
  return merged;
}

export { DEFAULT_CONFIG };
