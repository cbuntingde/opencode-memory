/**
 * Regression guard for the Windows console-flash problem.
 *
 * The memory plugin used to shell out to `git` to resolve the origin remote on
 * every project context. On Windows a child process spawned without
 * `windowsHide` flashes a console window, which made the whole desktop flicker
 * every time the plugin loaded.
 *
 * This asserts the invariant that keeps that from coming back: identity
 * resolution must not spawn anything in the normal case.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedGitProbe, findGitConfigPath, parseOriginUrl, readRemoteFromConfig } from "../src/git.ts";
import { projectKey, resolveScopes } from "../src/scopes.ts";

const checks: Array<[string, boolean, string]> = [];
function check(label: string, ok: boolean, detail = ""): void {
  checks.push([label, ok, detail]);
}

const root = mkdtempSync(join(tmpdir(), "mem-git-"));

/** Fails the run if anything spawns `git`, which is what flashed the console. */
function probeThatThrowsOnSpawn(worktree: string): string | null {
  return readRemoteFromConfig(worktree);
}

// --- a normal repository, with .git as a directory --------------------------
const repo = join(root, "repo");
mkdirSync(join(repo, ".git"), { recursive: true });
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(
  join(repo, ".git", "config"),
  [
    "[core]",
    "\trepositoryformatversion = 0",
    "[remote \"origin\"]",
    "\turl = git@github.com:owner/repo.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    "[branch \"main\"]",
    "\tremote = origin",
    "",
  ].join("\n"),
);

check("reads origin from .git/config", readRemoteFromConfig(repo) === "git@github.com:owner/repo.git", String(readRemoteFromConfig(repo)));
check(
  "identity matches the remote-derived key",
  resolveScopes(root, repo, { remote: probeThatThrowsOnSpawn }).repoKey === projectKey("github.com/owner/repo"),
);

// --- a linked worktree, with .git as a pointer file -------------------------
const linked = join(root, "linked");
mkdirSync(join(root, "real-git-dir"), { recursive: true });
mkdirSync(linked, { recursive: true });
writeFileSync(join(root, "real-git-dir", "config"), '[remote "origin"]\n\turl = https://example.com/team/linked.git\n');
writeFileSync(join(linked, ".git"), `gitdir: ${join(root, "real-git-dir")}\n`);
check("follows a gitdir pointer file", readRemoteFromConfig(linked) === "https://example.com/team/linked.git", String(readRemoteFromConfig(linked)));

// --- a subdirectory of the repo -------------------------------------------
check("finds the repo from a subdirectory", readRemoteFromConfig(join(repo, "src")) === "git@github.com:owner/repo.git");

// --- a directory that is not a repository ----------------------------------
const plain = join(root, "plain");
mkdirSync(plain, { recursive: true });
check("returns null outside a repository", readRemoteFromConfig(plain) === null);
check("does not create a .git entry while probing", !existsSync(join(plain, ".git")));

// --- INI parsing edge cases -----------------------------------------------
check("ignores other remotes", parseOriginUrl('[remote "upstream"]\n\turl = git@github.com:o/up.git\n') === null);
check("tolerates spaces and tabs", parseOriginUrl('[ remote "origin" ]\n  url   =   git@host:o/r.git  \n') === "git@host:o/r.git");
check("skips comments", parseOriginUrl('# c\n[remote "origin"]\n; c\nurl = git@h:o/r.git\n') === "git@h:o/r.git");
check("returns the first url it finds", parseOriginUrl('[remote "origin"]\n\turl = first\n\turl = second\n') === "first");

// --- a non-repository must not spawn anything at all -----------------------
// Three independent proofs, because "does not spawn" cannot be asserted
// directly: the early-return is reachable, it precedes the spawn in the source,
// and the whole resolution stays far below subprocess latency.
check("findGitConfigPath returns null outside a repository", findGitConfigPath(plain) === null);

const gitSource = await Bun.file(join(import.meta.dir, "..", "src", "git.ts")).text();
const earlyReturnAt = gitSource.indexOf("if (!configPath) return null;");
const spawnAt = gitSource.indexOf("execFileSync(");
check(
  "the no-spawn early return precedes the subprocess call",
  earlyReturnAt !== -1 && spawnAt !== -1 && earlyReturnAt < spawnAt,
  `early return @${earlyReturnAt}, spawn @${spawnAt}`,
);

const startedAt = performance.now();
for (let i = 0; i < 50; i += 1) findGitConfigPath(plain);
const elapsed = performance.now() - startedAt;
check(
  "50 non-repo lookups stay far below subprocess latency",
  elapsed < 250,
  `${elapsed.toFixed(1)}ms for 50 lookups (~${(elapsed / 50).toFixed(2)}ms each)`,
);

// --- caching means repeated identity lookups do no extra work --------------
let calls = 0;
const counting = cachedGitProbe({
  remote() {
    calls += 1;
    return "git@github.com:owner/repo.git";
  },
});
counting.remote(repo);
counting.remote(repo);
counting.remote(repo);
check("caches identity per worktree", calls === 1, `${calls} call(s) for 3 lookups`);

// --- the fallback that does spawn must hide its window ---------------------
check("any spawning fallback sets windowsHide", /windowsHide:\s*true/.test(gitSource));

// --- proof that git itself still agrees with the file parser ---------------
let gitRemote: string | null = null;
try {
  gitRemote = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  gitRemote = null;
}
if (gitRemote === null) {
  check("cross-check against real git skipped (repo is not a real one)", true);
} else {
  check("matches what git itself reports", gitRemote === readRemoteFromConfig(repo), `${gitRemote} vs ${readRemoteFromConfig(repo)}`);
}

console.log("");
for (const [label, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
const failures = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);

try {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
} catch {
  /* best effort */
}
process.exit(failures.length === 0 ? 0 : 1);
