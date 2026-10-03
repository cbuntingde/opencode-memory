import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { MemoryHub } from "../src/hub.ts";
import { silentLogger } from "../src/logger.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

const roots: string[] = [];
const hubs: MemoryHub[] = [];

function makeHub(): { hub: MemoryHub; globalDir: string } {
  const root = mkdtempSync(join(tmpdir(), "mem-hub-"));
  roots.push(root);
  const globalDir = join(root, "global");
  const hub = new MemoryHub({ config: DEFAULT_CONFIG, logger: silentLogger, globalDir });
  hubs.push(hub);
  return { hub, globalDir };
}

afterAll(() => {
  for (const hub of hubs) hub.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("MemoryHub contexts", () => {
  test("different spellings of one worktree share a single context", () => {
    const { hub } = makeHub();
    const root = mkdtempSync(join(tmpdir(), "mem-hub-wt-"));
    roots.push(root);

    const plain = hub.contextFor(root);
    const trailing = hub.contextFor(`${root}${sep}`);
    expect(trailing).toBe(plain);
  });

  test("the global store is shared across worktrees", () => {
    const { hub } = makeHub();
    const a = mkdtempSync(join(tmpdir(), "mem-hub-a-"));
    const b = mkdtempSync(join(tmpdir(), "mem-hub-b-"));
    roots.push(a, b);

    expect(hub.contextFor(a).global).toBe(hub.contextFor(b).global);
    expect(hub.contextFor(a).project).not.toBe(hub.contextFor(b).project);
  });

  test("stats counts the shared global store once", () => {
    const { hub } = makeHub();
    const a = mkdtempSync(join(tmpdir(), "mem-hub-c-"));
    const b = mkdtempSync(join(tmpdir(), "mem-hub-d-"));
    roots.push(a, b);

    hub.contextFor(a);
    hub.contextFor(b);
    hub.contextFor(a).global.add({ subject: "g", fact: "gf", citations: ["x.ts"] });

    expect(hub.stats().global).toBe(1);
    expect(hub.stats().worktrees).toBe(2);
  });
});
