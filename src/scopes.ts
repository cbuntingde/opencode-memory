import { createHash } from "node:crypto";
import { isAbsolute, join, sep } from "node:path";
import { cachedGitProbe, safeRealpath, type GitProbe } from "./git.ts";
import type { Citation } from "./types.ts";

/**
 * Scope resolution decides *where* a memory lives and *which* memories a
 * session is allowed to see.
 *
 * The project identity is derived from the normalised Git origin remote when one
 * exists, so clones of the same repository share memory while same-named
 * repositories on different remotes stay isolated. Without a remote we fall back
 * to the real filesystem path of the worktree.
 */

export const GLOBAL_REPO_KEY = "user";

export interface ScopeResolution {
  /** Directory holding user-wide memories and the global config. */
  globalDir: string;
  /** Directory holding project memories, inside the repository. */
  projectDir: string;
  /** Display form of the identity, e.g. `repo_my-app__a1b2c3d4e5f6`. */
  repoKey: string;
  /**
   * Stable identity used for lookups: the hash half of `repoKey`.
   *
   * Keeping this separate from the display name is what stops a rename, a slug
   * change or a plugin upgrade from making existing memories unreachable.
   */
  repoId: string;
  /** Human-readable project name derived from the identity. */
  repoName: string;
  /** Normalised remote used for the identity, or null when unavailable. */
  remote: string | null;
  /** What the identity was derived from, for diagnostics and sync. */
  identity: string;
}

/** Collapses every Git remote spelling to `host/path` so equivalent URLs match. */
export function normalizeRemote(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // A local path is not a repository identity. This is checked before any
  // rewriting, because the scp-syntax rewrite below would otherwise disguise
  // `C:\repos\thing` as `c/\repos/thing`.
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || trimmed.startsWith("file://")) return null;

  let value = trimmed.replace(/\\/g, "/");

  // scp-like syntax: git@github.com:owner/repo.git
  const scp = /^([^@\s/]+@)?([^:\s/]+):(?!\/\/)(.+)$/.exec(value);
  if (scp) {
    value = `${scp[2]}/${scp[3]}`;
  }

  value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  // Strip any remaining credentials.
  value = value.replace(/^[^@/]*@/, "");
  // Trailing slashes first: `repo.git/` must become `repo`, not `repo.git`.
  value = value.replace(/\/+$/, "");
  value = value.replace(/\.git$/i, "");
  value = value.trim().toLowerCase();

  if (!value) return null;
  return value;
}

export function hashKey(input: string, length = 12): string {
  return createHash("sha1").update(input).digest("hex").slice(0, length);
}

export function slugify(input: string, maxLength = 32): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, maxLength) : "project";
}

export function repoNameFromIdentity(identity: string): string {
  // Split on both separators: a Windows path fallback contains no forward
  // slashes, and treating the whole path as the name produced a nonsense key.
  const segments = identity.split(/[\\/]+/).filter(Boolean);
  return segments.length > 0 ? (segments[segments.length - 1] as string) : "project";
}

export function projectKey(identity: string): string {
  return `repo_${slugify(repoNameFromIdentity(identity))}__${hashKey(identity)}`;
}

/** Extracts the stable hash from a `repo_<name>__<hash>` key. */
export function hashFromProjectKey(key: string): string {
  const marker = key.lastIndexOf("__");
  if (marker === -1) return key;
  const hash = key.slice(marker + 2);
  return /^[0-9a-f]{6,}$/i.test(hash) ? hash : key;
}

/**
 * Identity for the global scope. Constant by design: user preferences must be
 * visible from every project on the machine.
 */
export const GLOBAL_REPO_ID = "global";

export { safeRealpath };

export function resolveScopes(
  globalDir: string,
  worktree: string,
  git: GitProbe = cachedGitProbe(),
): ScopeResolution {
  const rawRemote = git.remote(worktree);
  const remote = rawRemote ? normalizeRemote(rawRemote) : null;
  const identity = remote ?? safeRealpath(worktree);

  return {
    globalDir,
    projectDir: join(worktree, ".opencode", "memory"),
    repoKey: projectKey(identity),
    repoId: hashKey(identity),
    repoName: repoNameFromIdentity(identity),
    remote,
    identity,
  };
}

/**
 * Maps a citation to an absolute path inside the worktree. Absolute citations are
 * accepted as-is; relative ones are anchored to the worktree root so a memory
 * keeps meaning across restarts in any directory.
 */
export function resolveCitationPath(citation: Citation, worktree: string): string {
  if (isAbsolute(citation.path)) return citation.path;
  return join(worktree, citation.path.split("/").join(sep));
}

/** Repo-relative display form, so injected context stays short and portable. */
export function toRepoRelative(citation: Citation, worktree: string): Citation {
  if (!isAbsolute(citation.path)) return citation;
  const relative = relativeTo(citation.path, worktree);
  return relative ? { path: relative, ...(citation.line === undefined ? {} : { line: citation.line }) } : citation;
}

/**
 * Repo-relative display form of an absolute path, or null when it lies outside
 * the base. Symlinks are deliberately not resolved: this only formats a path for
 * display, and resolving would change the caller's prefix unexpectedly.
 */
export function relativeTo(path: string, base: string): string | null {
  const normalizedPath = path.split(sep).join("/").replace(/\/+$/, "");
  const normalizedBase = base.split(sep).join("/").replace(/\/+$/, "");
  if (!normalizedBase) return normalizedPath;
  if (normalizedPath === normalizedBase) return "";
  const prefix = `${normalizedBase}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : null;
}
