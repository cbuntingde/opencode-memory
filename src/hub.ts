import { CaptureQueue } from "./capture.ts";
import { Injector } from "./inject.ts";
import { SessionStore } from "./session-store.ts";
import { MemoryStore, generateMemoryId } from "./store.ts";
import { cachedGitProbe, type GitProbe } from "./git.ts";
import { GLOBAL_REPO_ID, resolveScopes, type ScopeResolution } from "./scopes.ts";
import type { VerifyDeps } from "./verify.ts";
import type { Logger, MemoryConfig, Scope } from "./types.ts";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Owns every store for the process and hands out per-worktree contexts.
 *
 * OpenCode can be pointed at a different directory per session, so nothing here
 * is resolved once at import time: a worktree key is computed on demand and the
 * resulting stores are cached for reuse.
 */

export interface HubOptions {
  globalDir?: string;
  config: MemoryConfig;
  logger: Logger;
  git?: GitProbe;
  verifyDeps?: VerifyDeps;
  now?: () => number;
  generateId?: () => string;
  cacheTtlMs?: number;
}

export interface WorktreeContext {
  worktree: string;
  scopes: ScopeResolution;
  global: MemoryStore;
  project: MemoryStore;
  injector: Injector;
  capture: CaptureQueue;
  sessions: Map<string, SessionStore>;
}

export function defaultGlobalDir(): string {
  const fromEnv = process.env["OPENCODE_CONFIG_DIR"];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.trim().length > 0) return join(xdg, "opencode");
  return join(homedir(), ".config", "opencode");
}

export function resolveScopeStore(
  context: WorktreeContext,
  scope: Scope,
  sessionID?: string,
  config?: MemoryConfig,
): MemoryStore | SessionStore | null {
  if (scope === "global") return context.global;
  if (scope === "project") return context.project;
  if (!sessionID) return null;
  if (!config) return context.sessions.get(sessionID) ?? null;
  return sessionStoreFor(context, sessionID, config);
}

export function sessionStoreFor(context: WorktreeContext, sessionID: string, config: MemoryConfig): SessionStore {
  const existing = context.sessions.get(sessionID);
  if (existing) return existing;
  const created = new SessionStore({
    sessionID,
    expiryDays: config.expiryDays,
    maxMemoriesPerScope: config.maxMemoriesPerScope,
  });
  context.sessions.set(sessionID, created);
  // The injector needs the session store to surface working notes in context.
  context.injector.setSessionStore(created);
  return created;
}

export class MemoryHub {
  readonly config: MemoryConfig;
  readonly globalDir: string;
  private readonly logger: Logger;
  private readonly git: GitProbe;
  private readonly verifyDeps: VerifyDeps | undefined;
  private readonly now: (() => number) | undefined;
  private readonly generateId: (() => string) | undefined;
  private readonly cacheTtlMs: number | undefined;
  private readonly contexts = new Map<string, WorktreeContext>();
  private readonly reportedUnreachable = new Set<string>();

  constructor(options: HubOptions) {
    this.config = options.config;
    this.globalDir = options.globalDir ?? defaultGlobalDir();
    this.logger = options.logger;
    this.git = options.git ?? cachedGitProbe();
    this.verifyDeps = options.verifyDeps;
    this.now = options.now;
    this.generateId = options.generateId ?? generateMemoryId;
    this.cacheTtlMs = options.cacheTtlMs;
  }

  contextFor(worktree: string): WorktreeContext {
    const key = worktree;
    const existing = this.contexts.get(key);
    if (existing) return existing;

    const scopes = resolveScopes(this.globalDir, worktree, this.git);

    const makeStore = (dir: string, scope: Scope, repoKey: string, repoId: string): MemoryStore =>
      new MemoryStore({
        dir,
        scope,
        repoKey,
        repoId,
        expiryDays: this.config.expiryDays,
        maxMemoriesPerScope: this.config.maxMemoriesPerScope,
        logger: this.logger,
        ...(this.now ? { now: this.now } : {}),
        ...(this.generateId ? { generateId: this.generateId } : {}),
      });

    const global = makeStore(join(this.globalDir, "memory"), "global", "user", GLOBAL_REPO_ID);
    const project = makeStore(scopes.projectDir, "project", scopes.repoKey, scopes.repoId);

    const injector = new Injector({
      config: this.config,
      globalStore: global,
      projectStore: project,
      sessionStore: null,
      worktree,
      ...(this.verifyDeps ? { verifyDeps: this.verifyDeps } : {}),
      logger: this.logger,
      ...(this.now ? { now: this.now } : {}),
      ...(this.cacheTtlMs !== undefined ? { cacheTtlMs: this.cacheTtlMs } : {}),
    });

    const context: WorktreeContext = {
      worktree,
      scopes,
      global,
      project,
      injector,
      capture: new CaptureQueue(),
      sessions: new Map(),
    };

    this.contexts.set(key, context);
    this.reportUnreachable(context);
    return context;
  }

  /**
   * Warns once per worktree when the store holds rows under a different repo key.
   * Silently showing an empty store after a rename or an upgrade would read as
   * data loss, so it is reported explicitly.
   */
  private reportUnreachable(context: WorktreeContext): void {
    if (this.reportedUnreachable.has(context.worktree)) return;
    try {
      if (context.project.count() > 0) {
        this.reportedUnreachable.add(context.worktree);
        return;
      }
      const foreign = context.project.foreignIdentities();
      if (foreign.length === 0) return;
      this.reportedUnreachable.add(context.worktree);
      this.logger.warn("stored memories exist under a different project identity", {
        currentRepoId: context.scopes.repoId,
        currentRepoKey: context.scopes.repoKey,
        found: foreign,
        hint: "This project looks like it moved or changed its origin remote. Run `memory_rebind` (or /memory rebind) to adopt them.",
      });
    } catch (error) {
      this.logger.debug("unreachable-memory check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Lets a caller clear the once-per-worktree unreachable warning. */
  resetDiagnostics(worktree?: string): void {
    if (worktree) this.reportedUnreachable.delete(worktree);
    else this.reportedUnreachable.clear();
  }

  /** Expires unused memories across every store touched this process. */
  sweepAll(): number {
    let removed = 0;
    for (const context of this.contexts.values()) {
      try {
        removed += context.global.sweepExpired();
        removed += context.project.sweepExpired();
      } catch (error) {
        this.logger.warn("expiry sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return removed;
  }

  stats(): { global: number; project: number; sessions: number; worktrees: number } {
    let global = 0;
    let project = 0;
    let sessions = 0;
    for (const context of this.contexts.values()) {
      try {
        global += context.global.count();
        project += context.project.count();
      } catch {
        /* a broken store should not break stats */
      }
      sessions += context.sessions.size;
    }
    return { global, project, sessions, worktrees: this.contexts.size };
  }

  releaseSession(worktree: string, sessionID: string): void {
    const context = this.contexts.get(worktree);
    if (!context) return;
    const store = context.sessions.get(sessionID);
    store?.forgetAll();
    context.sessions.delete(sessionID);
    context.capture.clear(sessionID);
    context.injector.invalidate();
  }

  close(): void {
    for (const context of this.contexts.values()) {
      try {
        context.global.close();
        context.project.close();
        for (const session of context.sessions.values()) session.close();
      } catch (error) {
        this.logger.debug("store close failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.contexts.clear();
  }
}
