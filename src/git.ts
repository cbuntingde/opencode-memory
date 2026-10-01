import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Project identity needs the Git origin remote.
 *
 * Reading `.git/config` directly is preferred over shelling out to `git`:
 * it is an order of magnitude faster, works when Git is not installed, and -
 * decisively on Windows - spawns no process at all. A `git` invocation from a
 * GUI-launched app flashes a console window unless `windowsHide` is set, which
 * is unacceptable for something a background memory plugin does on startup.
 */

export function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export interface GitProbe {
  remote(worktree: string): string | null;
}

/** Caching wrapper: identity is resolved per worktree, not per lookup. */
export function cachedGitProbe(inner: GitProbe = defaultGitProbe()): GitProbe {
  const cache = new Map<string, string | null>();
  return {
    remote(worktree: string): string | null {
      const key = safeRealpath(worktree);
      if (cache.has(key)) return cache.get(key) ?? null;
      const value = inner.remote(key);
      cache.set(key, value);
      return value;
    },
  };
}

/**
 * Locates the repository's config file by walking up from the worktree.
 *
 * Returns null when the directory is not inside a repository. That distinction
 * matters: "no repository" is the common case for a scratch folder, and it must
 * not trigger a `git` subprocess just to be told nothing.
 */
export function findGitConfigPath(worktree: string): string | null {
  let directory = safeRealpath(worktree);

  for (let depth = 0; depth < 64; depth += 1) {
    const configPath = gitConfigPath(directory);
    if (configPath) return configPath;

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return null;
}

/**
 * Reads `remote.origin.url` from the repository's own config file.
 *
 * Handles the three shapes that matter: a normal `.git/config`, a `.git` file
 * pointing at a linked worktree or submodule, and a repository with no origin.
 */
export function readRemoteFromConfig(worktree: string): string | null {
  const configPath = findGitConfigPath(worktree);
  if (!configPath) return null;
  const contents = readConfigFile(configPath);
  return contents === null ? null : parseOriginUrl(contents);
}

/** Resolves the config path for a directory, or null when it is not a repo. */
function gitConfigPath(directory: string): string | null {
  const dotGit = join(directory, ".git");

  let stats: Stats;
  try {
    stats = statSync(dotGit);
  } catch {
    return null;
  }

  // Ordinary repository: .git is a directory holding config.
  if (stats.isDirectory()) {
    return readConfigFile(join(dotGit, "config")) === null ? null : join(dotGit, "config");
  }

  // Linked worktree or submodule: .git is a file holding `gitdir: <path>`.
  if (!stats.isFile()) return null;
  const gitDir = readGitDirPointer(dotGit);
  if (!gitDir) return null;
  const config = join(gitDir, "config");
  return readConfigFile(config) === null ? null : config;
}

function readGitDirPointer(gitPath: string): string | null {
  try {
    const raw = readFileSync(gitPath, "utf8");
    const match = /^\s*gitdir:\s*(.+)$/m.exec(raw);
    if (!match) return null;
    const target = (match[1] ?? "").trim();
    if (!target) return null;
    // `isAbsolute` rather than a "/" test: on Windows a linked worktree records
    // `gitdir: C:\...`, and path.join would otherwise concatenate it onto the
    // .git file's own directory and produce a path that cannot exist.
    return isAbsolute(target) ? target : resolve(dirname(gitPath), target);
  } catch {
    return null;
  }
}

function readConfigFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Minimal INI reader for `[remote "origin"] url = ...`.
 *
 * Only the origin URL is needed, and a full INI parser would be a dependency for
 * one key. Handles `=`, tabs, comments and quoted section names.
 */
export function parseOriginUrl(config: string): string | null {
  let inOrigin = false;

  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const section = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (section) {
      const name = (section[1] ?? "").trim().toLowerCase();
      // Matches `remote "origin"`, and tolerates subsection syntax.
      inOrigin = name === 'remote "origin"' || name.replace(/\s+/g, " ") === "remote origin";
      continue;
    }

    if (!inOrigin) continue;

    const key = /^url\s*=\s*(.+)$/i.exec(line);
    if (key) {
      const value = (key[1] ?? "").trim();
      if (value.length > 0) return value;
    }
  }

  return null;
}

/**
 * Resolves the origin remote, spawning Git only as a last resort.
 *
 * Three tiers, cheapest first:
 *   1. read the repository's config file - no process, the normal path
 *   2. not a repository at all - answer from the filesystem alone, no process
 *   3. a repository whose config cannot be read - ask Git, with `windowsHide`
 *
 * Step 3 is the only one that can flash a window on Windows, which is why it is
 * unreachable for ordinary directories and why `windowsHide` is set regardless.
 */
export function defaultGitProbe(): GitProbe {
  return {
    remote(worktree: string): string | null {
      const configPath = findGitConfigPath(worktree);
      // Not a repository (or no origin in it): nothing to ask Git about.
      if (!configPath) return null;

      const contents = readConfigFile(configPath);
      if (contents !== null) {
        const remote = parseOriginUrl(contents);
        if (remote) return remote;
      }

      try {
        const stdout = execFileSync("git", ["-C", worktree, "remote", "get-url", "origin"], {
          encoding: "utf8",
          timeout: 3_000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const value = stdout.trim();
        return value.length > 0 ? value : null;
      } catch {
        return null;
      }
    },
  };
}
