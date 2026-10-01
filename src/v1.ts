import type { Plugin } from "@opencode-ai/plugin";
import { join } from "node:path";
import { buildAutoSave, buildSaveNudge, detectKeyword, shouldFlushOnTurn } from "./capture.ts";
import { loadConfig } from "./config.ts";
import { MemoryHub, defaultGlobalDir } from "./hub.ts";
import { createLogger } from "./logger.ts";
import { safeText } from "./redact.ts";
import { truncateChars } from "./text.ts";
import { createMemoryTools } from "./tools.ts";
import type { MemoryConfig } from "./types.ts";

/**
 * OpenCode v1 adapter.
 *
 * A v1 plugin is a function returning a hook object. The memory behaviour lives
 * in the shared core (store, verifier, injector, service); this file only maps
 * that behaviour onto v1's hook names.
 */

export interface V1Options {
  enabled?: boolean;
  recallMode?: "direct" | "advisory" | "off";
  maxInjectChars?: number;
  captureEveryNTurns?: number;
}

const ADVISORY_DIRECTIVE = [
  "[MEMORY] Persistent memory is available for this project.",
  "Decide whether recalling would help before answering, and call memory_recall if so.",
].join("\n");

export const MemoryPlugin: Plugin = async (input, options) => {
  const logger = createLogger(input.client);
  const worktree = input.worktree || input.directory;
  const globalDir = defaultGlobalDir();

  const loaded = await loadConfig(globalDir, join(worktree, ".opencode"), logger);
  const config = applyOverrides(loaded.config, (options ?? {}) as V1Options);

  const hub = new MemoryHub({ config, logger, globalDir });
  const tools = createMemoryTools({ hub });

  logger.info("memory plugin ready", {
    generation: 1,
    repoKey: hub.contextFor(worktree).scopes.repoKey,
    recallMode: config.recallMode,
    configSources: loaded.sources,
  });

  /** Best-effort summary text after compaction; never allowed to throw. */
  const readLatestAssistantText = async (sessionID: string): Promise<string | undefined> => {
    try {
      const session = input.client.session as unknown as {
        messages?: (options: unknown) => Promise<{ data?: unknown }>;
      };
      if (typeof session?.messages !== "function") return undefined;
      const response = await session.messages({ path: { id: sessionID } });
      return extractLatestAssistantText(response?.data);
    } catch (error) {
      logger.debug("could not read session messages", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };

  const recordCompactionSummary = async (sessionID: string): Promise<void> => {
    if (!config.compactionEnabled || !sessionID) return;
    const context = hub.contextFor(worktree);
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

  /** Called when a turn finishes: flush staged evidence on the configured cadence. */
  const onTurnIdle = async (sessionID: string | undefined): Promise<void> => {
    if (!sessionID) return;
    const context = hub.contextFor(worktree);
    const turns = context.capture.noteTurn(sessionID);
    if (!shouldFlushOnTurn(turns, config)) return;

    const candidate = context.capture.drain(sessionID);
    if (!candidate) return;

    if (config.autoSaveRepeatedEdits) {
      const draft = buildAutoSave(candidate);
      if (draft) {
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

  return {
    tool: tools,

    event: async ({ event }) => {
      try {
        const sessionID = sessionIdOf(event);
        switch (event.type) {
          case "session.created": {
            // Expiry is cheap and runs once per session rather than per request.
            hub.sweepAll();
            break;
          }
          case "session.idle": {
            await onTurnIdle(sessionID);
            break;
          }
          case "session.compacted": {
            await recordCompactionSummary(sessionID ?? "");
            break;
          }
          case "session.deleted": {
            if (sessionID) hub.releaseSession(worktree, sessionID);
            break;
          }
          default:
            break;
        }
      } catch (error) {
        logger.error("event handler failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /** Keyword nudges: the user said "remember", so ask for a durable fact. */
    "chat.message": async (chatInput, output) => {
      try {
        if (!config.enabled) return;
        const context = hub.contextFor(worktree);
        const text = `${collectPartText(output.parts)}\n${output.message.system ?? ""}`;
        const hit = detectKeyword(text, config.keywordPatterns);
        if (!hit) return;
        context.capture.setNudge(chatInput.sessionID, buildSaveNudge(context.capture.peek(chatInput.sessionID)), Date.now());
        logger.debug("keyword nudge queued", { pattern: hit });
      } catch (error) {
        logger.warn("chat.message handler failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /** Injection point: memory rides along with the system prompt. */
    "experimental.chat.system.transform": async (transformInput, output) => {
      try {
        if (!config.enabled) return;
        const context = hub.contextFor(worktree);
        const sessionID = transformInput.sessionID;

        if (config.recallMode === "direct") {
          const built = context.injector.build(sessionID ?? "profile-only");
          if (built?.block) output.system.push(built.block);
        } else if (config.recallMode === "advisory") {
          output.system.push(ADVISORY_DIRECTIVE);
        }

        if (sessionID) {
          const nudge = context.capture.takeNudge(sessionID);
          if (nudge) output.system.push(nudge);
        }
      } catch (error) {
        // Fail open: a broken store must never cost the user their turn.
        logger.warn("memory injection skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /** Observation only - never blocks or mutates the tool call. */
    "tool.execute.after": async (toolInput) => {
      try {
        if (!config.enabled) return;
        hub
          .contextFor(worktree)
          .capture.noteToolCall(toolInput.sessionID, toolInput.tool, toolInput.args, Date.now());
      } catch (error) {
        logger.debug("tool observation skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /** Carry verified memory into the continuation summary. */
    "experimental.session.compacting": async (compactInput, output) => {
      try {
        if (!config.enabled || !config.compactionEnabled) return;
        const context = hub.contextFor(worktree);
        const staged = context.capture.peek(compactInput.sessionID);
        const facts = context.project.recent(Math.min(5, config.maxMemoriesPerInject));

        const lines = [
          "## Persistent memory to preserve",
          "",
          ...facts.map((record) => `- ${record.subject}: ${truncateChars(record.fact, 200)}`),
        ];
        if (staged && staged.files.size > 0) {
          lines.push("", `## Files touched so far: ${[...staged.files.keys()].slice(0, 10).join(", ")}`);
        }
        if (staged && staged.commands.length > 0) {
          lines.push("", `## Commands run: ${staged.commands.slice(-5).join(" | ")}`);
        }
        lines.push("", "Preserve unresolved decisions and next steps; drop anything already settled.");
        output.context.push(lines.join("\n"));
      } catch (error) {
        logger.warn("compaction context skipped", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    dispose: async () => {
      try {
        hub.close();
      } catch {
        /* nothing useful to do while shutting down */
      }
    },
  };
};

function applyOverrides(config: MemoryConfig, options: V1Options | undefined): MemoryConfig {
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

function sessionIdOf(event: { type: string; properties?: unknown }): string | undefined {
  const properties = event.properties as Record<string, unknown> | undefined;
  if (!properties) return undefined;
  if (typeof properties["sessionID"] === "string") return properties["sessionID"];
  const info = properties["info"] as Record<string, unknown> | undefined;
  if (info && typeof info["id"] === "string") return info["id"];
  return undefined;
}

function collectPartText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") chunks.push(record["text"]);
  }
  return chunks.join("\n");
}

function extractLatestAssistantText(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const container = data as Record<string, unknown>;
  const parts = Array.isArray(container["parts"]) ? container["parts"] : Array.isArray(data) ? data : undefined;
  if (!parts) return undefined;

  let best: { text: string; score: number } | undefined;
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (record["type"] !== "text" || typeof record["text"] !== "string") continue;
    const time = (record["time"] as Record<string, unknown> | undefined)?.["end"];
    const score = (typeof time === "number" ? time : 0) * 1_000 + String(record["messageID"] ?? "").length;
    if (!best || score >= best.score) best = { text: record["text"], score };
  }
  return best?.text;
}

export default MemoryPlugin;
