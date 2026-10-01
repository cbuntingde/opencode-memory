import { tool } from "@opencode-ai/plugin";
import type { MemoryHub } from "./hub.ts";
import { MemoryService } from "./service.ts";
import { TOOL_NAMES, TOOL_SPECS, type ToolName } from "./tool-schema.ts";
import { z } from "zod";

/**
 * OpenCode v1 tool registration.
 *
 * v1 takes a Zod raw shape per tool and returns a plain string from `execute`.
 * The arguments mirror TOOL_SPECS exactly; `zodShapeFor` derives them so the two
 * generations cannot describe different tools.
 */

export interface ToolDeps {
  hub: MemoryHub;
  /** Session id of the calling turn, used when a tool context omits one. */
  sessionID?: string;
}

export type V1Tools = Record<ToolName, ReturnType<typeof tool>>;

/** Derives the Zod raw shape for one tool from its JSON Schema. */
export function zodShapeFor(name: ToolName): z.ZodRawShape {
  const spec = TOOL_SPECS[name];
  const properties = (spec.json.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set<string>((spec.json.required ?? []) as readonly string[]);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, property] of Object.entries(properties)) {
    const declared = property["description"];
    const description = spec.docs[key] ?? (typeof declared === "string" ? declared : key);
    const enumValues = property["enum"];
    const kind = property["type"];
    let field: z.ZodTypeAny;

    if (Array.isArray(enumValues) && enumValues.every((value) => typeof value === "string")) {
      field = z.enum(enumValues as [string, ...string[]]).describe(description);
    } else if (kind === "number") {
      field = z.number().describe(description);
    } else if (kind === "boolean") {
      field = z.boolean().describe(description);
    } else if (kind === "array") {
      field = z.array(z.string()).describe(description);
    } else {
      field = z.string().describe(description);
    }

    shape[key] = required.has(key) ? field : field.optional();
  }

  return shape as z.ZodRawShape;
}

export function createMemoryTools(deps: ToolDeps): V1Tools {
  const service = new MemoryService(deps.hub);
  const out = {} as V1Tools;

  for (const name of TOOL_NAMES) {
    const spec = TOOL_SPECS[name];
    const registered = tool({
      description: spec.description,
      args: zodShapeFor(name),
      async execute(args, context) {
        return service.call(name, {
          worktree: context.worktree || context.directory,
          sessionID: context.sessionID ?? deps.sessionID ?? "unknown",
          args: args as Record<string, unknown>,
        });
      },
    });
    (out as Record<string, unknown>)[name] = registered;
  }

  return out;
}
