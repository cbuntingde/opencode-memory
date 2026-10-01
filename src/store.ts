import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { citationKey, formatCitation, parseCitations } from "./citation.ts";
import { hashFromProjectKey } from "./scopes.ts";
import { tokenize } from "./text.ts";
import {
  DAY_MS,
  SCOPES,
  type Citation,
  type Logger,
  type MemoryKind,
  type MemoryRecord,
  type Scope,
} from "./types.ts";

/**
 * Persistence for one scope.
 *
 * SQLite is the query surface; a Markdown file is regenerated after each write so
 * a human can read, diff and hand-edit what the agent believes. If the database
 * is ever unreadable the Markdown mirror is used to rebuild it, which means the
 * two files must always agree - that invariant is covered by tests.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  repo_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  fact TEXT NOT NULL,
  citations TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'learned-pattern',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_validated_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scope_repo ON memories(scope, repo_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_scope_repo_id ON memories(scope, repo_id, updated_at DESC);
`;

const INSERT_SQL = `INSERT OR REPLACE INTO memories
  (id, scope, repo_key, repo_id, subject, fact, citations, reason, kind,
   created_at, updated_at, last_validated_at, use_count, expires_at, needs_review)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

interface Row {
  id: string;
  scope: string;
  repo_key: string;
  repo_id: string;
  subject: string;
  fact: string;
  citations: string;
  reason: string;
  kind: string;
  created_at: number;
  updated_at: number;
  last_validated_at: number | null;
  use_count: number;
  expires_at: number;
  needs_review: number;
}

/*
 * bun:sqlite declares its binding parameters as `...bindings: ParamsType[]`,
 * which defeats inference for heterogeneous argument lists. These three helpers
 * spell the intended call shape once so every query below stays readable and
 * type-checked.
 */
type Bindings = SQLQueryBindings;
type StatementLike = {
  run(...params: Bindings[]): { changes: number };
  all(...params: Bindings[]): unknown[];
  get(...params: Bindings[]): unknown;
};

/** Executes a write against a prepared statement. */
function exec(statement: unknown, params: Bindings[] = []): number {
  return (statement as StatementLike).run(...params).changes;
}

/** Executes raw SQL that has no cached statement. */
function execSql(db: Database, sql: string, params: Bindings[] = []): number {
  return (db as unknown as { run(sql: string, ...params: Bindings[]): { changes: number } }).run(sql, ...params).changes;
}

function all<T>(statement: unknown, params: Bindings[] = []): T[] {
  return (statement as StatementLike).all(...params) as T[];
}

function get<T>(statement: unknown, params: Bindings[] = []): T | null {
  const value = (statement as StatementLike).get(...params);
  return (value ?? null) as T | null;
}

export interface StoreOptions {
  /** Directory that will hold index.db and the Markdown mirror. */
  dir: string;
  scope: Scope;
  /** Display identity, e.g. `repo_my-app__a1b2c3d4e5f6`. */
  repoKey: string;
  /** Stable identity used for lookups; derived from `repoKey` when omitted. */
  repoId?: string;
  expiryDays: number;
  maxMemoriesPerScope: number;
  logger?: Logger;
  /** Injectable clock so retention behaviour is testable. */
  now?: () => number;
  /** Injectable id generator so fixtures are deterministic. */
  generateId?: () => string;
}

export interface AddMemoryInput {
  subject: string;
  fact: string;
  citations: unknown;
  reason?: string;
  kind?: MemoryKind;
  id?: string;
  createdAt?: number;
}

export interface ListOptions {
  limit?: number;
  kind?: MemoryKind;
  includeReview?: boolean;
}

export interface SearchOptions extends ListOptions {
  /** Rows considered before ranking; keeps search bounded on large stores. */
  candidateLimit?: number;
}

export interface MemoryHubStats {
  global: number;
  project: number;
  session: number;
}

export function markdownFilename(scope: Scope): string {
  return scope === "global" ? "global.md" : "project.md";
}

export function generateMemoryId(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `m_${stamp}${rand}`;
}

export class MemoryStore {
  private db: Database | null = null;
  private readonly dir: string;
  private readonly scope: Scope;
  private readonly repoKey: string;
  private readonly repoId: string;
  private readonly expiryDays: number;
  private readonly maxMemories: number;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  private readonly generateId: () => string;
  /** Bumped on every mutation so consumers can invalidate caches. */
  revision = 0;

  constructor(options: StoreOptions) {
    this.dir = options.dir;
    this.scope = options.scope;
    this.repoKey = options.repoKey;
    this.repoId = options.repoId ?? hashFromProjectKey(options.repoKey);
    this.expiryDays = options.expiryDays;
    this.maxMemories = options.maxMemoriesPerScope;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? generateMemoryId;
  }

  get scopeName(): Scope {
    return this.scope;
  }

  get repo(): string {
    return this.repoKey;
  }

  get identity(): string {
    return this.repoId;
  }

  /**
   * Identity match used by every read and write.
   *
   * New rows match on `repo_id`. Rows from before that column existed carry an
   * empty value and fall back to `repo_key`, so an upgrade never hides data.
   */
  private get identityClause(): string {
    return "(repo_id = ? OR (repo_id = '' AND repo_key = ?))";
  }

  private get identityParams(): string[] {
    return [this.repoId, this.repoKey];
  }

  get indexPath(): string {
    return join(this.dir, "index.db");
  }

  get markdownPath(): string {
    return join(this.dir, markdownFilename(this.scope));
  }

  private connect(): Database {
    if (this.db) return this.db;

    mkdirSync(this.dir, { recursive: true });

    // Remembered before opening: a database that did not exist yet but has a
    // Markdown mirror means the index was deleted, not that the store is empty.
    const existed = existsSync(this.indexPath);

    let attempt: Database | null = null;
    try {
      attempt = new Database(this.indexPath, { create: true });
      this.migrate(attempt);
      execSql(attempt, SCHEMA);
      this.db = attempt;
      if (!existed && existsSync(this.markdownPath)) {
        this.rebuildFromMarkdown();
      }
      return attempt;
    } catch (error) {
      // The handle must be released before the damaged file can be moved aside;
      // leaving it open makes the rename below fail on Windows.
      try {
        attempt?.close();
      } catch {
        /* already unusable */
      }
      this.logger?.warn("index.db unreadable; attempting rebuild from Markdown", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.quarantineIndex();

    const db = new Database(this.indexPath, { create: true });
    this.migrate(db);
    execSql(db, SCHEMA);
    this.db = db;
    try {
      this.rebuildFromMarkdown();
    } catch (error) {
      this.logger?.warn("Markdown rebuild failed; starting with an empty store", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return db;
  }

  /**
   * Brings an older index up to the current shape.
   *
   * `repo_id` was added after the first release. Rows written before it carry
   * only the display key, so their stable hash is backfilled from it - that alone
   * rescues memories after a repository rename or a slug-rule change, which used
   * to make an entire store silently unreachable.
   */
  private migrate(db: Database): void {
    try {
      execSql(db, `ALTER TABLE memories ADD COLUMN repo_id TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already present on a current index.
    }
    try {
      const rows = all<{ id: string; repo_key: string }>(
        db.query(`SELECT id, repo_key FROM memories WHERE repo_id = '' OR repo_id IS NULL`),
      );
      if (rows.length === 0) return;
      const update = db.query(`UPDATE memories SET repo_id = ? WHERE id = ?`);
      for (const row of rows) exec(update, [hashFromProjectKey(row.repo_key), row.id]);
      this.logger?.info("backfilled stable project identity", { rows: rows.length });
    } catch (error) {
      this.logger?.warn("identity backfill failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Moves a damaged index aside, falling back to deletion when it is locked. */
  private quarantineIndex(): void {
    if (!existsSync(this.indexPath)) return;
    try {
      renameSync(this.indexPath, `${this.indexPath}.corrupt-${this.now()}`);
    } catch {
      try {
        rmSync(this.indexPath, { force: true });
      } catch (error) {
        this.logger?.warn("could not quarantine damaged index.db", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  add(input: AddMemoryInput): MemoryRecord {
    const now = this.now();
    const citations = parseCitations(input.citations);
    const subject = input.subject.trim() || input.fact.trim().slice(0, 60) || "memory";
    const record: MemoryRecord = {
      id: input.id ?? this.generateId(),
      scope: this.scope,
      repoKey: this.repoKey,
      repoId: this.repoId,
      subject,
      fact: input.fact.trim(),
      citations,
      reason: (input.reason ?? "").trim(),
      kind: input.kind ?? "learned-pattern",
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      lastValidatedAt: null,
      useCount: 0,
      expiresAt: now + this.expiryDays * DAY_MS,
      needsReview: false,
    };

    const db = this.connect();
    execSql(db, INSERT_SQL, [
      record.id,
      record.scope,
      record.repoKey,
      record.repoId,
      record.subject,
      record.fact,
      JSON.stringify(record.citations),
      record.reason,
      record.kind,
      record.createdAt,
      record.updatedAt,
      record.lastValidatedAt,
      record.useCount,
      record.expiresAt,
      record.needsReview ? 1 : 0,
    ]);

    this.revision += 1;
    this.trim();
    this.writeMarkdown();
    return record;
  }

  get(id: string): MemoryRecord | null {
    const row = get<Row>(this.connect().query(`SELECT * FROM memories WHERE id = ?`), [id]);
    return row ? fromRow(row) : null;
  }

  list(options: ListOptions = {}): MemoryRecord[] {
    const clauses = ["scope = ?", this.identityClause];
    const params: Array<string | number> = [this.scope, ...this.identityParams];

    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (!options.includeReview) {
      clauses.push("needs_review = 0");
    }

    const limit = clampLimit(options.limit ?? 100);
    params.push(limit);

    const rows = all<Row>(
      this.connect().query(`SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`),
      params,
    );
    return rows.map(fromRow);
  }

  /** Most recently updated, unflagged records: the session-start candidate set. */
  recent(limit: number): MemoryRecord[] {
    return this.list({ limit, includeReview: false });
  }

  /**
   * Keyword + recency ranking. Deliberately not semantic: a deterministic,
   * explainable score keeps results auditable, which matters more here than
   * fuzzy recall quality.
   */
  search(query: string, options: SearchOptions = {}): MemoryRecord[] {
    const tokens = tokenize(query);
    const candidateLimit = clampLimit(options.candidateLimit ?? 300);

    if (tokens.length === 0) return this.list(options);

    const rows = all<Row>(
      this.connect().query(
        `SELECT * FROM memories WHERE scope = ? AND ${this.identityClause} AND needs_review = 0
         ORDER BY updated_at DESC LIMIT ?`,
      ),
      [this.scope, ...this.identityParams, candidateLimit],
    );

    const tokenSet = new Set(tokens);
    const scored = rows.map((row) => {
      const record = fromRow(row);
      const haystack = new Set(tokenize(`${record.subject} ${record.fact} ${record.reason}`));
      let hits = 0;
      for (const token of tokenSet) {
        if (haystack.has(token)) hits += 1;
      }
      const score = hits / tokenSet.size;
      return { record, score };
    });

    return scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt)
      .slice(0, clampLimit(options.limit ?? 10))
      .map((entry) => entry.record);
  }

  forget(id: string): boolean {
    const changes = exec(this.connect().query(`DELETE FROM memories WHERE id = ? AND scope = ?`), [id, this.scope]);
    if (changes > 0) {
      this.revision += 1;
      this.writeMarkdown();
      return true;
    }
    return false;
  }

  /** Used by forgetAll and to make room under maxMemoriesPerScope. */
  private deleteIds(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    exec(this.connect().query(`DELETE FROM memories WHERE id IN (${placeholders}) AND scope = ?`), [...ids, this.scope]);
    this.revision += 1;
  }

  forgetAll(): number {
    const changes = exec(
      this.connect().query(`DELETE FROM memories WHERE scope = ? AND ${this.identityClause}`),
      [this.scope, ...this.identityParams],
    );
    if (changes > 0) {
      this.revision += 1;
      this.writeMarkdown();
    }
    return changes;
  }

  /** Records a verified use: bumps counters and pushes out the expiry date. */
  touch(id: string, validated: boolean): MemoryRecord | null {
    const now = this.now();
    const sql = validated
      ? `UPDATE memories SET use_count = use_count + 1, last_validated_at = ?, expires_at = ?, needs_review = 0
         WHERE id = ? AND scope = ?`
      : `UPDATE memories SET use_count = use_count + 1, expires_at = ?
         WHERE id = ? AND scope = ?`;
    const changes = validated
      ? exec(this.connect().query(sql), [now, now + this.expiryDays * DAY_MS, id, this.scope])
      : exec(this.connect().query(sql), [now + this.expiryDays * DAY_MS, id, this.scope]);
    if (changes > 0) {
      this.revision += 1;
      this.writeMarkdown();
      return this.get(id);
    }
    return null;
  }

  setNeedsReview(id: string, needsReview: boolean): void {
    const changes = exec(
      this.connect().query(`UPDATE memories SET needs_review = ? WHERE id = ? AND scope = ?`),
      [needsReview ? 1 : 0, id, this.scope],
    );
    if (changes > 0) this.revision += 1;
  }

  /** Drops unused records past their expiry. Verified/used records keep living. */
  sweepExpired(): number {
    const now = this.now();
    const changes = exec(
      this.connect().query(`DELETE FROM memories WHERE expires_at < ? AND use_count = 0 AND scope = ?`),
      [now, this.scope],
    );
    if (changes > 0) {
      this.revision += 1;
      this.writeMarkdown();
      this.logger?.debug("swept expired memories", { scope: this.scope, removed: changes });
    }
    return changes;
  }

  count(): number {
    const row = get<{ total: number }>(
      this.connect().query(`SELECT COUNT(*) AS total FROM memories WHERE scope = ? AND ${this.identityClause}`),
      [this.scope, ...this.identityParams],
    );
    return row?.total ?? 0;
  }

  /**
   * Identities present in this store that are not the current one.
   *
   * Non-empty while `count()` is zero means this project is reachable under a
   * different identity - typically the same repository moved to a new path on
   * this machine, or memories arriving from another machine before a sync. Those
   * rows are on disk but unreachable, so callers report them instead of showing
   * a mysteriously empty store, and `rebind` can adopt them.
   */
  foreignIdentities(): Array<{ repoId: string; repoKey: string; count: number }> {
    return all<{ repo_id: string; repo_key: string; total: number }>(
      this.connect().query(
        `SELECT repo_id, repo_key, COUNT(*) AS total FROM memories
         WHERE scope = ? AND NOT ${this.identityClause} GROUP BY repo_id, repo_key`,
      ),
      [this.scope, ...this.identityParams],
    ).map((row) => ({
      repoId: row.repo_id || hashFromProjectKey(row.repo_key),
      repoKey: row.repo_key,
      count: row.total,
    }));
  }

  /**
   * Reassigns every row from another identity in this store to the current one.
   *
   * This is the explicit escape hatch for the case `repo_id` cannot solve on its
   * own: a repository whose path or origin remote genuinely changed, where the
   * memories are the same knowledge but the identity is not.
   */
  rebind(fromRepoId: string, options: { dryRun?: boolean } = {}): number {
    if (fromRepoId === this.repoId) return 0;
    const rows = all<{ total: number }>(
      this.connect().query(
        `SELECT COUNT(*) AS total FROM memories WHERE scope = ? AND (repo_id = ? OR repo_key = ?)`,
      ),
      [this.scope, fromRepoId, fromRepoId],
    );
    const total = rows[0]?.total ?? 0;
    if (total === 0 || options.dryRun) return total;

    const changes = exec(
      this.connect().query(
        `UPDATE memories SET repo_id = ?, repo_key = ?, updated_at = MAX(updated_at, ?)
         WHERE scope = ? AND (repo_id = ? OR repo_key = ?)`,
      ),
      [this.repoId, this.repoKey, this.now(), this.scope, fromRepoId, fromRepoId],
    );
    if (changes > 0) {
      this.revision += 1;
      this.writeMarkdown();
      this.logger?.info("rebound memories to the current identity", { from: fromRepoId, moved: changes });
    }
    return changes;
  }

  /** Enforces the per-scope cap by dropping least recently used records. */
  private trim(): void {
    const rows = all<{ id: string }>(
      this.connect().query(
        `SELECT id FROM memories WHERE scope = ? AND repo_key = ?
         ORDER BY use_count ASC, updated_at ASC`,
      ),
      [this.scope, this.repoKey],
    );
    const excess = rows.length - this.maxMemories;
    if (excess > 0) {
      this.deleteIds(rows.slice(0, excess).map((row) => row.id));
    }
  }

  writeMarkdown(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.markdownPath, renderMarkdown(this.list({ limit: this.maxMemories, includeReview: true }), this.scope, this.repoKey, this.repoId), "utf8");
    } catch (error) {
      this.logger?.warn("failed to write Markdown mirror", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Restores records from the Markdown mirror. Parsing is tolerant: an
   * unreadable block is skipped rather than aborting the whole rebuild.
   */
  rebuildFromMarkdown(): number {
    if (!existsSync(this.markdownPath)) return 0;
    const raw = readFileSync(this.markdownPath, "utf8");
    const parsed = parseMarkdown(raw);
    if (parsed.length === 0) return 0;

    const db = this.connect();
    let restored = 0;
    for (const record of parsed) {
      // A hand-edited file may name a different project; trust the file only
      // when it agrees with this store, so copying a mirror between projects
      // cannot silently merge unrelated knowledge.
      const agreesWithStore = record.repoId === "" || record.repoId === this.repoId;
      execSql(db, INSERT_SQL, [
        record.id,
        this.scope,
        agreesWithStore ? this.repoKey : record.repoKey,
        agreesWithStore ? this.repoId : record.repoId,
        record.subject,
        record.fact,
        JSON.stringify(record.citations),
        record.reason,
        record.kind,
        record.createdAt,
        record.updatedAt,
        record.lastValidatedAt,
        record.useCount,
        record.expiresAt,
        record.needsReview ? 1 : 0,
      ]);
      restored += 1;
    }
    this.revision += 1;
    this.logger?.info("rebuilt store from Markdown mirror", { scope: this.scope, restored });
    return restored;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = null;
  }
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(10_000, Math.floor(value)));
}

function fromRow(row: Row): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope as Scope,
    repoKey: row.repo_key,
    repoId: row.repo_id || hashFromProjectKey(row.repo_key),
    subject: row.subject,
    fact: row.fact,
    citations: parseCitations(safeParse(row.citations)),
    reason: row.reason,
    kind: row.kind as MemoryKind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastValidatedAt: row.last_validated_at ?? null,
    useCount: row.use_count,
    expiresAt: row.expires_at,
    needsReview: row.needs_review === 1,
  };
}

function safeParse(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return [];
  }
}

export function renderMarkdown(records: MemoryRecord[], scope: Scope, repoKey: string, repoId?: string): string {
  const identity = repoId ?? hashFromProjectKey(repoKey);
  const header = [
    `# Memory (${scope})`,
    "",
    "> Generated by opencode-memory-local. Safe to edit by hand: this file is the",
    "> recovery source if index.db is ever lost. `- RepoId` is the stable project",
    "> identity; keep it when editing so memories survive a rename.",
    "",
    `Scope: \`${scope}\` · Repo: \`${repoKey}\` · RepoId: \`${identity}\` · Entries: ${records.length}`,
    "",
  ].join("\n");

  if (records.length === 0) return `${header}_No memories stored yet._\n`;

  const body = records
    .map((record) => {
      const citations = record.citations.map(formatCitation).join(", ") || "none";
      const date = (value: number | null): string => (value ? new Date(value).toISOString().slice(0, 10) : "unknown");
      return [
        `## [${record.id}] ${record.subject}`,
        `- Fact: ${record.fact}`,
        `- Citations: ${citations}`,
        `- Reason: ${record.reason || "-"}`,
        `- Kind: ${record.kind}`,
        `- Scope: ${record.scope}`,
        `- Repo: ${record.repoKey}`,
        `- RepoId: ${record.repoId || identity}`,
        `- Created: ${date(record.createdAt)}`,
        `- Updated: ${date(record.updatedAt)}`,
        `- Validated: ${date(record.lastValidatedAt)}`,
        `- Uses: ${record.useCount}`,
        `- NeedsReview: ${record.needsReview}`,
        "",
      ].join("\n");
    })
    .join("\n");

  return `${header}${body}`;
}

const KNOWN_KINDS: readonly MemoryKind[] = [
  "project-config",
  "architecture",
  "error-solution",
  "preference",
  "learned-pattern",
  "conversation",
];

const FIELD_LINE = /^-\s+([A-Za-z]+):\s*(.*)$/;

/**
 * Parses the mirror written by renderMarkdown back into records.
 *
 * Date-only fields lose sub-day precision, so a restored record keeps the day it
 * was written; counters and the needs-review flag round-trip exactly.
 */
export function parseMarkdown(raw: string, scope: Scope = "project", repoKey = "unknown"): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  const blocks = raw.split(/^## /m).slice(1);

  for (const block of blocks) {
    const lines = block.split("\n");
    const heading = lines[0] ?? "";
    const idMatch = /^\[([^\]]+)\]\s*(.*)$/.exec(heading.trim());
    if (!idMatch) continue;

    const id = idMatch[1] ?? "";
    if (!id.startsWith("m_")) continue;
    const subject = (idMatch[2] ?? "").trim();

    const fields = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const match = FIELD_LINE.exec(line.trim());
      if (match) fields.set((match[1] as string).toLowerCase(), (match[2] ?? "").trim());
    }

    const fact = fields.get("fact") ?? "";
    if (!fact) continue;

    const createdAt = Date.parse(fields.get("created") ?? "") || 0;
    const updatedAt = Date.parse(fields.get("updated") ?? "") || createdAt;
    const validatedRaw = (fields.get("validated") ?? "").trim();
    const validatedAt = validatedRaw && validatedRaw !== "unknown" ? Date.parse(validatedRaw) || null : null;
    const uses = Number.parseInt(fields.get("uses") ?? "0", 10) || 0;
    const kindRaw = (fields.get("kind") ?? "").trim();
    const kind = (KNOWN_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as MemoryKind) : "learned-pattern";
    const scopeRaw = fields.get("scope") ?? "";
    const reason = fields.get("reason") ?? "";

    records.push({
      id,
      scope: (SCOPES as readonly string[]).includes(scopeRaw) ? (scopeRaw as Scope) : scope,
      repoKey: fields.get("repo") ?? repoKey,
      repoId: fields.get("repid") || hashFromProjectKey(fields.get("repo") ?? repoKey),
      subject: subject || fact.slice(0, 60),
      fact,
      citations: parseCitations((fields.get("citations") ?? "").split(",").map((value) => value.trim())),
      reason: reason === "-" ? "" : reason,
      kind,
      createdAt,
      updatedAt,
      lastValidatedAt: validatedAt,
      useCount: uses,
      expiresAt: updatedAt + 28 * DAY_MS,
      needsReview: (fields.get("needsreview") ?? "").trim() === "true",
    });
  }

  return records;
}

export function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const citation of citations) {
    const key = citationKey(citation);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}
