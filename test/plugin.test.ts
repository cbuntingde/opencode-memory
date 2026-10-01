import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryPlugin } from "../src/index.ts";
import type { Hooks } from "@opencode-ai/plugin";

/**
 * End-to-end coverage against the real hook surface: tools are executed exactly
 * as OpenCode would, and the system-transform hook is what the model actually
 * sees. Nothing here is mocked except the SDK client.
 */

interface Harness {
  hooks: Hooks;
  worktree: string;
  globalDir: string;
  sessionID: string;
}

const roots: string[] = [];
let hooks: Hooks | null = null;

function makeRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mem-e2e-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return root;
}

async function harness(worktree: string, sessionID = "ses_test1"): Promise<Harness> {
  const globalDir = makeRepo();
  process.env["OPENCODE_CONFIG_DIR"] = globalDir;

  const input = {
    client: {
      app: { log: async () => ({}) },
      session: { messages: async () => ({ data: { parts: [] } }) },
    },
    project: {},
    directory: worktree,
    worktree,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:4096"),
    $: {},
  };

  hooks = await MemoryPlugin(input as never, {});
  return { hooks, worktree, globalDir, sessionID };
}

function toolContext(worktree: string, sessionID: string) {
  return {
    sessionID,
    messageID: "msg_test",
    agent: "build",
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

let callID = 0;
async function callTool(worktree: string, sessionID: string, name: string, args: unknown): Promise<string> {
  const tool = hooks?.tool?.[name];
  if (!tool) throw new Error(`tool ${name} is not registered`);
  callID += 1;
  const result = await tool.execute(args as never, toolContext(worktree, sessionID) as never);
  return typeof result === "string" ? result : result.output;
}

async function transform(systemID?: string): Promise<string[]> {
  const system: string[] = [];
  await hooks?.["experimental.chat.system.transform"]?.({ sessionID: systemID } as never, { system } as never);
  return system;
}

async function emitEvent(type: string, properties: Record<string, unknown>): Promise<void> {
  await hooks?.event?.({ event: { type, properties } as never });
}

beforeEach(() => {
  hooks = null;
});

afterAll(async () => {
  // Release the SQLite handles the plugin still holds before deleting temp dirs.
  await hooks?.dispose?.();
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows may keep a transient handle; the OS temp dir will reclaim it */
    }
  }
});

describe("plugin registration", () => {
  test("registers every memory tool", async () => {
    await harness(makeRepo());
    const names = Object.keys(hooks?.tool ?? {}).sort();
    expect(names).toEqual([
      "memory_add",
      "memory_forget",
      "memory_list",
      "memory_profile",
      "memory_rebind",
      "memory_recall",
      "memory_search",
    ]);
  });
});

describe("memory_add", () => {
  test("stores a cited fact and confirms it", async () => {
    const repo = makeRepo({ "package.json": '{\n  "scripts": {\n    "build": "bun build"\n  }\n}' });
    const { worktree, sessionID } = await harness(repo);

    const output = await callTool(worktree, sessionID, "memory_add", {
      subject: "Build command",
      fact: "Production builds run through bun build",
      citations: ["package.json:3"],
      reason: "Needed before any release",
      kind: "project-config",
    });

    expect(output).toContain("Stored [m_");
    expect(output).toContain("package.json:3");
    expect(output).toContain("[valid]");
  });

  test("refuses an uncited project fact", async () => {
    const repo = makeRepo();
    const { worktree, sessionID } = await harness(repo);

    const output = await callTool(worktree, sessionID, "memory_add", {
      subject: "Vague",
      fact: "We always use tabs",
      citations: [],
    });

    expect(output).toContain("at least one citation is required");
    expect(await callTool(worktree, sessionID, "memory_list", { scope: "project" })).toContain("No memory stored");
  });

  test("redacts secrets before writing", async () => {
    const repo = makeRepo({ "src/config.ts": "export const apiKey = 'ghp_abcdefghijklmnopqrstuvwxyz0123'\n" });
    const { worktree, sessionID } = await harness(repo);

    await callTool(worktree, sessionID, "memory_add", {
      subject: "Credential",
      fact: "The key is ghp_abcdefghijklmnopqrstuvwxyz0123 for the api",
      citations: ["src/config.ts:1"],
      scope: "session",
    });

    const listed = await callTool(worktree, sessionID, "memory_list", { scope: "session" });
    expect(listed).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(listed).toContain("redacted");
  });
});

describe("injection", () => {
  test("a stored fact reaches the next session's context", async () => {
    const repo = makeRepo({ "src/build.ts": "// build entry\nexport const buildCommand = 'bun run build'\n" });
    const { worktree, sessionID } = await harness(repo);

    await callTool(worktree, sessionID, "memory_add", {
      subject: "Build command",
      fact: "The build command is bun run build",
      citations: ["src/build.ts:2"],
      kind: "project-config",
    });

    const system = await transform("ses_second");
    const block = system.join("\n");
    expect(block).toContain("[MEMORY]");
    expect(block).toContain("bun run build");
    expect(block).toContain("src/build.ts:2");
    expect(block).toContain("Memory rules:");
  });

  test("withholds a fact whose cited code disappeared", async () => {
    const repo = makeRepo({ "src/build.ts": "export const buildCommand = 'bun run build'\n" });
    const { worktree, sessionID } = await harness(repo);

    await callTool(worktree, sessionID, "memory_add", {
      subject: "Vanishing fact",
      fact: "The deploy script lives in scripts/deploy.sh and runs on release",
      citations: ["scripts/deploy.sh:1"],
    });

    const block = (await transform("ses_third")).join("\n");
    expect(block).not.toContain("The deploy script lives in scripts/deploy.sh");
    expect(block).toContain("withheld");
  });

  test("labels a drifted citation instead of dropping it", async () => {
    const repo = makeRepo({ "src/short.ts": "export const ONE = 1\n" });
    const { worktree, sessionID } = await harness(repo);

    await callTool(worktree, sessionID, "memory_add", {
      subject: "Drifted line",
      fact: "The migration ledger records every deployment timestamp",
      citations: ["src/short.ts:42"],
    });

    const block = (await transform("ses_fourth")).join("\n");
    expect(block).toContain("partially verified");
  });

  test("injecting nothing produces an empty context", async () => {
    const repo = makeRepo();
    await harness(repo);
    const system = await transform("ses_empty");
    expect(system.join("")).not.toContain("[MEMORY] verified persistent context");
  });
});

describe("capture and nudges", () => {
  test("repeated edits to one file are recorded automatically", async () => {
    const repo = makeRepo({ "src/app.ts": "export const app = 1\n" });
    const { worktree, sessionID } = await harness(repo);

    for (let i = 0; i < 2; i += 1) {
      await hooks?.["tool.execute.after"]?.(
        { tool: "edit", sessionID, callID: `c${i}`, args: { filePath: "src/app.ts" } } as never,
        { title: "", output: "", metadata: {} } as never,
      );
    }
    await emitEvent("session.idle", { sessionID });
    await emitEvent("session.idle", { sessionID });
    await emitEvent("session.idle", { sessionID });

    const listed = await callTool(worktree, sessionID, "memory_list", { scope: "project" });
    expect(listed).toContain("Files this task kept returning to");
    expect(listed).toContain("src/app.ts");
  });

  test('"remember" triggers a nudge rather than an unverified write', async () => {
    const repo = makeRepo();
    const { sessionID } = await harness(repo);

    await hooks?.["chat.message"]?.(
      { sessionID } as never,
      { message: { system: undefined }, parts: [{ type: "text", text: "Remember that we deploy on Tuesdays" }] } as never,
    );

    const block = (await transform(sessionID)).join("\n");
    expect(block).toContain("[MEMORY]");
    expect(block).toMatch(/record it now with memory_add|memory_add/);
    // Nothing was written on the user's behalf.
    expect(await callTool(repo, sessionID, "memory_list", { scope: "project" })).toContain("No memory stored");
  });

  test("compaction receives the memory and the touched files", async () => {
    const repo = makeRepo({ "src/app.ts": "export const app = 1\n" });
    const { worktree, sessionID } = await harness(repo);

    await callTool(worktree, sessionID, "memory_add", {
      subject: "Invariant",
      fact: "Never edit generated files under src/generated",
      citations: ["src/app.ts:1"],
    });
    await hooks?.["tool.execute.after"]?.(
      { tool: "write", sessionID, callID: "c9", args: { filePath: "src/app.ts" } } as never,
      { title: "", output: "", metadata: {} } as never,
    );

    const output = { context: [] as string[] };
    await hooks?.["experimental.session.compacting"]?.({ sessionID } as never, output as never);

    const context = output.context.join("\n");
    expect(context).toContain("Persistent memory to preserve");
    expect(context).toContain("Never edit generated files");
    expect(context).toContain("src/app.ts");
  });
});

describe("recall and management", () => {
  test("recall reports verification state per fact", async () => {
    const repo = makeRepo({ "src/log.ts": "export const LOG_FORMAT = 'timestamp,error,user'\n" });
    const { worktree, sessionID } = await harness(repo);

    await callTool(worktree, sessionID, "memory_add", {
      subject: "Log format",
      fact: "Log lines use the format timestamp, error code, user id",
      citations: ["src/log.ts:1"],
      kind: "project-config",
    });

    const output = await callTool(worktree, sessionID, "memory_recall", { query: "log format" });
    expect(output).toContain("Log format");
    expect(output).toContain("[valid]");
  });

  test("recall on an empty store points the agent back at the code", async () => {
    const repo = makeRepo();
    const { worktree, sessionID } = await harness(repo);
    const output = await callTool(worktree, sessionID, "memory_recall", { query: "anything" });
    expect(output).toContain("Nothing is known yet");
  });

  test("forget removes a fact and it stops being injected", async () => {
    const repo = makeRepo({ "src/x.ts": "export const x = 1\n" });
    const { worktree, sessionID } = await harness(repo);

    const added = await callTool(worktree, sessionID, "memory_add", {
      subject: "Temporary",
      fact: "Temporary fact about the temporary thing",
      citations: ["src/x.ts:1"],
    });
    const id = /\[(m_[a-z0-9]+)\]/.exec(added)?.[1] as string;

    expect(await callTool(worktree, sessionID, "memory_forget", { memoryId: id })).toContain("Deleted");
    expect((await transform("ses_after_forget")).join("\n")).not.toContain("Temporary fact");
  });

  test("global preferences stay out of other scopes and are listed by profile", async () => {
    const repo = makeRepo({ "src/x.ts": "export const x = 1\n" });
    const { worktree, sessionID } = await harness(repo);

    await callTool(worktree, sessionID, "memory_add", {
      subject: "Formatting",
      fact: "I prefer single quotes in JavaScript",
      citations: ["src/x.ts:1"],
      scope: "global",
      kind: "preference",
    });

    const profile = await callTool(worktree, sessionID, "memory_profile", {});
    expect(profile).toContain("single quotes");
    expect(await callTool(worktree, sessionID, "memory_list", { scope: "project" })).toContain("No memory stored");
  });

  test("forgetAll clears a scope", async () => {
    const repo = makeRepo({ "src/x.ts": "export const x = 1\n" });
    const { worktree, sessionID } = await harness(repo);

    await callTool(worktree, sessionID, "memory_add", { subject: "a", fact: "fa", citations: ["src/x.ts:1"] });
    expect(await callTool(worktree, sessionID, "memory_forget", { all: true })).toContain("Cleared 1 memory");
  });
});

describe("durability and isolation", () => {
  test("memories survive a plugin restart", async () => {
    const repo = makeRepo({ "src/x.ts": "export const durable = true\n" });
    const { worktree, sessionID } = await harness(repo);

    await callTool(worktree, sessionID, "memory_add", {
      subject: "Durable fact",
      fact: "The durable flag is exported from src/x.ts and imported widely",
      citations: ["src/x.ts:1"],
    });
    await hooks?.dispose?.();

    // Fresh plugin instance against the same directories.
    const restarted = await harness(repo);
    expect(existsSync(join(repo, ".opencode", "memory", "project.md"))).toBe(true);
    const listed = await callTool(repo, "ses_restart", "memory_list", { scope: "project" });
    expect(listed).toContain("durable flag is exported");
    expect(restarted.hooks).toBeTruthy();
  });

  test("a different repository cannot see the first one's facts", async () => {
    const repoA = makeRepo({ "src/x.ts": "export const a = 1\n" });
    const { sessionID } = await harness(repoA);
    await callTool(repoA, sessionID, "memory_add", {
      subject: "Repo A only",
      fact: "Repo A uses a specific internal codegen pipeline",
      citations: ["src/x.ts:1"],
    });

    const repoB = makeRepo({ "src/y.ts": "export const b = 2\n" });
    await harness(repoB);
    const listed = await callTool(repoB, "ses_other", "memory_list", { scope: "project" });
    expect(listed).toContain("No memory stored");
  });

  test("the Markdown mirror exists for both scopes", async () => {
    const repo = makeRepo({ "src/x.ts": "export const x = 1\n" });
    const { worktree, globalDir, sessionID } = await harness(repo);

    await callTool(worktree, sessionID, "memory_add", { subject: "p", fact: "fp", citations: ["src/x.ts:1"] });
    await callTool(worktree, sessionID, "memory_add", {
      subject: "g",
      fact: "fg",
      citations: ["src/x.ts:1"],
      scope: "global",
      kind: "preference",
    });

    expect(existsSync(join(worktree, ".opencode", "memory", "project.md"))).toBe(true);
    expect(existsSync(join(globalDir, "memory", "global.md"))).toBe(true);
  });
});
