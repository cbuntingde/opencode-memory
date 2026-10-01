import { readFileSync, statSync } from "node:fs";
import { resolveCitationPath } from "./scopes.ts";
import { tokenOverlap, tokenize } from "./text.ts";
import type { MemoryRecord, VerificationResult, CitationCheck } from "./types.ts";

/**
 * Just-in-time verification.
 *
 * Storing a fact is cheap; proving it is still true is the expensive part, and
 * that proof is only meaningful at the moment of use. Rather than curating
 * memories offline, each citation is re-checked against the working tree right
 * before the memory is injected:
 *
 *   valid   - every cited file exists and, where a line was given, that line
 *             still exists and is non-empty
 *   partial - the files exist but a cited line is out of range or blank, so the
 *             precise location may have drifted
 *   invalid - at least one cited file no longer exists
 *
 * Lexical overlap between the fact and the cited line is reported as a
 * diagnostic but deliberately does not decide validity: a fact is usually an
 * abstraction ("the API version must stay in sync") sitting on top of concrete
 * code, so demanding word-level agreement would reject correct citations.
 *
 * `invalid` memories are excluded from injection and flagged for review, which
 * is what stops a stale or adversarially planted fact from steering the agent.
 */

export interface VerifyDeps {
  readText(absPath: string): string | undefined;
}

export function defaultVerifyDeps(maxBytes = 512_000): VerifyDeps {
  return {
    readText(absPath: string): string | undefined {
      try {
        const stats = statSync(absPath);
        if (!stats.isFile()) return undefined;
        // Binary detection keeps us from loading images or bundles as text.
        if (stats.size > maxBytes) {
          const handle = readFileSync(absPath);
          if (handle.includes(0)) return undefined;
        }
        return readFileSync(absPath, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

export function verifyRecord(
  record: MemoryRecord,
  worktree: string,
  deps: VerifyDeps = defaultVerifyDeps(),
): VerificationResult {
  const checks: CitationCheck[] = [];
  const factTokens = tokenize(`${record.subject} ${record.fact}`);

  for (const citation of record.citations) {
    const resolvedPath = resolveCitationPath(citation, worktree);
    const text = deps.readText(resolvedPath);
    const exists = text !== undefined;

    let lineInRange: boolean | null = null;
    let overlap = 0;

    if (exists && citation.line !== undefined && text !== undefined) {
      const lines = text.split("\n");
      const line = lines[citation.line - 1];
      const present = typeof line === "string" && line.trim().length > 0;
      lineInRange = present;
      if (present && line) {
        overlap = tokenOverlap(factTokens, tokenize(line));
      }
    }

    checks.push({ citation, resolvedPath, exists, lineInRange, overlap });
  }

  const missing = checks.filter((check) => !check.exists);
  if (checks.length === 0 || missing.length > 0) {
    return {
      state: "invalid",
      checks,
      note:
        checks.length === 0
          ? "no citations recorded"
          : `${missing.length}/${checks.length} cited location(s) no longer exist`,
    };
  }

  const drifted = checks.filter((check) => check.lineInRange === false);
  if (drifted.length > 0) {
    return {
      state: "partial",
      checks,
      note: `${drifted.length}/${drifted.length === checks.length ? "" : `${checks.length} `}cited line(s) no longer exist; the file does`,
    };
  }

  const overlap = averageOverlap(checks);
  const suffix = overlap > 0 ? "" : " (cited line shares no wording with the fact)";
  return { state: "valid", checks, note: `all citations confirmed${suffix}` };
}

function averageOverlap(checks: CitationCheck[]): number {
  const scored = checks.filter((check) => check.overlap > 0 || check.lineInRange === true);
  if (scored.length === 0) return 0;
  return scored.reduce((sum, check) => sum + check.overlap, 0) / scored.length;
}

export interface VerifiedEntry {
  record: MemoryRecord;
  result: VerificationResult;
}

/**
 * Verifies a batch and persists the outcome: valid records have their
 * last-validated timestamp and expiry refreshed, invalid ones are flagged so
 * they stop being offered to the model.
 */
export function verifyAndRecord(
  entries: VerifiedEntry[],
  touch: (id: string, validated: boolean) => void,
  flag: (id: string, needsReview: boolean) => void,
): void {
  for (const { record, result } of entries) {
    if (result.state === "invalid") {
      flag(record.id, true);
      continue;
    }
    flag(record.id, false);
    if (result.state === "valid") touch(record.id, true);
  }
}

export function describeVerification(result: VerificationResult): string {
  return `[${result.state}] ${result.note}`;
}
