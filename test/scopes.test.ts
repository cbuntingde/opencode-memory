import { describe, expect, test } from "bun:test";
import {
  hashKey,
  normalizeRemote,
  projectKey,
  relativeTo,
  repoNameFromIdentity,
  resolveCitationPath,
  slugify,
} from "../src/scopes.ts";

describe("normalizeRemote", () => {
  test("collapses equivalent remote spellings to one identity", () => {
    const expected = "github.com/owner/repo";
    expect(normalizeRemote("git@github.com:owner/repo.git")).toBe(expected);
    expect(normalizeRemote("https://github.com/owner/repo.git")).toBe(expected);
    expect(normalizeRemote("https://GitHub.com/Owner/Repo")).toBe(expected);
    expect(normalizeRemote("ssh://git@github.com/owner/repo.git")).toBe(expected);
    expect(normalizeRemote("https://user:token@github.com/owner/repo.git")).toBe(expected);
    expect(normalizeRemote("  git@github.com:owner/repo.git/  ")).toBe(expected);
  });

  test("rejects empty and bare-path remotes", () => {
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote("   ")).toBeNull();
    expect(normalizeRemote("/srv/git/repo.git")).toBeNull();
    expect(normalizeRemote("C:\\repos\\thing")).toBeNull();
  });
});

describe("projectKey", () => {
  test("same remote produces the same key regardless of spelling", () => {
    const a = projectKey(normalizeRemote("git@github.com:owner/repo.git") as string);
    const b = projectKey(normalizeRemote("https://github.com/owner/repo") as string);
    expect(a).toBe(b);
    expect(a.startsWith("repo_repo__")).toBe(true);
  });

  test("same-named repos on different remotes stay isolated", () => {
    const a = projectKey(normalizeRemote("git@github.com:owner-a/repo.git") as string);
    const b = projectKey(normalizeRemote("git@github.com:owner-b/repo.git") as string);
    expect(a).not.toBe(b);
  });

  test("fallback identity still yields a usable key", () => {
    const key = projectKey("/home/dev/projects/my-app");
    expect(key.startsWith("repo_my-app__")).toBe(true);
  });

  test("a Windows path fallback names the project after its last segment", () => {
    // Splitting only on "/" treated the whole path as the name, so the key read
    // as repo_c-ai-development-opencode-memory__<hash> instead of the repo name.
    const key = projectKey("C:\\ai-development\\opencode-memory");
    expect(key.startsWith("repo_opencode-memory__")).toBe(true);
    expect(key.length).toBeLessThanOrEqual("repo_opencode-memory__".length + 12);
    expect(repoNameFromIdentity("C:\\ai-development\\opencode-memory")).toBe("opencode-memory");
    expect(repoNameFromIdentity("/home/dev/my-app")).toBe("my-app");
    expect(repoNameFromIdentity("github.com/owner/repo")).toBe("repo");
  });
});

describe("hashKey and slugify", () => {
  test("hash is stable and length-bounded", () => {
    expect(hashKey("abc")).toBe(hashKey("abc"));
    expect(hashKey("abc")).not.toBe(hashKey("abd"));
    expect(hashKey("abc").length).toBe(12);
  });

  test("slugify strips unsafe characters", () => {
    expect(slugify("My App!!")).toBe("my-app");
    expect(slugify("///")).toBe("project");
    expect(slugify("a".repeat(80)).length).toBe(32);
  });
});

describe("citation path resolution", () => {
  test("relative citations anchor to the worktree", () => {
    const resolved = resolveCitationPath({ path: "src/app.ts", line: 3 }, "/repo");
    expect(resolved.replace(/\\/g, "/")).toBe("/repo/src/app.ts");
  });

  test("windows separators in a citation are normalised", () => {
    const resolved = resolveCitationPath({ path: "src\\lib\\util.ts" }, "/repo");
    expect(resolved.replace(/\\/g, "/")).toBe("/repo/src/lib/util.ts");
  });

  test("absolute citations are preserved", () => {
    const resolved = resolveCitationPath({ path: "/etc/hosts" }, "/repo");
    expect(resolved).toBe("/etc/hosts");
  });

  test("relativeTo returns null outside the base", () => {
    expect(relativeTo("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(relativeTo("/other/a.ts", "/repo")).toBeNull();
  });
});
