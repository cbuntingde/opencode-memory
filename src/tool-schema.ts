import { MEMORY_KINDS, SCOPES } from "./types.ts";

/**
 * One source of truth for the agent-facing tools.
 *
 * OpenCode v1 registers tools with a Zod raw shape and OpenCode v2 with JSON
 * Schema, so both descriptions and argument shapes are declared here and derived
 * per generation. Keeping them together is what stops the two adapters from
 * drifting into offering the agent different capabilities.
 */

export const TOOL_NAMES = [
  "memory_recall",
  "memory_add",
  "memory_search",
  "memory_list",
  "memory_forget",
  "memory_profile",
  "memory_rebind",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Minimal JSON Schema shape for tool inputs; local so no schema library is needed. */
type Json = {
  type?: string;
  description?: string;
  properties?: Record<string, Json>;
  required?: readonly string[];
  additionalProperties?: boolean;
  enum?: readonly string[];
  items?: Json;
};

const scopeWithAll = [...SCOPES, "all"] as unknown as [string, ...string[]];
const scopeOnly = [...SCOPES] as unknown as [string, ...string[]];
const kinds = [...MEMORY_KINDS] as unknown as [string, ...string[]];

export interface ToolSpec {
  name: ToolName;
  description: string;
  /** True when the tool only reads; used for the recommended permission rule. */
  readOnly: boolean;
  json: Json;
  /** Argument descriptions, keyed the same as `json.properties`. */
  docs: Record<string, string>;
}

function schema(
  properties: Record<string, Json>,
  required: string[],
): Json {
  return { type: "object", properties, required, additionalProperties: false };
}

function str(description: string, enumValues?: readonly string[]): Json {
  return enumValues
    ? ({ type: "string", description, enum: [...enumValues] } as Json)
    : ({ type: "string", description } as Json);
}

function num(description: string): Json {
  return { type: "number", description } as Json;
}

function bool(description: string): Json {
  return { type: "boolean", description } as Json;
}

function arr(description: string, items: Json): Json {
  return { type: "array", description, items } as Json;
}

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  memory_recall: {
    name: "memory_recall",
    readOnly: true,
    description:
      "Search persistent memory across scopes and report whether each fact is still supported by its cited code. Read-only; safe to call freely.",
    docs: {
      query: "What you want to remember, in natural language.",
      scope: "Limit the search. Default: project plus global plus session.",
      limit: "Maximum facts to return (default 8).",
    },
    json: schema(
      {
        query: str("What you want to remember, in natural language."),
        scope: str("Limit the search. Default: project plus global plus session.", scopeWithAll),
        limit: num("Maximum facts to return (default 8)."),
      },
      ["query"],
    ),
  },

  memory_add: {
    name: "memory_add",
    readOnly: false,
    description:
      "Record one durable fact. Requires at least one code citation for global or project scope so the fact can be re-verified later. Prefer few high-value facts over many.",
    docs: {
      subject: "Short label, e.g. 'Build command'.",
      fact: "The fact itself, stated in one or two sentences.",
      citations: 'Evidence as repo-relative paths, optionally with a line: "src/app.ts:42".',
      reason: "Why this matters later, so a future reader can judge whether it is still true.",
      scope: "Default: project.",
      kind: "Default: learned-pattern.",
    },
    json: schema(
      {
        subject: str("Short label, e.g. 'Build command'."),
        fact: str("The fact itself, stated in one or two sentences."),
        citations: arr(
          'Evidence as repo-relative paths, optionally with a line: "src/app.ts:42".',
          { type: "string" } as Json,
        ),
        reason: str("Why this matters later, so a future reader can judge whether it is still true."),
        scope: str("Default: project.", scopeOnly),
        kind: str("Default: learned-pattern.", kinds),
      },
      ["subject", "fact", "citations"],
    ),
  },

  memory_search: {
    name: "memory_search",
    readOnly: true,
    description: "Keyword search over stored memory. Read-only. Returns ranked facts with their citations.",
    docs: {
      query: "Keywords or a phrase.",
      scope: "Default: project.",
      limit: "Maximum results (default 10).",
    },
    json: schema(
      {
        query: str("Keywords or a phrase."),
        scope: str("Default: project.", scopeWithAll),
        limit: num("Maximum results (default 10)."),
      },
      ["query"],
    ),
  },

  memory_list: {
    name: "memory_list",
    readOnly: true,
    description: "List stored memory for a scope, newest first. Read-only.",
    docs: {
      scope: "Default: project.",
      limit: "Maximum entries (default 20).",
      kind: "Filter by kind.",
      includeReview: "Include facts flagged for review (default false).",
    },
    json: schema(
      {
        scope: str("Default: project.", scopeWithAll),
        limit: num("Maximum entries (default 20)."),
        kind: str("Filter by kind.", kinds),
        includeReview: bool("Include facts flagged for review (default false)."),
      },
      [],
    ),
  },

  memory_forget: {
    name: "memory_forget",
    readOnly: false,
    description: "Delete one stored memory by id, or every memory in a scope. Use when a fact is wrong or obsolete.",
    docs: {
      memoryId: "Id to delete. Omit together with all=true to clear a scope.",
      scope: "Default: project.",
      all: "Delete every memory in the chosen scope.",
    },
    json: schema(
      {
        memoryId: str("Id to delete. Omit together with all=true to clear a scope."),
        scope: str("Default: project.", scopeOnly),
        all: bool("Delete every memory in the chosen scope."),
      },
      [],
    ),
  },

  memory_profile: {
    name: "memory_profile",
    readOnly: true,
    description:
      "Show the user-wide preferences that travel across every project. Read-only. Use before assuming a personal style or workflow.",
    docs: {
      query: "Optional filter over preference text.",
    },
    json: schema({ query: str("Optional filter over preference text.") }, []),
  },

  memory_rebind: {
    name: "memory_rebind",
    readOnly: false,
    description:
      "List or adopt stored memories that belong to this repository but sit under a different project identity (the repo moved, or its origin remote changed). Read `memory_rebind` with no arguments first; pass fromRepoId only to confirm.",
    docs: {
      fromRepoId: "Identity to adopt, as reported by memory_rebind with no arguments. Omit to list candidates.",
      dryRun: "Preview without moving anything (default true when fromRepoId is given).",
    },
    json: schema(
      {
        fromRepoId: str("Identity to adopt, as reported by memory_rebind with no arguments. Omit to list candidates."),
        dryRun: bool("Preview without moving anything (default true when fromRepoId is given)."),
      },
      [],
    ),
  },
};

/** Suggested permission block: reads are auto-approved, writes require approval. */
export function recommendedPermissions(): Array<{ action: string; resource: string; effect: string }> {
  return TOOL_NAMES.map((name) => ({
    action: name,
    resource: "*",
    effect: TOOL_SPECS[name].readOnly ? "allow" : "ask",
  }));
}
