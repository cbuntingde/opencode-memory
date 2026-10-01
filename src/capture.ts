import type { MemoryConfig } from "./types.ts";

/**
 * Observation and capture staging.
 *
 * Nothing here writes to disk on its own. The queue accumulates evidence while
 * the agent works, and the turn boundary decides whether that evidence is
 * worth a nudge or strong enough to record directly.
 */

export interface StagedCandidate {
  /** Repo-relative path -> number of mutating calls against it. */
  files: Map<string, number>;
  tools: Set<string>;
  commands: string[];
}

export interface AutoSaveDraft {
  subject: string;
  fact: string;
  citations: Array<{ path: string }>;
  reason: string;
  kind: "learned-pattern";
}

const MUTATING_TOOLS = new Set(["edit", "write", "apply_patch", "patch", "multiedit"]);
const FILE_ARG_KEYS = ["filePath", "path", "file", "file_path", "target"];

export class CaptureQueue {
  private readonly staged = new Map<string, StagedCandidate>();
  private readonly turns = new Map<string, number>();
  private readonly nudges = new Map<string, string>();
  private readonly lastNudgeAt = new Map<string, number>();

  noteToolCall(sessionID: string, tool: string, args: unknown, now: number): void {
    const candidate = this.ensure(sessionID);
    candidate.tools.add(tool);

    if (MUTATING_TOOLS.has(tool)) {
      for (const path of extractFilePaths(args)) {
        candidate.files.set(path, (candidate.files.get(path) ?? 0) + 1);
      }
    }

    if (tool === "bash") {
      const command = readString(args, ["command", "cmd"]);
      if (command) {
        candidate.commands.push(truncateChars(command, 200));
        if (candidate.commands.length > 20) candidate.commands.shift();
      }
    }

    // Any mutating activity invalidates a nudge that is still waiting to be
    // consumed, so the agent is not told to save something it just did.
    if (MUTATING_TOOLS.has(tool)) this.nudges.delete(sessionID);
    void now;
  }

  /** Increments and returns the completed-turn count for a session. */
  noteTurn(sessionID: string): number {
    const next = (this.turns.get(sessionID) ?? 0) + 1;
    this.turns.set(sessionID, next);
    return next;
  }

  turnCount(sessionID: string): number {
    return this.turns.get(sessionID) ?? 0;
  }

  peek(sessionID: string): StagedCandidate | undefined {
    return this.staged.get(sessionID);
  }

  drain(sessionID: string): StagedCandidate | undefined {
    const candidate = this.staged.get(sessionID);
    this.staged.delete(sessionID);
    return candidate;
  }

  clear(sessionID: string): void {
    this.staged.delete(sessionID);
    this.turns.delete(sessionID);
    this.nudges.delete(sessionID);
    this.lastNudgeAt.delete(sessionID);
  }

  hasPending(sessionID: string): boolean {
    const candidate = this.staged.get(sessionID);
    if (!candidate) return false;
    return candidate.files.size > 0 || candidate.tools.size > 0;
  }

  setNudge(sessionID: string, text: string, now: number): void {
    // One nudge per cooldown window avoids nagging on every keyword match.
    // The first nudge for a session is always allowed.
    const last = this.lastNudgeAt.get(sessionID);
    if (last !== undefined && now - last < 60_000) return;
    this.nudges.set(sessionID, text);
    this.lastNudgeAt.set(sessionID, now);
  }

  takeNudge(sessionID: string): string | undefined {
    const nudge = this.nudges.get(sessionID);
    this.nudges.delete(sessionID);
    return nudge;
  }

  private ensure(sessionID: string): StagedCandidate {
    const existing = this.staged.get(sessionID);
    if (existing) return existing;
    const created: StagedCandidate = { files: new Map(), tools: new Set(), commands: [] };
    this.staged.set(sessionID, created);
    return created;
  }
}

/**
 * A file edited at least twice in one session is a signal worth recording on its
 * own: it is the part of the codebase the task is actually about.
 */
export function buildAutoSave(candidate: StagedCandidate, minEdits = 2): AutoSaveDraft | undefined {
  const repeated = [...candidate.files.entries()]
    .filter(([, count]) => count >= minEdits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (repeated.length === 0) return undefined;

  const total = repeated.reduce((sum, [, count]) => sum + count, 0);
  const names = repeated.map(([path, count]) => `${path} (${count} edits)`);

  return {
    subject: "Files this task kept returning to",
    fact: `Repeatedly edited during a recent task: ${names.join(", ")}.`,
    citations: repeated.map(([path]) => ({ path })),
    reason: "Files edited more than once are usually central to the task; knowing them speeds up follow-up work.",
    kind: "learned-pattern",
  };
}

/** Message shown to the model when durable knowledge is worth recording. */
export function buildSaveNudge(candidate: StagedCandidate | undefined): string {
  const files = candidate ? [...candidate.files.keys()].slice(0, 8) : [];
  if (files.length === 0) {
    return "[MEMORY] If you learned a durable convention, build command or invariant, record it with memory_add (one citation per code location that proves it).";
  }
  return [
    "[MEMORY] This session touched: " + files.join(", ") + ".",
    "If any of it encodes a convention, build command or invariant that will matter next time, record it now with memory_add.",
    "Cite the specific file and line that proves each fact. Do not record facts you cannot cite.",
  ].join("\n");
}

export function detectKeyword(text: string, patterns: string[]): string | undefined {
  if (!text) return undefined;
  const haystack = text.toLowerCase();
  for (const pattern of patterns) {
    if (pattern && haystack.includes(pattern.toLowerCase())) return pattern;
  }
  return undefined;
}

export function extractFilePaths(args: unknown): string[] {
  if (typeof args !== "object" || args === null) return [];
  const record = args as Record<string, unknown>;
  const out: string[] = [];

  for (const key of FILE_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      out.push(value.trim());
      break;
    }
  }

  // Multi-edit tools pass an array of {path|filePath, ...} objects, and some
  // tools pass a plain array of paths.
  for (const value of Object.values(record)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string") {
        if (looksLikePath(item)) out.push(item.trim());
        continue;
      }
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      for (const key of FILE_ARG_KEYS) {
        const nested = entry[key];
        if (typeof nested === "string" && nested.trim().length > 0) {
          out.push(nested.trim());
          break;
        }
      }
    }
  }

  return [...new Set(out.filter((path) => path.length > 0 && !path.startsWith("<")))].slice(0, 10);
}

function looksLikePath(value: string): boolean {
  return /[./\\]/.test(value) && value.length < 400 && !/^\s*$/.test(value);
}

function readString(args: unknown, keys: string[]): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function truncateChars(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max - 3)}...`;
}

/** Config-driven decision on whether a completed turn should flush evidence. */
export function shouldFlushOnTurn(turnCount: number, config: MemoryConfig): boolean {
  if (config.captureEveryNTurns <= 0) return false;
  return turnCount % config.captureEveryNTurns === 0;
}
