import { describe, expect, test } from "bun:test";
import { Injector, type InjectableStore } from "../src/inject.ts";
import { DEFAULT_CONFIG, type MemoryRecord } from "../src/types.ts";

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m_test",
    scope: "project",
    repoKey: "repo_test__abc",
    repoId: "abc",
    subject: "Subject",
    fact: "The build command is bun run build",
    citations: [{ path: "src/build.ts", line: 1 }],
    reason: "",
    kind: "project-config",
    createdAt: 1,
    updatedAt: 1,
    lastValidatedAt: null,
    useCount: 0,
    expiresAt: 1,
    needsReview: false,
    ...overrides,
  };
}

function stubStore(records: MemoryRecord[] = []): InjectableStore & { records: MemoryRecord[] } {
  return {
    records,
    revision: 0,
    repo: "repo_test__abc",
    recent: (limit: number) => records.slice(0, limit),
    review: (limit: number) => records.filter((record) => record.needsReview).slice(0, limit),
    touch: () => null,
    setNeedsReview: (id: string, needsReview: boolean) => {
      const record = records.find((candidate) => candidate.id === id);
      if (record) record.needsReview = needsReview;
    },
  };
}

function makeInjector(projectRecords: MemoryRecord[], readText: (path: string) => string | undefined) {
  return new Injector({
    config: DEFAULT_CONFIG,
    globalStore: stubStore([]),
    projectStore: stubStore(projectRecords),
    worktree: "/repo",
    verifyDeps: { readText },
  });
}

describe("Injector stats", () => {
  test("stats accumulate across builds and saves", () => {
    const injector = makeInjector([makeRecord({ id: "m_1" })], () => "export const build = 1\n");

    injector.noteSave();
    expect(injector.stats.saved).toBe(1);

    const built = injector.build("s1");
    expect(built?.ids).toContain("m_1");
    expect(injector.stats.recalled).toBe(1);
    expect(injector.stats.verified).toBe(1);
  });

  test("withheld count reflects the current build, not history", () => {
    const project = stubStore([makeRecord({ id: "m_bad", citations: [{ path: "gone.ts", line: 1 }] })]);
    const injector = new Injector({
      config: DEFAULT_CONFIG,
      globalStore: stubStore([]),
      projectStore: project,
      worktree: "/repo",
      verifyDeps: { readText: () => undefined },
    });

    const first = injector.build("s1");
    expect(first?.block).toContain("withheld");

    // A real store stops offering the flagged record; simulate that here.
    project.records.length = 0;
    project.revision += 1;
    const second = injector.build("s1");
    expect(second?.block ?? "").not.toContain("withheld");
  });
});

describe("Injector block persistence", () => {
  test("memory stays in context across rebuilds within one session", () => {
    let clock = 1_000_000;
    const injector = new Injector({
      config: DEFAULT_CONFIG,
      globalStore: stubStore([]),
      projectStore: stubStore([makeRecord({ id: "m_1" })]),
      worktree: "/repo",
      verifyDeps: { readText: () => "export const build = 1\n" },
      now: () => clock,
      cacheTtlMs: 30_000,
    });

    const first = injector.build("s1");
    expect(first?.ids).toContain("m_1");
    expect(first?.block.length).toBeGreaterThan(0);

    // The context hook rebuilds on every model request. Once the block cache
    // expires the same facts must still be offered: a per-session "already
    // injected" set used to empty the block here and leave the session with no
    // memory at all for the rest of its life.
    clock += 31_000;
    const second = injector.build("s1");
    expect(second?.ids).toContain("m_1");
    expect(second?.block.length).toBeGreaterThan(0);

    clock += 31_000;
    const third = injector.build("s1");
    expect(third?.ids).toContain("m_1");
  });

  test("one fact never appears twice in the same block", () => {
    const shared = makeRecord({ id: "m_shared", kind: "project-config" });
    const injector = new Injector({
      config: DEFAULT_CONFIG,
      globalStore: stubStore([shared]),
      projectStore: stubStore([shared]),
      worktree: "/repo",
      verifyDeps: { readText: () => "export const build = 1\n" },
    });

    const built = injector.build("s1");
    expect(built?.ids.filter((id) => id === "m_shared").length).toBe(1);
  });
});

describe("Injector review recovery", () => {
  // readText is handed the citation resolved against the worktree, and the exact
  // separator depends on the platform, so presence is tracked with a flag rather
  // than a path lookup.
  function fixture() {
    let present = false;
    const reads: string[] = [];
    return {
      reads,
      restore: () => {
        present = true;
      },
      breakFile: () => {
        present = false;
      },
      verifyDeps: {
        readText: (path: string) => {
          reads.push(path);
          return present ? "export const build = 1\n" : undefined;
        },
      },
    };
  }

  test("a flagged memory returns once its citation is restored", () => {
    let clock = 1_000_000;
    const file = fixture();
    const project = stubStore([
      makeRecord({ id: "m_gone", subject: "restore me", citations: [{ path: "src.ts", line: 1 }] }),
    ]);
    const injector = new Injector({
      config: DEFAULT_CONFIG,
      globalStore: stubStore([]),
      projectStore: project,
      worktree: "/repo",
      verifyDeps: file.verifyDeps,
      now: () => clock,
    });

    // The cited file is missing, so the fact is withheld and flagged.
    const first = injector.build("s1");
    expect(first?.ids).not.toContain("m_gone");
    expect(project.records.find((record) => record.id === "m_gone")?.needsReview).toBe(true);

    // The file comes back. A flagged row is excluded from every read path, so
    // without a periodic re-check the fact would stay exiled with no route back.
    file.restore();
    clock += 6 * 60_000;
    const second = injector.build("s1");
    expect(project.records.find((record) => record.id === "m_gone")?.needsReview).toBe(false);
    expect(second?.ids).toContain("m_gone");
  });

  test("a fact that is genuinely stale stays flagged", () => {
    let clock = 1_000_000;
    const file = fixture();
    file.restore();
    const project = stubStore([
      makeRecord({ id: "m_stale", citations: [{ path: "src.ts", line: 1 }] }),
    ]);
    const injector = new Injector({
      config: DEFAULT_CONFIG,
      globalStore: stubStore([]),
      projectStore: project,
      worktree: "/repo",
      verifyDeps: file.verifyDeps,
      now: () => clock,
    });

    injector.build("s1");
    file.breakFile();
    clock += 6 * 60_000;
    injector.build("s1");
    expect(project.records.find((record) => record.id === "m_stale")?.needsReview).toBe(true);
  });
});
