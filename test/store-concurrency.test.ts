import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/store.ts";
import { silentLogger } from "../src/logger.ts";

/**
 * Regression coverage for index contention.
 *
 * Several OpenCode processes share one global index, so two of them writing at
 * once is routine. That case used to be handled as if it were corruption: the
 * schema was applied as one multi-statement script, which made bun:sqlite
 * report a blocked write as `no such table: main.memories`, and that error
 * triggered a quarantine that renamed a perfectly healthy index aside. These
 * tests pin the corrected behaviour - wait for the writer, never destroy data.
 */

const roots: string[] = [];
const openStores: MemoryStore[] = [];

function makeStore(dir: string): MemoryStore {
  const store = new MemoryStore({
    dir,
    scope: "project",
    repoKey: "repo_test__abc123",
    expiryDays: 28,
    maxMemoriesPerScope: 500,
    logger: silentLogger,
  });
  openStores.push(store);
  return store;
}

function corruptFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes("corrupt"));
}

afterAll(() => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("index contention", () => {
  test("a competing writer holding the index briefly does not stop the write", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mem-busy-")), "memory");
    roots.push(join(dir, ".."));
    const first = makeStore(dir);
    first.add({ subject: "before", fact: "written before contention", citations: ["a.ts:1"] });
    const indexPath = first.indexPath;

    // A real second process: it takes the write lock, announces that it has it,
    // holds briefly, then commits. The store under test must wait it out.
    const readyPath = join(dir, "lock-ready");
    const holder = Bun.spawn(
      [
        "bun",
        "-e",
        `
        import { Database } from "bun:sqlite";
        import { writeFileSync } from "node:fs";
        const db = new Database(${JSON.stringify(indexPath)});
        db.exec("BEGIN IMMEDIATE");
        db.run("UPDATE memories SET updated_at = updated_at WHERE id = 'lock-holder'");
        writeFileSync(${JSON.stringify(readyPath)}, "ready");
        await Bun.sleep(400);
        db.exec("COMMIT");
        db.close();
        `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      const deadline = Date.now() + 5_000;
      while (!readdirSync(dir).includes("lock-ready")) {
        if (Date.now() > deadline) throw new Error("lock holder never acquired the write lock");
        await Bun.sleep(10);
      }

      const second = makeStore(dir);
      const record = second.add({
        subject: "during",
        fact: "written while another process held the index",
        citations: ["a.ts:1"],
      });
      expect(record.id).toBeString();
      expect(corruptFiles(dir)).toEqual([]);
    } finally {
      await holder.exited;
    }
  });

  test("contention fails loudly instead of quarantining a healthy index", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mem-busy2-")), "memory");
    roots.push(join(dir, ".."));
    const first = makeStore(dir);
    first.add({ subject: "survivor", fact: "this row must survive the failed write", citations: ["a.ts:1"] });

    // Hold the write lock on a separate connection for the whole retry budget.
    const blocker = new Database(first.indexPath);
    blocker.exec("BEGIN IMMEDIATE");
    blocker.run("UPDATE memories SET updated_at = updated_at WHERE id = 'blocker'");

    try {
      const second = makeStore(dir);
      // A loud failure is acceptable and correct here; silent data loss is not.
      let thrown: unknown = null;
      try {
        second.add({ subject: "blocked", fact: "cannot be written while locked", citations: ["a.ts:1"] });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).not.toBeNull();
    } finally {
      blocker.exec("COMMIT");
      blocker.close();
    }

    // The original index is intact: no quarantine, and the earlier row is there.
    expect(corruptFiles(dir)).toEqual([]);
    const survivor = makeStore(dir);
    expect(survivor.recent(10).map((record) => record.subject)).toContain("survivor");
  });

  test("a genuinely corrupt index is still quarantined", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "mem-corrupt-")), "memory");
    roots.push(join(dir, ".."));
    const bootstrap = makeStore(dir);
    bootstrap.add({ subject: "before", fact: "written before corruption", citations: ["a.ts:1"] });
    bootstrap.close();

    // Not a SQLite file at all.
    writeFileSync(bootstrap.indexPath, "this is definitely not a sqlite database", "utf8");

    const recovered = makeStore(dir);
    // The store connects lazily, so the first read is what opens the index.
    expect(recovered.recent(10).map((record) => record.subject)).toContain("before");
    expect(corruptFiles(dir).length).toBeGreaterThan(0);
  });
});
