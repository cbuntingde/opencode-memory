import type { Citation } from "./types.ts";

/**
 * Citations are accepted from the model in several shapes. Normalising them in
 * one place keeps the store, the verifier and the tools consistent.
 *
 * Accepted inputs:
 *   "src/app.ts"            -> { path: "src/app.ts" }
 *   "src/app.ts:42"         -> { path: "src/app.ts", line: 42 }
 *   "src/app.ts#L42"        -> { path: "src/app.ts", line: 42 }
 *   { path, line }          -> passthrough
 */

const LINE_SUFFIX = /[:#]\s*[Ll]?([0-9]{1,9})$/;

export function parseCitation(input: unknown): Citation | null {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    const rawPath = record["path"];
    if (typeof rawPath !== "string") return null;
    const path = normalizeCitationPath(rawPath);
    if (!path) return null;
    const rawLine = record["line"];
    const line = typeof rawLine === "number" && Number.isFinite(rawLine) ? Math.floor(rawLine) : undefined;
    return withValidLine(path, line);
  }

  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const match = LINE_SUFFIX.exec(trimmed);
  if (!match) {
    const path = normalizeCitationPath(trimmed);
    return path ? { path } : null;
  }

  const path = normalizeCitationPath(trimmed.slice(0, match.index));
  if (!path) return null;
  const line = Number.parseInt(match[1] as string, 10);
  return withValidLine(path, line);
}

export function parseCitations(input: unknown): Citation[] {
  const out: Citation[] = [];
  const push = (value: unknown) => {
    const citation = parseCitation(value);
    if (citation) out.push(citation);
  };

  if (Array.isArray(input)) {
    for (const item of input) push(item);
  } else {
    push(input);
  }

  // Deduplicate on path+line so repeated evidence is stored once.
  const seen = new Set<string>();
  const unique: Citation[] = [];
  for (const citation of out) {
    const key = citationKey(citation);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(citation);
  }
  return unique;
}

export function formatCitation(citation: Citation): string {
  return citation.line === undefined ? citation.path : `${citation.path}:${citation.line}`;
}

export function citationKey(citation: Citation): string {
  return `${citation.path}#${citation.line ?? 0}`;
}

function withValidLine(path: string, line: number | undefined): Citation {
  if (line !== undefined && Number.isFinite(line) && line >= 1) {
    return { path, line };
  }
  return { path };
}

function normalizeCitationPath(raw: string): string | null {
  // Models frequently emit Windows separators or leading ./ noise.
  let value = raw.trim().replace(/\\/g, "/");
  if (!value) return null;
  while (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/^\/+/, "");
  // Drop the ./:12 style suffix that survives a bare-path call.
  value = value.replace(LINE_SUFFIX, "");
  if (!value) return null;
  // Reject obvious placeholder / private paths outright.
  if (/(^|\/)\.env(\.|$)/i.test(value)) return null;
  // No parent escapes: a citation must stay inside the worktree it is read from.
  if (value.split("/").includes("..")) return null;
  return value;
}
