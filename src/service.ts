import { formatCitation, parseCitations } from "./citation.ts";
import { resolveScopeStore, sessionStoreFor, type MemoryHub, type WorktreeContext } from "./hub.ts";
import { safeText } from "./redact.ts";
import type { MemoryStore } from "./store.ts";
import type { SessionStore } from "./session-store.ts";
import { truncateChars } from "./text.ts";
import { TOOL_SPECS, type ToolName } from "./tool-schema.ts";
import { SCOPES, isMemoryKind, type MemoryKind, type MemoryRecord, type Scope } from "./types.ts";
import { describeVerification, verifyRecord } from "./verify.ts";

/**
 * Version-agnostic tool behaviour.
 *
 * Both plugin generations call these methods and get a string back; only the
 * schema and the result wrapper differ between them. Keeping the behaviour here
 * means a fix to citation enforcement or verification reporting lands in one
 * place instead of two adapters.
 */

export interface ToolCall {
  worktree: string;
  sessionID: string;
  args: Record<string, unknown>;
}

const SCOPE_LIST = SCOPES.join(", ");

export class MemoryService {
  constructor(private readonly hub: MemoryHub) {}

  async call(name: ToolName, call: ToolCall): Promise<string> {
    switch (name) {
      case "memory_recall":
        return this.recall(call);
      case "memory_add":
        return this.add(call);
      case "memory_search":
        return this.search(call);
      case "memory_list":
        return this.list(call);
      case "memory_forget":
        return this.forget(call);
      case "memory_profile":
        return this.profile(call);
      case "memory_rebind":
        return this.rebind(call);
      default:
        return `Unknown memory tool: ${String(name)}`;
    }
  }

  private contextFor(call: ToolCall): { context: WorktreeContext; sessionID: string } {
    return {
      context: this.hub.contextFor(call.worktree),
      sessionID: call.sessionID || "unknown",
    };
  }

  private storeFor(context: WorktreeContext, scope: Scope, sessionID: string): MemoryStore | SessionStore {
    const store = resolveScopeStore(context, scope, sessionID, this.hub.config);
    if (!store) {
      throw new Error(`scope "${scope}" needs a session id; run this inside a session`);
    }
    return store;
  }

  private describe(record: MemoryRecord): string {
    return `[${record.id}] ${record.kind} · ${record.subject}\n  ${truncateChars(record.fact, 600)}\n  cites: ${
      record.citations.map(formatCitation).join(", ") || "none"
    }`;
  }

  private scopesFrom(raw: unknown, fallback: Scope[]): Scope[] {
    if (!raw || raw === "all") return fallback;
    const value = String(raw);
    return (SCOPES as readonly string[]).includes(value) ? [value as Scope] : fallback;
  }

  private async recall(call: ToolCall): Promise<string> {
    const { context, sessionID } = this.contextFor(call);
    const query = String(call.args["query"] ?? "");
    const requested = this.scopesFrom(call.args["scope"], ["project", "global", "session"]);
    const limit = clamp(call.args["limit"], 8, 1, 50);

    const blocks: string[] = [];
    const scopeNote = describeScopeFallback(call.args["scope"], requested);
    if (scopeNote) blocks.push(scopeNote);
    let total = 0;

    for (const scope of requested) {
      const store = resolveScopeStore(context, scope, sessionID, this.hub.config);
      if (!store) continue;
      const hits = store.search(query, { limit });
      if (hits.length === 0) continue;
      total += hits.length;
      blocks.push(`## ${scope} scope (${hits.length})`);
      for (const record of hits) {
        const check =
          scope === "session"
            ? "not required (working note)"
            : describeVerification(verifyRecord(record, context.worktree));
        blocks.push(`- [${record.id}] ${record.subject}\n  ${truncateChars(record.fact, 400)}\n  cites: ${
          record.citations.map(formatCitation).join(", ") || "none"
        }\n  check: ${check}`);
      }
      blocks.push("");
    }

    if (total === 0) {
      const prefix = scopeNote ? `${scopeNote}\n` : "";
      return `${prefix}No stored fact matches "${truncateChars(query, 120)}" in ${requested.join(" + ")}. Nothing is known yet - read the code instead of assuming.`;
    }
    return `Recalled ${total} fact(s) for "${truncateChars(query, 120)}":\n\n${blocks.join("\n").trim()}`;
  }

  private async add(call: ToolCall): Promise<string> {
    const { context, sessionID } = this.contextFor(call);
    const scope: Scope = isScopeValue(call.args["scope"]) ? (call.args["scope"] as Scope) : "project";
    const kind: MemoryKind = isMemoryKind(call.args["kind"]) ? (call.args["kind"] as MemoryKind) : "learned-pattern";
    const redactEnabled = this.hub.config.redactPrivate;

    const fact = safeText(String(call.args["fact"] ?? "").trim(), redactEnabled);
    const subject = safeText(String(call.args["subject"] ?? "").trim(), redactEnabled);
    const reason = safeText(String(call.args["reason"] ?? "").trim(), redactEnabled);
    const citations = parseCitations(call.args["citations"]);

    if (!fact) return "Nothing stored: `fact` was empty after redaction.";
    if (citations.length === 0 && scope !== "session") {
      const lines = [
        "Nothing stored: at least one citation is required for global and project scope.",
        'Re-run with the file and line that prove the fact, e.g. citations: ["src/build.ts:18"].',
        "Session scope may be stored without citations.",
      ];
      if (mentionsDotenv(call.args["citations"])) {
        lines.push("Note: dotenv paths (.env) cannot be cited; cite the code that reads the value instead.");
      }
      return lines.join("\n");
    }

    const store = this.storeFor(context, scope, sessionID);
    const record = store.add({ subject, fact, citations, reason, kind });

    context.injector.invalidate();
    context.injector.noteSave();

    const check =
      scope === "session"
        ? "working note (not verified; discarded with the session)"
        : describeVerification(verifyRecord(record, context.worktree));

    return [
      `Stored [${record.id}] in ${scope} scope (${kind}).`,
      `  subject: ${record.subject}`,
      `  cites: ${record.citations.map(formatCitation).join(", ") || "none"}`,
      `  check: ${check}`,
      `  expires: unused entries are dropped after ${this.hub.config.expiryDays} days.`,
    ].join("\n");
  }

  private async search(call: ToolCall): Promise<string> {
    const { context, sessionID } = this.contextFor(call);
    const query = String(call.args["query"] ?? "");
    const scopes = this.scopesFrom(call.args["scope"], ["project", "global", "session"]);
    const limit = clamp(call.args["limit"], 10, 1, 50);

    const out: string[] = [];
    const scopeNote = describeScopeFallback(call.args["scope"], scopes);
    if (scopeNote) out.push(scopeNote);
    for (const scope of scopes) {
      const store = resolveScopeStore(context, scope, sessionID, this.hub.config);
      if (!store) continue;
      const hits = store.search(query, { limit });
      if (hits.length === 0) continue;
      out.push(`## ${scope} (${hits.length})`);
      for (const record of hits) out.push(this.describe(record));
      out.push("");
    }
    return out.length === 0 ? `No match for "${truncateChars(query, 120)}".` : out.join("\n").trim();
  }

  private async list(call: ToolCall): Promise<string> {
    const { context, sessionID } = this.contextFor(call);
    const scopes = this.scopesFrom(call.args["scope"], ["project", "global", "session"]);
    const limit = clamp(call.args["limit"], 20, 1, 200);
    const kind = isMemoryKind(call.args["kind"]) ? (call.args["kind"] as MemoryKind) : undefined;
    const includeReview = call.args["includeReview"] === true;

    const out: string[] = [];
    const scopeNote = describeScopeFallback(call.args["scope"], scopes);
    if (scopeNote) out.push(scopeNote);
    let total = 0;
    for (const scope of scopes) {
      const store = resolveScopeStore(context, scope, sessionID, this.hub.config);
      if (!store) continue;
      const records = store.list({ limit, includeReview, ...(kind ? { kind } : {}) });
      total += records.length;
      out.push(`## ${scope} scope — ${records.length} entr${records.length === 1 ? "y" : "ies"}`);
      for (const record of records) {
        const flag = record.needsReview ? " [needs review: cited code is gone]" : "";
        const validated = record.lastValidatedAt
          ? `validated ${new Date(record.lastValidatedAt).toISOString().slice(0, 10)}`
          : "never validated";
        out.push(`- ${this.describe(record)}  (${validated}, uses ${record.useCount})${flag}`);
      }
      out.push("");
    }
    if (total === 0) {
      const prefix = scopeNote ? `${scopeNote}\n` : "";
      return `${prefix}No memory stored (scopes: ${scopes.join(", ")}). Record one with memory_add.`;
    }
    return out.join("\n").trim();
  }

  private async forget(call: ToolCall): Promise<string> {
    const { context, sessionID } = this.contextFor(call);
    const scope: Scope = isScopeValue(call.args["scope"]) ? (call.args["scope"] as Scope) : "project";
    const store = this.storeFor(context, scope, sessionID);

    if (call.args["all"] === true) {
      const removed = store.forgetAll();
      context.injector.invalidate();
      return `Cleared ${removed} memor${removed === 1 ? "y" : "ies"} from ${scope} scope.`;
    }

    const memoryId = typeof call.args["memoryId"] === "string" ? call.args["memoryId"] : undefined;
    if (!memoryId) {
      return `Nothing deleted: pass memoryId, or all=true to clear the ${scope} scope. Valid scopes: ${SCOPE_LIST}.`;
    }

    const removed = store.forget(memoryId);
    context.injector.invalidate();
    return removed
      ? `Deleted [${memoryId}] from ${scope} scope.`
      : `No memory [${memoryId}] in ${scope} scope. Use memory_list to see valid ids.`;
  }

  private async profile(call: ToolCall): Promise<string> {
    const { context } = this.contextFor(call);
    const store = context.global;
    const query = typeof call.args["query"] === "string" ? call.args["query"] : "";
    const records = query
      ? store.search(query, { limit: 25, kind: "preference" })
      : store.list({ limit: 50, kind: "preference" });

    if (records.length === 0) {
      return "No user preferences stored yet. Record one with memory_add (scope: global, kind: preference).";
    }
    return [
      `User preferences (${records.length}, applies to every project):`,
      ...records.map((record) => `- ${truncateChars(record.fact, 300)}`),
    ].join("\n");
  }

  /**
   * Lists, then optionally adopts, memories stored under a different project
   * identity in this same directory.
   *
   * Read-only when listing. Adopting is deliberate and two-step: the agent is
   * expected to show the candidate first and only move rows once the identity
   * has been named, because merging two projects' knowledge is not something to
   * do speculatively.
   */
  private async rebind(call: ToolCall): Promise<string> {
    const { context } = this.contextFor(call);
    const store = context.project;
    const fromRepoId = typeof call.args["fromRepoId"] === "string" ? call.args["fromRepoId"].trim() : "";

    const candidates = store.foreignIdentities();

    if (!fromRepoId) {
      if (candidates.length === 0) {
        return [
          `Nothing to rebind. This project is ${context.scopes.repoKey} (id ${context.scopes.repoId})`,
          `and holds ${store.count()} memory/ies; no memories from other identities are present.`,
        ].join("\n");
      }
      return [
        `${store.count()} memory/ies are visible for this project, and ${candidates.length} other identity/identities`,
        "also hold memories in the same store. These are almost certainly this repository",
        "before it moved or changed its origin remote.",
        "",
        `- current: ${context.scopes.repoKey} (id ${context.scopes.repoId}, derived from ${context.scopes.remote ?? context.scopes.identity})`,
        ...candidates.map(
          (candidate) =>
            `- candidate: ${candidate.repoKey} (id ${candidate.repoId}) holding ${candidate.count} memory/ies`,
        ),
        "",
        "To adopt one, call memory_rebind again with fromRepoId set to that id and dryRun false.",
      ].join("\n");
    }

    const candidate = candidates.find((entry) => entry.repoId === fromRepoId || entry.repoKey === fromRepoId);
    if (!candidate) {
      return [
        `No memories found under identity "${fromRepoId}".`,
        candidates.length === 0
          ? "This store currently holds no foreign identities."
          : `Known candidates: ${candidates.map((entry) => entry.repoId).join(", ")}`,
      ].join("\n");
    }

    const dryRun = call.args["dryRun"] !== false;
    if (dryRun) {
      return [
        `Would move ${candidate.count} memory/ies from ${candidate.repoKey} (${candidate.repoId})`,
        `to ${context.scopes.repoKey} (${context.scopes.repoId}).`,
        "Re-run with dryRun: false to apply.",
      ].join("\n");
    }

    const moved = store.rebind(candidate.repoId);
    context.injector.invalidate();
    this.hub.resetDiagnostics(context.worktree);
    return `Adopted ${moved} memory/ies into ${context.scopes.repoKey}. They will be verified against your code before use.`;
  }
}

function isScopeValue(value: unknown): boolean {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

/** Names an unknown scope that fell back to the defaults, so typos stay visible. */
function describeScopeFallback(raw: unknown, resolved: Scope[]): string | undefined {
  if (!raw || raw === "all" || isScopeValue(raw)) return undefined;
  return `Unknown scope "${String(raw)}"; showing ${resolved.join(" + ")} instead.`;
}

/** True when the caller tried to cite a dotenv path, which is always rejected. */
function mentionsDotenv(raw: unknown): boolean {
  const values = Array.isArray(raw) ? raw : [raw];
  return values.some((value) => typeof value === "string" && /(^|\/)\.env(\.|$|\/)/i.test(value));
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export { TOOL_SPECS };
