/**
 * Smoke test: drives one full simulated session against a real directory tree,
 * through both plugin generations, and checks the artefacts left on disk:
 *
 *   .opencode/memory/project.md   project mirror
 *   .opencode/memory/index.db     project index
 *
 * v1 is exercised through `server()`, v2 through `setup(ctx)`, which is exactly
 * how each generation loads the same default export.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import plugin from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "mem-smoke-"));
const globalDir = join(root, "_global");
process.env["OPENCODE_CONFIG_DIR"] = globalDir;

const worktree = join(root, "project");
mkdirSync(join(worktree, "src"), { recursive: true });
writeFileSync(join(worktree, "src", "version.ts"), "export const API_VERSION = 'v2.1.4'\n", "utf8");

const checks: Array<[string, boolean, string]> = [];
function check(label: string, ok: boolean, detail = ""): void {
  checks.push([label, ok, detail]);
}

check("default export exposes id + setup (v2)", typeof plugin.setup === "function", plugin.id);
check("default export exposes server (v1)", typeof plugin.server === "function");

// ---------------------------------------------------------------- v2 session
const registered: Record<string, { description: string; input: unknown; execute: (input: unknown, ctx: unknown) => Promise<{ content: string }> }> = {};
const hooks: Record<string, Array<(event: unknown) => unknown>> = {};
const registrations: Array<{ dispose(): Promise<void> }> = [];

const v2ctx = {
  location: { directory: worktree, project: { id: "prj_1", directory: worktree, canonical: worktree } },
  options: {},
  tool: {
    transform: async (cb: (editor: unknown) => void) => {
      const reg = { dispose: async () => {} };
      registrations.push(reg);
      cb({
        add: (t: { name: string }) => {
          registered[t.name] = t as never;
        },
      });
      return reg;
    },
    hook: async (name: string, cb: (event: unknown) => unknown) => {
      const reg = { dispose: async () => {} };
      registrations.push(reg);
      (hooks[name] ??= []).push(cb);
      return reg;
    },
  },
  session: {
    hook: async (name: string, cb: (event: unknown) => unknown) => {
      const reg = { dispose: async () => {} };
      registrations.push(reg);
      (hooks[name] ??= []).push(cb);
      return reg;
    },
    context: async () => [{ parts: [{ type: "text", text: "previous assistant summary" }] }],
  },
  event: {
    subscribe: () => ({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    }),
  },
} as never;

const cleanup = await plugin.setup(v2ctx);

check("v2 registered every memory tool", Object.keys(registered).length === 7, Object.keys(registered).join(","));
check("v2 registered the prompt hook", Array.isArray(hooks["prompt"]));
check("v2 registered the context hook", Array.isArray(hooks["context"]));
check("v2 registered the compaction hook", Array.isArray(hooks["compaction"]));
check("v2 registered tool execute.after", Array.isArray(hooks["execute.after"]));
check("setup returned a cleanup function", typeof cleanup === "function");

const addResult = await registered["memory_add"]!.execute(
  {
    subject: "API version constant",
    fact: "The API version is declared in src/version.ts and must be bumped on every release",
    citations: ["src/version.ts:1"],
    reason: "Releases break when the constant and the docs disagree",
    kind: "project-config",
  },
  { sessionID: "ses_v2" },
);
check("v2 memory_add stored the fact", addResult.content.includes("Stored [m_"), addResult.content.slice(0, 70));
check("v2 memory_add reported it valid", addResult.content.includes("[valid]"));

const addSchema = registered["memory_add"]!.input as { required?: string[] };
check("v2 schema requires citations", Array.isArray(addSchema.required) && addSchema.required.includes("citations"));

const systemEvent = { sessionID: "ses_v2_next", system: [] as Array<{ type: string; text: string }>, messages: [], tools: {} };
await hooks["context"]!.forEach((cb) => cb(systemEvent));
const systemText = systemEvent.system.map((part) => part.text).join("\n");
check("v2 injects the fact into system context", systemText.includes("API version constant"));
check("v2 injection carries the citation", systemText.includes("src/version.ts:1"));
check("v2 injection stays within budget", systemText.length <= 4000, `${systemText.length} chars`);

const projectMirror = join(worktree, ".opencode", "memory", "project.md");
check("project mirror written", existsSync(projectMirror));
check("project index written", existsSync(join(worktree, ".opencode", "memory", "index.db")));

const mirrorText = readFileSync(projectMirror, "utf8");
check("mirror holds the fact", mirrorText.includes("API version constant"));
check("mirror records validation", /- Validated: \d{4}-\d{2}-\d{2}/.test(mirrorText));

// Redaction on the way to disk.
await registered["memory_add"]!.execute(
  {
    subject: "Secret",
    fact: "Deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123 for staging",
    citations: ["src/version.ts:1"],
  },
  { sessionID: "ses_v2" },
);
check("secret never reaches disk", !readFileSync(projectMirror, "utf8").includes("ghp_abcdefghijklmnopqrstuvwxyz0123"));

// Stale citation is withheld.
writeFileSync(join(worktree, "src", "gone.ts"), "temporary\n", "utf8");
await registered["memory_add"]!.execute(
  { subject: "Gone file", fact: "Deployment config lives in src/gone.ts", citations: ["src/gone.ts:1"] },
  { sessionID: "ses_v2" },
);
rmSync(join(worktree, "src", "gone.ts"));

const staleEvent = { sessionID: "ses_v2_stale", system: [] as Array<{ type: string; text: string }>, messages: [], tools: {} };
await hooks["context"]!.forEach((cb) => cb(staleEvent));
const staleText = staleEvent.system.map((part) => part.text).join("\n");
check("stale fact is not injected", !staleText.includes("Deployment config lives in"));
check("stale fact is reported as withheld", staleText.includes("withheld"));

const compactionEvent = { sessionID: "ses_v2_compact", system: [] as Array<{ type: string; text: string }>, messages: [], tools: {} };
for (const cb of hooks["compaction"]!) await cb(compactionEvent);
const compactionText = compactionEvent.system.map((part) => part.text).join("\n");
check("compaction carries memory", compactionText.includes("Persistent memory to preserve"));
check("compaction carries a fact", compactionText.includes("API version constant"));

const promptEvent = { sessionID: "ses_v2_prompt", prompt: { text: "Remember that we deploy on Tuesdays" }, delivery: "steer" };
for (const cb of hooks["prompt"]!) cb(promptEvent);
const nudgeEvent = { sessionID: "ses_v2_prompt", system: [] as Array<{ type: string; text: string }>, messages: [], tools: {} };
await hooks["context"]!.forEach((cb) => cb(nudgeEvent));
check("keyword produces a save nudge", nudgeEvent.system.map((p) => p.text).join("\n").includes("memory_add"));

for (const reg of registrations) await reg.dispose();
if (typeof cleanup === "function") await cleanup();

// ---------------------------------------------------------------- v1 session
const v1hooks = await plugin.server({
  client: { app: { log: async () => ({}) }, session: { messages: async () => ({ data: { parts: [] } }) } },
  project: {},
  directory: worktree,
  worktree,
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost:4096"),
  $: {},
} as never);

check("v1 registered every memory tool", Object.keys(v1hooks.tool ?? {}).length === 7, Object.keys(v1hooks.tool ?? {}).join(","));

const v1Ctx = {
  sessionID: "ses_v1",
  messageID: "msg_1",
  agent: "build",
  directory: worktree,
  worktree,
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};
const v1Add = await v1hooks.tool!["memory_add"]!.execute(
  { subject: "v1 fact", fact: "The v1 adapter writes to the same store", citations: ["src/version.ts:1"] },
  v1Ctx as never,
);
check("v1 memory_add shares the store", typeof v1Add === "string" ? v1Add.includes("Stored [m_") : false, String(v1Add).slice(0, 60));

const v1Listed = await v1hooks.tool!["memory_list"]!.execute({ scope: "project" }, v1Ctx as never);
check("v1 sees the fact written by v2", typeof v1Listed === "string" && v1Listed.includes("API version constant"));

const v1System: string[] = [];
await v1hooks["experimental.chat.system.transform"]?.({ sessionID: "ses_v1_next" } as never, { system: v1System } as never);
check("v1 injects the same verified facts", v1System.join("\n").includes("API version constant"));
await v1hooks.dispose?.();

console.log("");
for (const [label, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
const failures = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);

try {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
} catch {
  /* Windows may hold a transient handle */
}
process.exit(failures.length === 0 ? 0 : 1);
