import { describe, expect, test } from "bun:test";
import { parseCitation, parseCitations, formatCitation } from "../src/citation.ts";
import { redact, safeText } from "../src/redact.ts";

describe("parseCitation", () => {
  test("parses the shapes models actually emit", () => {
    expect(parseCitation("src/app.ts")).toEqual({ path: "src/app.ts" });
    expect(parseCitation("src/app.ts:42")).toEqual({ path: "src/app.ts", line: 42 });
    expect(parseCitation("src/app.ts#L42")).toEqual({ path: "src/app.ts", line: 42 });
    expect(parseCitation({ path: "src/app.ts", line: 7 })).toEqual({ path: "src/app.ts", line: 7 });
  });

  test("normalises separators, relative prefixes and whitespace", () => {
    expect(parseCitation("  ./src\\app.ts : 5 ")).toEqual({ path: "src/app.ts", line: 5 });
    expect(parseCitation("/src/app.ts")).toEqual({ path: "src/app.ts" });
  });

  test("rejects unusable input", () => {
    expect(parseCitation("")).toBeNull();
    expect(parseCitation("   ")).toBeNull();
    expect(parseCitation(42)).toBeNull();
    expect(parseCitation(null)).toBeNull();
    expect(parseCitation({ line: 3 })).toBeNull();
  });

  test("refuses to cite dotenv files", () => {
    expect(parseCitation(".env")).toBeNull();
    expect(parseCitation("config/.env.production")).toBeNull();
  });

  test("line numbers must be positive", () => {
    expect(parseCitation("src/app.ts:0")).toEqual({ path: "src/app.ts" });
    expect(parseCitation({ path: "a.ts", line: -2 })).toEqual({ path: "a.ts" });
  });
});

describe("parseCitations", () => {
  test("accepts arrays and single values, and deduplicates", () => {
    const citations = parseCitations(["src/a.ts:1", "src/a.ts:1", "src/b.ts", "  "]);
    expect(citations).toEqual([{ path: "src/a.ts", line: 1 }, { path: "src/b.ts" }]);
    expect(parseCitations("src/a.ts")).toEqual([{ path: "src/a.ts" }]);
  });

  test("round-trips through formatCitation", () => {
    const citation = parseCitation("src/a.ts:9")!;
    expect(formatCitation(citation)).toBe("src/a.ts:9");
    expect(formatCitation({ path: "src/a.ts" })).toBe("src/a.ts");
  });
});

describe("redact", () => {
  test("removes explicit private blocks", () => {
    const result = redact("public part <private>my salary is 100k</private> tail");
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("<private>[redacted]</private>");
    expect(result.text).not.toContain("100k");
    expect(result.text).toContain("public part");
    expect(result.rules).toContain("private-block");
  });

  test("handles multi-line private blocks and odd casing", () => {
    const result = redact("before\n<PRIVATE>\nline1\nline2\n</PRIVATE>\nafter");
    expect(result.text).not.toContain("line1");
    expect(result.text).toContain("before");
    expect(result.text).toContain("after");
  });

  test("masks common credential shapes", () => {
    const samples: Array<[string, string]> = [
      ["AKIAIOSFODNN7EXAMPLE", "aws-access-key"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123", "github-token"],
      ["github_pat_11ABCDEFG0abcdefghijklmnop", "github-pat"],
      ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "anthropic-key"],
      ["sk-proj-abcdefghijklmnopqrstuvwxyz", "openai-key"],
      ["AIzaSyA1234567890abcdefghijklmnopqrstuv", "google-api-key"],
      ["xoxb-123456789012-abcdefghijkl", "slack-token"],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456", "jwt"],
    ];
    for (const [secret, rule] of samples) {
      const result = redact(`token is ${secret} ok`);
      expect(result.text).not.toContain(secret);
      expect(result.rules).toContain(rule);
    }
  });

  test("keeps the key name so the line stays legible", () => {
    const result = redact('password: "hunter2000"');
    expect(result.text).toContain("password");
    expect(result.text).not.toContain("hunter2000");
  });

  test("masks env-style assignments", () => {
    const result = redact("DATABASE_URL=postgres://user:pw@host/db\nSAFE=1");
    expect(result.text).not.toContain("postgres://");
    expect(result.text).toContain("DATABASE_URL=");
  });

  test("masks bearer headers and PEM blocks", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz").text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----";
    expect(redact(pem).text).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  test("is a no-op when disabled or empty", () => {
    expect(redact("ghp_abcdefghijklmnopqrstuvwxyz0123", false).redacted).toBe(false);
    expect(redact("", true).redacted).toBe(false);
    expect(safeText("<private>x</private>", false)).toBe("<private>x</private>");
  });

  test("does not corrupt ordinary prose", () => {
    const text = "The build command is `bun run build` and tests use vitest.";
    expect(redact(text).text).toBe(text);
  });
});
