import { parseCitations } from "./citation.ts";
import { tokenize } from "./text.ts";
import { DAY_MS, type MemoryKind, type MemoryRecord, type Scope } from "./types.ts";

/**
 * Conversation-lifetime scope.
 *
 * Working notes and plans belong to a session and must never leak into the next
 * one, so this store keeps everything in memory and disappears with the process.
 * It implements the same surface as the file-backed store, which lets the tools
 * and the injector treat all three scopes uniformly.
 */

export interface SessionStoreOptions {
  sessionID: string;
  expiryDays: number;
  maxMemoriesPerScope: number;
  now?: () => number;
  generateId?: () => string;
}

export class SessionStore {
  revision = 0;
  readonly scopeName: Scope = "session";

  private readonly records = new Map<string, MemoryRecord>();
  private readonly sessionID: string;
  private readonly expiryDays: number;
  private readonly maxMemories: number;
  private readonly now: () => number;
  private readonly generateId: () => string;

  constructor(options: SessionStoreOptions) {
    this.sessionID = options.sessionID;
    this.expiryDays = options.expiryDays;
    this.maxMemories = options.maxMemoriesPerScope;
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? (() => `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  }

  get repo(): string {
    return `session_${this.sessionID}`;
  }

  add(input: {
    subject: string;
    fact: string;
    citations: unknown;
    reason?: string;
    kind?: MemoryKind;
    id?: string;
  }): MemoryRecord {
    const now = this.now();
    const record: MemoryRecord = {
      id: input.id ?? this.generateId(),
      scope: "session",
      repoKey: this.repo,
      repoId: this.sessionID,
      subject: input.subject.trim() || input.fact.trim().slice(0, 60) || "note",
      fact: input.fact.trim(),
      citations: parseCitations(input.citations),
      reason: (input.reason ?? "").trim(),
      kind: input.kind ?? "conversation",
      createdAt: now,
      updatedAt: now,
      lastValidatedAt: null,
      useCount: 0,
      expiresAt: now + this.expiryDays * DAY_MS,
      needsReview: false,
    };
    this.records.set(record.id, record);
    this.revision += 1;
    this.trim();
    return record;
  }

  get(id: string): MemoryRecord | null {
    return this.records.get(id) ?? null;
  }

  list(options: { limit?: number; kind?: MemoryKind; includeReview?: boolean } = {}): MemoryRecord[] {
    let out = [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (options.kind) out = out.filter((record) => record.kind === options.kind);
    if (!options.includeReview) out = out.filter((record) => !record.needsReview);
    return out.slice(0, Math.max(1, Math.min(10_000, options.limit ?? 100)));
  }

  recent(limit: number): MemoryRecord[] {
    return this.list({ limit, includeReview: false });
  }

  /** Flagged rows, oldest first, so the injector can re-check them. */
  review(limit: number): MemoryRecord[] {
    return [...this.records.values()]
      .filter((record) => record.needsReview)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, Math.max(1, limit));
  }

  search(query: string, options: { limit?: number; kind?: MemoryKind } = {}): MemoryRecord[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return this.list(options);
    const tokenSet = new Set(tokens);

    return this.list({ ...options, includeReview: false })
      .map((record) => {
        const haystack = new Set(tokenize(`${record.subject} ${record.fact} ${record.reason}`));
        let hits = 0;
        for (const token of tokenSet) if (haystack.has(token)) hits += 1;
        return { record, score: hits / tokenSet.size };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt)
      .slice(0, Math.max(1, options.limit ?? 10))
      .map((entry) => entry.record);
  }

  forget(id: string): boolean {
    const removed = this.records.delete(id);
    if (removed) this.revision += 1;
    return removed;
  }

  forgetAll(): number {
    const count = this.records.size;
    this.records.clear();
    if (count > 0) this.revision += 1;
    return count;
  }

  touch(id: string, validated: boolean): MemoryRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    const now = this.now();
    record.useCount += 1;
    record.expiresAt = now + this.expiryDays * DAY_MS;
    if (validated) record.lastValidatedAt = now;
    this.revision += 1;
    return record;
  }

  setNeedsReview(id: string, needsReview: boolean): void {
    const record = this.records.get(id);
    if (!record) return;
    record.needsReview = needsReview;
    this.revision += 1;
  }

  count(): number {
    return this.records.size;
  }

  /** Session scope has exactly one identity, so nothing can ever be foreign. */
  foreignIdentities(): Array<{ repoId: string; repoKey: string; count: number }> {
    return [];
  }

  /** No-op: a session store is never shared across identities. */
  rebind(): number {
    return 0;
  }

  /** Session memories never outlive the session, so sweeping only drops overflow. */
  sweepExpired(): number {
    return 0;
  }

  close(): void {
    this.records.clear();
  }

  private trim(): void {
    const excess = this.records.size - this.maxMemories;
    if (excess <= 0) return;
    const oldest = [...this.records.values()]
      .sort((a, b) => a.useCount - b.useCount || a.updatedAt - b.updatedAt)
      .slice(0, excess);
    for (const record of oldest) this.records.delete(record.id);
  }
}
