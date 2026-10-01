/**
 * Shared types for the local-first OpenCode memory plugin.
 *
 * The data model follows two established conventions:
 *  - scope separation (user / repository / session) as used by VS Code memories
 *  - citation-backed facts verified just-in-time as used by GitHub Copilot Memory
 */

export type Scope = "global" | "project" | "session";

export const SCOPES: readonly Scope[] = ["global", "project", "session"] as const;

export type MemoryKind =
  | "project-config"
  | "architecture"
  | "error-solution"
  | "preference"
  | "learned-pattern"
  | "conversation";

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "project-config",
  "architecture",
  "error-solution",
  "preference",
  "learned-pattern",
  "conversation",
] as const;

export interface Citation {
  /** Path relative to the project worktree root, or absolute. */
  path: string;
  /** 1-based line number. Optional: a whole-file citation is still valid. */
  line?: number;
}

export interface MemoryRecord {
  id: string;
  scope: Scope;
  /** Display form of the project identity, e.g. `repo_my-app__a1b2c3d4e5f6`. */
  repoKey: string;
  /**
   * Stable project identity: the hash alone, without the display name.
   *
   * Lookups use this rather than `repoKey` so renaming a repository, changing
   * the slug rules, or upgrading the plugin cannot orphan existing memories.
   */
  repoId: string;
  subject: string;
  fact: string;
  citations: Citation[];
  reason: string;
  kind: MemoryKind;
  createdAt: number;
  updatedAt: number;
  lastValidatedAt: number | null;
  useCount: number;
  expiresAt: number;
  needsReview: boolean;
}

export type VerificationState = "valid" | "partial" | "invalid";

export interface CitationCheck {
  citation: Citation;
  resolvedPath: string;
  exists: boolean;
  lineInRange: boolean | null;
  /** Fraction of the fact's significant tokens present on the cited line. 0 when unknown. */
  overlap: number;
}

export interface VerificationResult {
  state: VerificationState;
  checks: CitationCheck[];
  note: string;
}

export type RecallMode = "direct" | "advisory" | "off";

export interface MemoryConfig {
  enabled: boolean;
  recallMode: RecallMode;
  /** Hard ceiling for the whole injected memory block, in characters. */
  maxInjectChars: number;
  /** Upper bound on individual memories injected per session start. */
  maxMemoriesPerInject: number;
  /** Completed turns between automatic capture flushes. 0 disables auto flush. */
  captureEveryNTurns: number;
  expiryDays: number;
  compactionEnabled: boolean;
  redactPrivate: boolean;
  /** Automatically write a memory when the same file is edited repeatedly. */
  autoSaveRepeatedEdits: boolean;
  /** Max stored memories per scope; oldest unused entries are dropped past this. */
  maxMemoriesPerScope: number;
  keywordPatterns: string[];
}

export const DEFAULT_CONFIG: MemoryConfig = {
  enabled: true,
  recallMode: "direct",
  maxInjectChars: 4000,
  maxMemoriesPerInject: 5,
  captureEveryNTurns: 3,
  expiryDays: 28,
  compactionEnabled: true,
  redactPrivate: true,
  autoSaveRepeatedEdits: true,
  maxMemoriesPerScope: 500,
  keywordPatterns: [
    "remember",
    "don't forget",
    "dont forget",
    "do not forget",
    "save this",
    "note that",
    "keep in mind",
    "from now on",
  ],
};

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export const DAY_MS = 86_400_000;

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function isRecallMode(value: unknown): value is RecallMode {
  return value === "direct" || value === "advisory" || value === "off";
}
