/** Small text helpers shared by the store, the verifier and the injector. */

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "when",
  "then",
  "than",
  "they",
  "them",
  "there",
  "these",
  "those",
  "have",
  "has",
  "had",
  "was",
  "were",
  "been",
  "being",
  "are",
  "but",
  "not",
  "you",
  "our",
  "its",
  "it's",
  "use",
  "used",
  "using",
  "must",
  "should",
  "can",
  "may",
  "will",
  "would",
  "could",
  "does",
  "done",
  "also",
  "only",
  "over",
  "such",
  "some",
  "each",
  "any",
  "all",
  "how",
  "what",
  "where",
  "which",
  "about",
  "get",
  "set",
  "let",
]);

/**
 * Lowercased tokens of at least three characters, stopwords removed.
 *
 * Identifiers are also split on `_`, `-`, `.` and camelCase boundaries, so
 * `API_VERSION` yields `api_version`, `api` and `version`. Without this, a fact
 * written in prose ("the API version must match") would score zero overlap
 * against code that spells the same idea as a constant name.
 *
 * Used both for keyword ranking and for citation overlap scoring.
 */
export function tokenize(input: string): string[] {
  if (!input) return [];
  const out: string[] = [];

  // Split on characters that cannot appear inside an identifier. Case is kept
  // here because camelCase boundaries are still needed further down.
  for (const chunk of input.split(/[^A-Za-z0-9_$.-]+/)) {
    const base = chunk.replace(/^[.\-_$]+|[.\-_$]+$/g, "");
    if (base.length === 0) continue;

    const words = base
      .split(/[.\-_$]+/)
      .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    // The whole identifier, so exact-name lookups still rank first.
    const whole = base.toLowerCase();
    if (whole.length >= 3 && !STOPWORDS.has(whole)) out.push(whole);

    for (const word of words) {
      const token = word.toLowerCase();
      if (token.length < 3 || STOPWORDS.has(token) || token === whole) continue;
      out.push(token);
    }
  }

  return [...new Set(out)];
}

/** Fraction of `source` tokens that also appear in `target`. 0 when source is empty. */
export function tokenOverlap(source: string[], target: string[]): number {
  if (source.length === 0) return 0;
  const targetSet = new Set(target);
  let hits = 0;
  for (const token of source) {
    if (targetSet.has(token)) hits += 1;
  }
  return hits / source.length;
}

export function truncateChars(input: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (input.length <= maxChars) return input;
  if (maxChars <= 3) return input.slice(0, maxChars);
  return `${input.slice(0, maxChars - 3)}...`;
}

/** Truncates to whole lines so injected blocks never end mid-sentence. */
export function truncateLines(input: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (input.length <= maxChars) return input;
  const kept: string[] = [];
  let used = 0;
  for (const line of input.split("\n")) {
    const cost = line.length + 1;
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }
  return kept.length > 0 ? kept.join("\n") : truncateChars(input, maxChars);
}

export function isoDate(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "unknown";
  return new Date(epochMs).toISOString().slice(0, 10);
}
