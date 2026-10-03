import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryStore } from "../src/store.ts";
import { silentLogger } from "../src/logger.ts";
import { verifyRecord, verifyAndRecord, defaultVerifyDeps, type VerifiedEntry } from "../src/verify.ts";
import type { MemoryRecord, Scope } from "../src/types.ts";

const roots: string[] = [];
const openStores: MemoryStore[] = [];

function makeRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mem-verify-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return root;
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m_test",
    scope: "project" as Scope,
    repoKey: "repo_test__abc",
    repoId: "abc",
    subject: "API version sync",
    fact: "The API version must match across client and server",
    citations: [{ path: "src/version.ts", line: 3 }],
    reason: "",
    kind: "learned-pattern",
    createdAt: 1,
    updatedAt: 1,
    lastValidatedAt: null,
    useCount: 0,
    expiresAt: 1,
    needsReview: false,
    ...overrides,
  };
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

describe("verifyRecord", () => {
  test("valid when the cited line still supports the fact", () => {
    const root = makeRepo({
      "src/version.ts": ["// header", "export const API_VERSION", "export const API_VERSION = 'v2.1.4'", ""].join("\n"),
    });
    const record = makeRecord({ citations: [{ path: "src/version.ts", line: 3 }] });
    const result = verifyRecord(record, root, defaultVerifyDeps());

    expect(result.state).toBe("valid");
    expect(result.checks[0]?.exists).toBe(true);
    expect(result.checks[0]?.lineInRange).toBe(true);
    // Prose ("API version") matches the constant name via identifier splitting.
    expect(result.checks[0]?.overlap).toBeGreaterThan(0);
  });

  test("invalid when a cited file no longer exists", () => {
    const root = makeRepo({ "src/version.ts": "export const API_VERSION = 'v2'\n" });
    const record = makeRecord({
      citations: [
        { path: "src/version.ts", line: 1 },
        { path: "src/deleted.ts", line: 4 },
      ],
    });
    const result = verifyRecord(record, root, defaultVerifyDeps());

    expect(result.state).toBe("invalid");
    expect(result.checks[1]?.exists).toBe(false);
    expect(result.note).toContain("no longer exist");
  });

  test("invalid when there are no citations at all", () => {
    const root = makeRepo({ "a.ts": "x" });
    const result = verifyRecord(makeRecord({ citations: [] }), root, defaultVerifyDeps());
    expect(result.state).toBe("invalid");
    expect(result.note).toContain("no citations");
  });

  test("valid when the file exists even if the line shares no wording", () => {
    const root = makeRepo({ "src/version.ts": ["// header", "export const API_VERSION", "const value = 'v2.1.4'", ""].join("\n") });
    const record = makeRecord({
      fact: "The API version must match across client and server",
      citations: [{ path: "src/version.ts", line: 3 }],
    });
    const result = verifyRecord(record, root, defaultVerifyDeps());

    // A fact is an abstraction over concrete code, so lexical agreement is
    // reported but never decides validity.
    expect(result.state).toBe("valid");
    expect(result.checks[0]?.overlap).toBe(0);
    expect(result.note).toContain("shares no wording");
  });

  test("partial when the cited line is out of range", () => {
    const root = makeRepo({ "src/version.ts": "export const API_VERSION = 'v2'\n" });
    const record = makeRecord({ citations: [{ path: "src/version.ts", line: 900 }] });
    const result = verifyRecord(record, root, defaultVerifyDeps());
    expect(result.state).toBe("partial");
    expect(result.checks[0]?.lineInRange).toBe(false);
  });

  test("partial when the cited line is blank", () => {
    const root = makeRepo({ "src/version.ts": "export const API_VERSION = 'v2'\n   \n" });
    const record = makeRecord({ citations: [{ path: "src/version.ts", line: 2 }] });
    expect(verifyRecord(record, root, defaultVerifyDeps()).state).toBe("partial");
  });

  test("whole-file citations only require the file to exist", () => {
    const root = makeRepo({ "src/version.ts": "anything at all\n" });
    const record = makeRecord({ citations: [{ path: "src/version.ts" }] });
    expect(verifyRecord(record, root, defaultVerifyDeps()).state).toBe("valid");
  });

  test("adversarially planted facts with bogus citations are invalid", () => {
    const root = makeRepo({ "src/real.ts": "export const x = 1\n" });
    const planted = makeRecord({
      fact: "This project always deploys on Fridays",
      citations: [{ path: "src/never-existed.ts", line: 2 }],
    });
    expect(verifyRecord(planted, root, defaultVerifyDeps()).state).toBe("invalid");
  });
});

describe("verifyAndRecord", () => {
  test("flags invalid entries, refreshes valid ones, leaves partial usable", () => {
    const root = makeRepo({
      "src/version.ts": ["", "", "const API_VERSION = 'v2.1.4' const must must match", ""].join("\n"),
    });
    const store = new MemoryStore({
      dir: join(root, "memory"),
      scope: "project",
      repoKey: "repo_test__abc",
      expiryDays: 28,
      maxMemoriesPerScope: 100,
      logger: silentLogger,
    });
    openStores.push(store);

    const good = store.add({
      subject: "Version constant",
      fact: "API_VERSION constant must match client and server",
      citations: ["src/version.ts:3"],
    });
    const bad = store.add({
      subject: "Deployment cadence",
      fact: "Deploys always happen on Friday",
      citations: ["src/gone.ts:1"],
    });

    const entries: VerifiedEntry[] = [good, bad].map((record) => ({
      record,
      result: verifyRecord(record, root, defaultVerifyDeps()),
    }));

    verifyAndRecord(
      entries,
      (id, validated) => {
        store.touch(id, validated);
      },
      (id, needsReview) => {
        store.setNeedsReview(id, needsReview);
      },
    );

    expect(store.get(good.id)?.lastValidatedAt).not.toBeNull();
    expect(store.get(good.id)?.useCount).toBe(1);
    expect(store.get(bad.id)?.needsReview).toBe(true);
    // The poisoned fact is no longer offered by the normal list path.
    expect(store.list().map((record) => record.id)).not.toContain(bad.id);
    expect(store.list({ includeReview: true }).length).toBe(2);
  });

  test("partial entries keep living via touch, without a validation stamp", () => {
    const root = makeRepo({ "src/version.ts": "export const API_VERSION = 'v2'\n" });
    const store = new MemoryStore({
      dir: join(root, "memory"),
      scope: "project",
      repoKey: "repo_test__abc",
      expiryDays: 28,
      maxMemoriesPerScope: 100,
      logger: silentLogger,
    });
    openStores.push(store);

    const drifted = store.add({
      subject: "Drifted line",
      fact: "The version constant moved",
      citations: ["src/version.ts:900"],
    });
    const entries: VerifiedEntry[] = [
      { record: drifted, result: verifyRecord(drifted, root, defaultVerifyDeps()) },
    ];
    expect(entries[0]!.result.state).toBe("partial");

    verifyAndRecord(
      entries,
      (id, validated) => {
        store.touch(id, validated);
      },
      (id, needsReview) => {
        store.setNeedsReview(id, needsReview);
      },
    );

    // Used but drifted: expiry extended, validation stamp untouched, still listed.
    expect(store.get(drifted.id)?.useCount).toBe(1);
    expect(store.get(drifted.id)?.lastValidatedAt).toBeNull();
    expect(store.get(drifted.id)?.needsReview).toBe(false);
    expect(store.list().map((record) => record.id)).toContain(drifted.id);
  });
});
