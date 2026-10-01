/**
 * Redaction applied before anything is written to disk or injected into a prompt.
 *
 * Two independent passes:
 *  1. explicit private blocks the author wrapped in <private>...</private>
 *  2. secret-shaped tokens recognised by pattern
 *
 * Redaction is deliberately aggressive on capture: losing a line of context is
 * cheap, leaking a credential into a long-lived memory file is not.
 */

export interface RedactionResult {
  text: string;
  /** True when at least one rule fired. */
  redacted: boolean;
  /** Names of the rules that fired, for logging. */
  rules: string[];
}

const PRIVATE_BLOCK = /<private>([\s\S]*?)<\/private>/gi;

interface SecretRule {
  name: string;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const SECRET_RULES: SecretRule[] = [
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => "<redacted:aws-key>",
  },
  {
    name: "github-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    replace: () => "<redacted:github-token>",
  },
  {
    name: "github-pat",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replace: () => "<redacted:github-pat>",
  },
  {
    // Anthropic keys are checked before the generic OpenAI pattern, which would
    // otherwise match `sk-ant-...` first and mislabel the rule.
    name: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
    replace: () => "<redacted:api-key>",
  },
  {
    name: "openai-key",
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g,
    replace: () => "<redacted:api-key>",
  },
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replace: () => "<redacted:google-key>",
  },
  {
    name: "slack-token",
    pattern: /\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => "<redacted:slack-token>",
  },
  {
    name: "bearer-token",
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
    replace: () => "Bearer <redacted:bearer>",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => "<redacted:jwt>",
  },
  {
    name: "assigned-secret",
    pattern:
      /\b((?:api[_-]?key|secret|passwd|password|token|private[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)(["']?)([^\s"',;]{6,})(["']?)/gi,
    replace: (match: string, prefix = "", openQuote = "", value = "", closeQuote = "") => {
      // `prefix` keeps the original key and separator so the line stays readable.
      const trailing = closeQuote && closeQuote === openQuote ? closeQuote : "";
      void match;
      void value;
      return `${prefix}${openQuote}<redacted:secret>${trailing}`;
    },
  },
  {
    name: "pem-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => "<redacted:private-key>",
  },
  {
    name: "env-file",
    pattern: /^[ \t]*[A-Z][A-Z0-9_]{2,}[ \t]*=[^\n]*$/gm,
    replace: (match: string) => {
      const eq = match.indexOf("=");
      if (eq === -1) return match;
      return `${match.slice(0, eq + 1)}<redacted:env-value>`;
    },
  },
];

const REDACTED_PRIVATE = "<private>[redacted]</private>";

export function redact(input: string, enabled = true): RedactionResult {
  if (!enabled || !input) return { text: input, redacted: false, rules: [] };

  const fired = new Set<string>();
  let text = input;

  text = text.replace(PRIVATE_BLOCK, () => {
    fired.add("private-block");
    return REDACTED_PRIVATE;
  });

  for (const rule of SECRET_RULES) {
    // A fresh lastIndex per pass keeps the shared module-level patterns stateless.
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (match, ...rest: string[]) => {
      fired.add(rule.name);
      return rule.replace(match, ...rest);
    });
  }

  const rules = [...fired];
  return { text, redacted: rules.length > 0, rules };
}

/** Convenience wrapper for callers that do not care whether anything changed. */
export function safeText(input: string, enabled = true): string {
  return redact(input, enabled).text;
}
