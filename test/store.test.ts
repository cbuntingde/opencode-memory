import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryStore, parseMarkdown, renderMarkdown } from "../src/store.ts";
import { silentLogger } from "../src/logger.ts";
import { DAY_MS } from "../src/types.ts";

const roots: string[] = [];
const openStores: MemoryStore[] = [];

function makeWorkspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mem-store-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return root;
}

function makeStore(root: string, overrides: Partial<ConstructorParameters<typeof MemoryStore>[0]> = {}): MemoryStore {
  const store = new MemoryStore({
    dir: join(root, "memory"),
    scope: "project",
    repoKey: "repo_test__abc123",
    expiryDays: 28,
    maxMemoriesPerScope: 500,
    logger: silentLogger,
    ...overrides,
  });
  openStores.push(store);
  return store;
}

afterAll(() => {
  // SQLite keeps a file handle open, which blocks removal on Windows.
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("MemoryStore CRUD", () => {
  test("add persists a full record", () => {
    const root = makeWorkspace();
    const store = makeStore(root);
    const record = store.add({
      subject: "Build command",
      fact: "Build with bun run build",
      citations: ["package.json:8"],
      reason: "Faster than npm",
      kind: "project-config",
    });

    expect(record.id).toStartWith("m_");
    expect(record.citations).toEqual([{ path: "package.json", line: 8 }]);
    expect(record.useCount).toBe(0);
    expect(record.lastValidatedAt).toBeNull();
    expect(record.needsReview).toBe(false);
    expect(store.count()).toBe(1);
    expect(store.get(record.id)?.fact).toBe("Build with bun run build");
  });

  test("search ranks by keyword overlap, not insertion order", () => {
    const root = makeWorkspace();
    const store = makeStore(root);
    store.add({ subject: "Logging", fact: "Use winston with a timestamp format", citations: ["a.ts"] });
    store.add({ subject: "Build", fact: "Run bun run build for production bundles", citations: ["b.ts"] });
    store.add({ subject: "Tests", fact: "Vitest is the test runner", citations: ["c.ts"] });

    const hits = store.search("build bundle production");
    expect(hits[0]?.subject).toBe("Build");
    expect(store.search("nonexistentterm")).toEqual([]);
    expect(store.search("").length).toBe(3);
  });

  test("list honours limit and kind filters", () => {
    const root = makeWorkspace();
    const store = makeStore(root);
    store.add({ subject: "a", fact: "fact a", citations: ["a.ts"], kind: "preference" });
    store.add({ subject: "b", fact: "fact b", citations: ["b.ts"], kind: "architecture" });
    store.add({ subject: "c", fact: "fact c", citations: ["c.ts"], kind: "architecture" });

    expect(store.list({ limit: 2 }).length).toBe(2);
    expect(store.list({ kind: "architecture" }).length).toBe(2);
    expect(store.list({ kind: "preference" }).length).toBe(1);
  });

  test("forget removes one entry and forgetAll clears the scope", () => {
    const root = makeWorkspace();
    const store = makeStore(root);
    const a = store.add({ subject: "a", fact: "fa", citations: ["a.ts"] });
    store.add({ subject: "b", fact: "fb", citations: ["b.ts"] });

    expect(store.forget(a.id)).toBe(true);
    expect(store.forget(a.id)).toBe(false);
    expect(store.count()).toBe(1);
    expect(store.forgetAll()).toBe(1);
    expect(store.count()).toBe(0);
  });

  test("touch records a verified use and extends expiry", () => {
    const root = makeWorkspace();
    let clock = 1_000_000;
    const store = makeStore(root, { now: () => clock });
    const record = store.add({ subject: "a", fact: "fa", citations: ["a.ts"] });

    clock += 60_000;
    const updated = store.touch(record.id, true);
    expect(updated?.useCount).toBe(1);
    expect(updated?.lastValidatedAt).toBe(clock);
    expect(updated?.expiresAt).toBe(clock + 28 * DAY_MS);

    store.setNeedsReview(record.id, true);
    expect(store.get(record.id)?.needsReview).toBe(true);
    expect(store.list().length).toBe(0);
    expect(store.list({ includeReview: true }).length).toBe(1);
  });

  test("a rename that keeps the hash keeps memories reachable", () => {
    const root = makeWorkspace();
    // Same identity hash, different display name: the slug rules changed.
    const before = makeStore(root, { repoKey: "repo_old-name__deadbeef1234", repoId: "deadbeef1234" });
    before.add({ subject: "old", fact: "written before the rename", citations: ["a.ts"] });

    const after = makeStore(root, { repoKey: "repo_new-name__deadbeef1234", repoId: "deadbeef1234" });
    expect(after.count()).toBe(1);
    expect(after.foreignIdentities()).toEqual([]);
  });

  test("a genuinely different identity is reported and can be adopted", () => {
    const root = makeWorkspace();
    const before = makeStore(root, { repoKey: "repo_old-name__deadbeef1234", repoId: "deadbeef1234" });
    before.add({ subject: "old", fact: "written under the previous identity", citations: ["a.ts"] });

    const after = makeStore(root, { repoKey: "repo_new-name__cafebabe1234", repoId: "cafebabe1234" });
    expect(after.count()).toBe(0);
    expect(after.foreignIdentities()).toEqual([
      { repoId: "deadbeef1234", repoKey: "repo_old-name__deadbeef1234", count: 1 },
    ]);

    expect(after.rebind("deadbeef1234", { dryRun: true })).toBe(1);
    expect(after.count()).toBe(0);

    expect(after.rebind("deadbeef1234")).toBe(1);
    expect(after.count()).toBe(1);
    expect(after.foreignIdentities()).toEqual([]);
    expect(after.rebind("cafebabe1234")).toBe(0);
  });

  test("legacy rows written before repo_id existed are backfilled", () => {
    const root = makeWorkspace();
    const legacy = makeStore(root, { repoKey: "repo_legacy__aaaabbbbcccc" });
    legacy.add({ subject: "legacy", fact: "written before repo_id existed", citations: ["a.ts"] });

    // Simulate a pre-upgrade row: no repo_id value at all.
    const db = new Database(legacy.indexPath);
    db.run("UPDATE memories SET repo_id = ''");
    db.close();

    const upgraded = makeStore(root, { repoKey: "repo_renamed__aaaabbbbcccc", repoId: "aaaabbbbcccc" });
    expect(upgraded.count()).toBe(1);
    expect(upgraded.list()[0]?.repoId).toBe("aaaabbbbcccc");
  });

  test("creating a fresh store does not log a backfill failure", () => {
    const warnings: string[] = [];
    const root = makeWorkspace();
    const store = makeStore(root, {
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message) => {
          warnings.push(message);
        },
        error: () => {},
      },
    });

    // The index does not exist yet, so opening it must not report the absent
    // `memories` table as a failed backfill.
    store.add({ subject: "fresh", fact: "first write on a new store", citations: ["a.ts"] });

    expect(warnings).toEqual([]);
    expect(store.count()).toBe(1);
  });

  test("legacy index without repo_id upgrades without warnings", () => {
    const warnings: string[] = [];
    const root = makeWorkspace();
    const dir = join(root, "memory");
    mkdirSync(dir, { recursive: true });

    // A pre-upgrade index: the table exists, but the column does not.
    const db = new Database(join(dir, "index.db"), { create: true });
    db.run(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, repo_key TEXT NOT NULL,
      subject TEXT NOT NULL, fact TEXT NOT NULL, citations TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'learned-pattern',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_validated_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL, needs_review INTEGER NOT NULL DEFAULT 0)`);
    db.run(
      `INSERT INTO memories (id, scope, repo_key, subject, fact, citations, created_at, updated_at, expires_at)
       VALUES ('legacy-1','project','repo_test__abc123','legacy','old fact','["a.ts"]',1,1,9999999999999)`,
    );
    db.close();

    const store = makeStore(root, {
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message) => {
          warnings.push(message);
        },
        error: () => {},
      },
    });

    expect(warnings).toEqual([]);
    expect(store.count()).toBe(1);
  });

  test("enforces the per-scope cap by dropping least-used records", () => {
    const root = makeWorkspace();
    const store = makeStore(root, { maxMemoriesPerScope: 10 });
    const ids = Array.from({ length: 14 }, (_, i) => store.add({ subject: `s${i}`, fact: `f${i}`, citations: ["a.ts"] }).id);
    expect(store.count()).toBe(10);
    expect(store.get(ids[0] as string)).toBeNull();
    expect(store.get(ids[13] as string)).not.toBeNull();
  });
});

describe("retention", () => {
  test("unused memories expire, used memories survive", () => {
    const root = makeWorkspace();
    let clock = 5_000_000;
    const store = makeStore(root, { now: () => clock });

    const untouched = store.add({ subject: "stale", fact: "old fact", citations: ["a.ts"] });
    const used = store.add({ subject: "used", fact: "kept alive", citations: ["b.ts"] });

    clock += 10_000;
    store.touch(used.id, true);

    clock += 29 * DAY_MS;
    const removed = store.sweepExpired();

    expect(removed).toBe(1);
    expect(store.get(untouched.id)).toBeNull();
    expect(store.get(used.id)).not.toBeNull();
  });

  test("sweep is a no-op when nothing has expired", () => {
    const root = makeWorkspace();
    const store = makeStore(root);
    store.add({ subject: "fresh", fact: "new fact", citations: ["a.ts"] });
    expect(store.sweepExpired()).toBe(0);
    expect(store.count()).toBe(1);
  });
});

describe("markdown mirror", () => {
  test("is written on every mutation and mirrors the database", () => {
    const root = makeWorkspace();
    const store = makeStore(root);
    const record = store.add({
      subject: "API version sync",
      fact: "Version must match client, server, docs",
      citations: ["src/client.ts:12", "server/api.go:8"],
      reason: "Mismatch breaks integration",
      kind: "architecture",
    });

    const markdown = readFileSync(store.markdownPath, "utf8");
    expect(markdown).toContain(`[${record.id}]`);
    expect(markdown).toContain("Version must match client, server, docs");
    expect(markdown).toContain("src/client.ts:12, server/api.go:8");
    expect(markdown).toContain("architecture");

    store.forget(record.id);
    expect(readFileSync(store.markdownPath, "utf8")).not.toContain(record.id);
  });

  test("parses back into equivalent records", () => {
    const root = makeWorkspace();
    const store = makeStore(root);
    const record = store.add({
      subject: "Logging convention",
      fact: "Log file names follow app-YYYYMMDD.log",
      citations: ["src/log.ts:4"],
      reason: "Ops scripts parse these names",
      kind: "learned-pattern",
    });
    store.touch(record.id, true);

    const parsed = parseMarkdown(readFileSync(store.markdownPath, "utf8"));
    expect(parsed.length).toBe(1);
    const only = parsed[0]!;
    expect(only.id).toBe(record.id);
    expect(only.subject).toBe("Logging convention");
    expect(only.citations).toEqual([{ path: "src/log.ts", line: 4 }]);
    expect(only.kind).toBe("learned-pattern");
    expect(only.useCount).toBe(1);
  });

  test("rebuilds a store from Markdown when the database is lost", () => {
    const root = makeWorkspace({ "src/log.ts": "x" });
    const first = makeStore(root);
    const record = first.add({
      subject: "Recovered fact",
      fact: "This survived a lost database",
      citations: ["src/log.ts:1"],
      kind: "architecture",
    });
    first.close();

    // Simulate corruption: remove the index and reopen.
    rmSync(first.indexPath, { force: true });
    const rebuilt = makeStore(root);
    expect(rebuilt.get(record.id)).not.toBeNull();
    expect(rebuilt.get(record.id)?.fact).toBe("This survived a lost database");
  });

  test("renames a corrupt database instead of throwing", () => {
    const root = makeWorkspace();
    const store = makeStore(root);
    store.add({ subject: "a", fact: "fa", citations: ["a.ts"] });
    store.close();

    writeFileSync(store.indexPath, "this is not a sqlite database", "utf8");

    const reopened = makeStore(root);
    expect(reopened.count()).toBe(1);
    const leftovers = readdirSync(join(root, "memory")).filter((name) => name.includes(".corrupt-"));
    expect(leftovers.length).toBe(1);
  });

  test("renders an empty store without crashing", () => {
    const rendered = renderMarkdown([], "global", "user");
    expect(rendered).toContain("# Memory (global)");
    expect(rendered).toContain("No memories stored yet");
  });
});
