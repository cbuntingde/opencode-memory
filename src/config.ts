import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, isRecallMode, type Logger, type MemoryConfig } from "./types.ts";

/**
 * Configuration is layered: built-in defaults, then the user-wide file, then the
 * project file. Unknown keys are ignored and malformed values fall back to the
 * default rather than failing the session, because a typo in a config file must
 * never make OpenCode unstartable.
 */

export const CONFIG_FILENAMES = ["memory.jsonc", "memory.json"] as const;

export interface LoadConfigResult {
  config: MemoryConfig;
  /** Absolute paths of the files that were actually read. */
  sources: string[];
  warnings: string[];
}

export function parseJsonc(input: string): unknown {
  return JSON.parse(stripJsonComments(input));
}

/** Removes // and /* *\/ comments plus trailing commas, ignoring string contents. */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;
    const next = input[i + 1];

    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }

    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i += 1;
      } else if (char === "\n") {
        out += char;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (char === "\\") {
        const escaped = input[i + 1];
        if (escaped !== undefined) {
          out += escaped;
          i += 1;
        }
        continue;
      }
      if (char === quote) inString = false;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }

    out += char;
  }

  return removeTrailingCommas(out);
}

function removeTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;
    if (inString) {
      out += char;
      if (char === "\\") {
        const escaped = input[i + 1];
        if (escaped !== undefined) {
          out += escaped;
          i += 1;
        }
        continue;
      }
      if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }
    if (char === ",") {
      // Look ahead past whitespace for a closing brace or bracket.
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j] as string)) j += 1;
      const following = input[j];
      if (following === "}" || following === "]") continue;
    }
    out += char;
  }
  return out;
}

export async function loadConfig(
  globalDir: string,
  projectDir: string | undefined,
  logger?: Logger,
): Promise<LoadConfigResult> {
  const warnings: string[] = [];
  const sources: string[] = [];
  let merged: Record<string, unknown> = {};

  const layers: Array<{ dir: string | undefined; label: string }> = [
    { dir: globalDir, label: "global" },
    { dir: projectDir, label: "project" },
  ];

  for (const layer of layers) {
    if (!layer.dir) continue;
    for (const filename of CONFIG_FILENAMES) {
      const path = join(layer.dir, filename);
      try {
        const raw = await readFile(path, "utf8");
        const parsed = parseJsonc(raw) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          warnings.push(`${layer.label} config ${path} is not an object; ignored`);
          continue;
        }
        merged = { ...merged, ...(parsed as Record<string, unknown>) };
        sources.push(path);
      } catch {
        // Missing file is the normal case; only report unexpected parse issues.
      }
    }
  }

  const { config, warnings: validationWarnings } = validateConfig(merged, warnings);
  for (const warning of validationWarnings) {
    logger?.warn(warning);
  }

  return { config, sources, warnings: validationWarnings };
}

export function validateConfig(
  input: Record<string, unknown>,
  existing: string[] = [],
): { config: MemoryConfig; warnings: string[] } {
  const warnings = [...existing];
  const config: MemoryConfig = { ...DEFAULT_CONFIG, keywordPatterns: [...DEFAULT_CONFIG.keywordPatterns] };

  const writable = config as unknown as Record<string, unknown>;

  const bool = (key: keyof MemoryConfig, raw: unknown): void => {
    if (raw === undefined) return;
    if (typeof raw === "boolean") {
      writable[key] = raw;
      return;
    }
    warnings.push(`${String(key)} must be a boolean; using default`);
  };

  const int = (key: keyof MemoryConfig, raw: unknown, min: number, max: number): void => {
    if (raw === undefined) return;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const clamped = Math.min(max, Math.max(min, Math.floor(raw)));
      writable[key] = clamped;
      return;
    }
    warnings.push(`${String(key)} must be a number; using default`);
  };

  bool("enabled", input["enabled"]);
  bool("compactionEnabled", input["compactionEnabled"]);
  bool("redactPrivate", input["redactPrivate"]);
  bool("autoSaveRepeatedEdits", input["autoSaveRepeatedEdits"]);

  int("maxInjectChars", input["maxInjectChars"], 200, 100_000);
  int("maxMemoriesPerInject", input["maxMemoriesPerInject"], 1, 100);
  int("captureEveryNTurns", input["captureEveryNTurns"], 0, 1_000);
  int("expiryDays", input["expiryDays"], 1, 3_650);
  int("maxMemoriesPerScope", input["maxMemoriesPerScope"], 10, 100_000);

  const recallMode = input["recallMode"];
  if (recallMode !== undefined) {
    if (isRecallMode(recallMode)) {
      config.recallMode = recallMode;
    } else {
      warnings.push(`recallMode must be direct, advisory or off; using default`);
    }
  }

  const patterns = input["keywordPatterns"];
  if (patterns !== undefined) {
    if (Array.isArray(patterns) && patterns.every((item) => typeof item === "string")) {
      const cleaned = patterns
        .map((item) => String(item).trim().toLowerCase())
        .filter((item) => item.length > 0);
      // Always keep the built-in triggers so nudging never silently disappears.
      config.keywordPatterns = [...new Set([...DEFAULT_CONFIG.keywordPatterns, ...cleaned])];
    } else {
      warnings.push("keywordPatterns must be an array of strings; using default");
    }
  }

  return { config, warnings };
}
