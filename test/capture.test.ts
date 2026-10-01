import { describe, expect, test } from "bun:test";
import { CaptureQueue, buildAutoSave, buildSaveNudge, detectKeyword, extractFilePaths, shouldFlushOnTurn } from "../src/capture.ts";
import { SessionStore } from "../src/session-store.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

describe("extractFilePaths", () => {
  test("reads the common file-argument spellings", () => {
    expect(extractFilePaths({ filePath: "src/app.ts" })).toEqual(["src/app.ts"]);
    expect(extractFilePaths({ path: "src/lib.ts" })).toEqual(["src/lib.ts"]);
    expect(extractFilePaths({ file: "README.md" })).toEqual(["README.md"]);
  });

  test("collects paths from array arguments", () => {
    expect(extractFilePaths({ edits: [{ path: "a.ts" }, { path: "b.ts" }] })).toEqual(["a.ts", "b.ts"]);
    expect(extractFilePaths({ files: ["src/x.ts", "src/y.ts"] })).toEqual(["src/x.ts", "src/y.ts"]);
  });

  test("ignores junk", () => {
    expect(extractFilePaths(null)).toEqual([]);
    expect(extractFilePaths({ filePath: "" })).toEqual([]);
    expect(extractFilePaths({ filePath: "   " })).toEqual([]);
    expect(extractFilePaths({ filePath: "<placeholder>" })).toEqual([]);
  });
});

describe("detectKeyword", () => {
  test("matches configured trigger phrases case-insensitively", () => {
    expect(detectKeyword("Please REMEMBER to use bun", DEFAULT_CONFIG.keywordPatterns)).toBe("remember");
    expect(detectKeyword("don't forget the release notes", DEFAULT_CONFIG.keywordPatterns)).toBe("don't forget");
  });

  test("returns undefined for unrelated text", () => {
    expect(detectKeyword("add a test for the parser", DEFAULT_CONFIG.keywordPatterns)).toBeUndefined();
    expect(detectKeyword("", DEFAULT_CONFIG.keywordPatterns)).toBeUndefined();
  });
});

describe("CaptureQueue", () => {
  test("counts repeated mutating calls per file", () => {
    const queue = new CaptureQueue();
    queue.noteToolCall("s1", "edit", { filePath: "src/app.ts" }, 0);
    queue.noteToolCall("s1", "edit", { filePath: "src/app.ts" }, 0);
    queue.noteToolCall("s1", "write", { filePath: "src/other.ts" }, 0);
    queue.noteToolCall("s1", "read", { filePath: "src/readonly.ts" }, 0);

    const staged = queue.peek("s1");
    expect(staged?.files.get("src/app.ts")).toBe(2);
    expect(staged?.files.get("src/other.ts")).toBe(1);
    expect(staged?.files.has("src/readonly.ts")).toBe(false);
  });

  test("records bash commands without treating them as citations", () => {
    const queue = new CaptureQueue();
    queue.noteToolCall("s1", "bash", { command: "bun test" }, 0);
    const staged = queue.peek("s1");
    expect(staged?.commands).toEqual(["bun test"]);
    expect(staged?.files.size).toBe(0);
  });

  test("tracks completed turns per session", () => {
    const queue = new CaptureQueue();
    expect(queue.noteTurn("s1")).toBe(1);
    expect(queue.noteTurn("s1")).toBe(2);
    expect(queue.turnCount("s1")).toBe(2);
    expect(queue.noteTurn("s2")).toBe(1);
  });

  test("a nudge is delivered once and rate-limited", () => {
    const queue = new CaptureQueue();
    queue.setNudge("s1", "save something", 1_000);
    queue.setNudge("s1", "save again", 1_500);
    expect(queue.takeNudge("s1")).toBe("save something");
    expect(queue.takeNudge("s1")).toBeUndefined();

    // After the cooldown a new nudge is allowed.
    queue.setNudge("s1", "later nudge", 200_000);
    expect(queue.takeNudge("s1")).toBe("later nudge");
  });

  test("drain and clear reset the staged evidence", () => {
    const queue = new CaptureQueue();
    queue.noteToolCall("s1", "edit", { filePath: "a.ts" }, 0);
    expect(queue.hasPending("s1")).toBe(true);
    expect(queue.drain("s1")?.files.size).toBe(1);
    expect(queue.hasPending("s1")).toBe(false);

    queue.noteTurn("s1");
    queue.clear("s1");
    expect(queue.turnCount("s1")).toBe(0);
  });
});

describe("buildAutoSave", () => {
  test("fires when a file is edited more than once", () => {
    const draft = buildAutoSave({ files: new Map([["src/app.ts", 3]]), tools: new Set(["edit"]), commands: [] });
    expect(draft).not.toBeUndefined();
    expect(draft?.citations).toEqual([{ path: "src/app.ts" }]);
    expect(draft?.fact).toContain("src/app.ts (3 edits)");
    expect(draft?.kind).toBe("learned-pattern");
  });

  test("stays silent for scattered single edits", () => {
    const draft = buildAutoSave({ files: new Map([["a.ts", 1], ["b.ts", 1]]), tools: new Set(["edit"]), commands: [] });
    expect(draft).toBeUndefined();
  });

  test("caps the number of cited files", () => {
    const files = new Map(Array.from({ length: 9 }, (_, i) => [`f${i}.ts`, 4]));
    expect(buildAutoSave({ files, tools: new Set(), commands: [] })?.citations.length).toBe(5);
  });
});

describe("buildSaveNudge and shouldFlushOnTurn", () => {
  test("nudge names the touched files when known", () => {
    const nudge = buildSaveNudge({ files: new Map([["src/app.ts", 1]]), tools: new Set(), commands: [] });
    expect(nudge).toContain("src/app.ts");
    expect(nudge).toContain("memory_add");
  });

  test("nudge degrades gracefully with no evidence", () => {
    expect(buildSaveNudge(undefined)).toContain("memory_add");
  });

  test("flush cadence follows captureEveryNTurns", () => {
    const config = { ...DEFAULT_CONFIG, captureEveryNTurns: 3 };
    expect(shouldFlushOnTurn(3, config)).toBe(true);
    expect(shouldFlushOnTurn(6, config)).toBe(true);
    expect(shouldFlushOnTurn(2, config)).toBe(false);

    const disabled = { ...DEFAULT_CONFIG, captureEveryNTurns: 0 };
    expect(shouldFlushOnTurn(9, disabled)).toBe(false);
  });
});

describe("SessionStore", () => {
  test("supports the same surface as the file store", () => {
    let clock = 1_000;
    const store = new SessionStore({ sessionID: "ses_1", expiryDays: 28, maxMemoriesPerScope: 10, now: () => clock });

    const record = store.add({ subject: "Plan", fact: "Step 1 then step 2", citations: [] });
    expect(record.scope).toBe("session");
    expect(store.count()).toBe(1);
    expect(store.list()[0]?.id).toBe(record.id);
    expect(store.search("step").length).toBe(1);
    expect(store.search("unrelated").length).toBe(0);
    expect(store.recent(5).length).toBe(1);

    clock += 1_000;
    store.touch(record.id, false);
    expect(store.get(record.id)?.useCount).toBe(1);

    expect(store.forget(record.id)).toBe(true);
    expect(store.forget(record.id)).toBe(false);
    expect(store.count()).toBe(0);
  });

  test("closes permanently when the session ends", () => {
    const store = new SessionStore({ sessionID: "ses_2", expiryDays: 28, maxMemoriesPerScope: 10 });
    store.add({ subject: "note", fact: "temporary", citations: [] });
    store.close();
    expect(store.count()).toBe(0);
  });

  test("honours the size cap", () => {
    const store = new SessionStore({ sessionID: "ses_3", expiryDays: 28, maxMemoriesPerScope: 3 });
    for (let i = 0; i < 6; i += 1) store.add({ subject: `n${i}`, fact: `f${i}`, citations: [] });
    expect(store.count()).toBe(3);
  });
});
