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
    touch: () => null,
    setNeedsReview: () => {},
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
