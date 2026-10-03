import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonc, stripJsonComments, validateConfig, loadConfig } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { silentLogger } from "../src/logger.ts";

const roots: string[] = [];

function makeDir(): string {
  const root = mkdtempSync(join(tmpdir(), "mem-config-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("stripJsonComments", () => {
  test("removes line and block comments", () => {
    expect(parseJsonc('{ // note\n "a": 1 /* inline */ }')).toEqual({ a: 1 });
  });

  test("keeps comment-like sequences inside strings", () => {
    expect(parseJsonc('{ "url": "https://example.com/a" }')).toEqual({ url: "https://example.com/a" });
    expect(parseJsonc('{ "note": "use /* this */ carefully" }')).toEqual({ note: "use /* this */ carefully" });
  });

  test("handles escaped quotes and trailing commas", () => {
    expect(parseJsonc('{ "a": "say \\"hi\\"", "b": 2, }')).toEqual({ a: 'say "hi"', b: 2 });
    expect(parseJsonc('[1, 2, ]')).toEqual([1, 2]);
    expect(stripJsonComments('{ /* a */ "k": "v" }')).toBe('{  "k": "v" }');
  });
});

describe("validateConfig", () => {
  test("uses defaults for an empty object", () => {
    const { config, warnings } = validateConfig({});
    expect(warnings).toEqual([]);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("accepts valid overrides", () => {
    const { config } = validateConfig({
      recallMode: "advisory",
      maxInjectChars: 9000,
      captureEveryNTurns: 0,
      expiryDays: 7,
      keywordPatterns: ["never forget this"],
    });
    expect(config.recallMode).toBe("advisory");
    expect(config.maxInjectChars).toBe(9000);
    expect(config.captureEveryNTurns).toBe(0);
    expect(config.expiryDays).toBe(7);
    expect(config.keywordPatterns).toContain("never forget this");
    // Built-in triggers survive a custom list.
    expect(config.keywordPatterns).toContain("remember");
  });

  test("falls back with a warning on malformed values", () => {
    const { config, warnings } = validateConfig({
      recallMode: "sometimes",
      maxInjectChars: "lots",
      enabled: "yes",
      keywordPatterns: [1, 2],
    });
    expect(config.recallMode).toBe(DEFAULT_CONFIG.recallMode);
    expect(config.maxInjectChars).toBe(DEFAULT_CONFIG.maxInjectChars);
    expect(config.enabled).toBe(DEFAULT_CONFIG.enabled);
    expect(warnings.length).toBe(4);
  });

  test("clamps out-of-range numbers", () => {
    const { config } = validateConfig({ maxInjectChars: 10, maxMemoriesPerInject: 9_999, expiryDays: 0 });
    expect(config.maxInjectChars).toBe(200);
    expect(config.maxMemoriesPerInject).toBe(100);
    expect(config.expiryDays).toBe(1);
  });
});

describe("loadConfig layering", () => {
  test("project file overrides the global file", async () => {
    const globalDir = makeDir();
    const projectDir = makeDir();
    writeFileSync(join(globalDir, "memory.jsonc"), '{ /* global */ "recallMode": "advisory", "expiryDays": 10 }', "utf8");
    writeFileSync(join(projectDir, "memory.jsonc"), '{ "recallMode": "off" }', "utf8");

    const { config, sources } = await loadConfig(globalDir, projectDir, silentLogger);
    expect(config.recallMode).toBe("off");
    expect(config.expiryDays).toBe(10);
    expect(sources.length).toBe(2);
  });

  test("missing files are normal and produce defaults", async () => {
    const { config, sources } = await loadConfig(makeDir(), makeDir(), silentLogger);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(sources).toEqual([]);
  });

  test("a non-object config file is reported, not fatal", async () => {
    const globalDir = makeDir();
    writeFileSync(join(globalDir, "memory.json"), "[1,2,3]", "utf8");
    const { config, warnings } = await loadConfig(globalDir, undefined, silentLogger);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings.length).toBe(1);
  });

  test("a malformed config file leaves defaults intact", async () => {
    const globalDir = makeDir();
    writeFileSync(join(globalDir, "memory.json"), "{ this is not json", "utf8");
    const { config } = await loadConfig(globalDir, undefined, silentLogger);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("a malformed config file warns instead of failing silently", async () => {
    const globalDir = makeDir();
    writeFileSync(join(globalDir, "memory.json"), "{ this is not json", "utf8");
    const { config, warnings } = await loadConfig(globalDir, undefined, silentLogger);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("could not be parsed");
  });
});
