---
name: opencode-plugin-authoring
description: Author, configure, and debug OpenCode plugins with correct v1 hook and v2 Plugin.define shapes.
---

# Opencode Plugin Authoring

Use when writing, fixing, or reviewing an OpenCode plugin (hooks, tools, commands, config).

## Pick the generation

- **v1** (`@opencode-ai/plugin`): module exports an async function `(ctx, options) => hooks`.
- **v2** (`@opencode/plugin`): module default-exports `Plugin.define({ id, setup(ctx) })`.
- Dual packages spread the v2 definition and add `server` for v1: `export default { ...v2def, server: v1fn }`.
- Match the host: v1 and v2 hook names differ; never mix them in one adapter.

## File layout and loading

- Project-local autoload: `.opencode/plugins/<name>.ts`.
- Global autoload: `~/.config/opencode/plugins/`.
- npm (v1): list packages in the config `plugin` array; Bun installs them (cache `~/.cache/opencode/node_modules/`).
- npm (v2): use the config `plugins` key: version pins, local paths, `file://` URLs, or `{ package, options }` (options arrive as `ctx.options`).
- Load order (v1): global config, project config, global dir, project dir.
- Commands (no code): `.opencode/commands/<name>.md` with frontmatter `description/agent/model` and a body template, invoked as `/name`; or a `command` map of `{ template, description, agent, model }`.

## v1 shape

Context: `ctx = { project, client, $, directory, worktree }`. Second parameter is package options.

```ts
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";

export const MyPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      my_greet: tool({
        description: "Greet a name.",
        args: { name: z.string().describe("Who to greet") },
        async execute(args, tctx) {
          return `Hello, ${args.name} (from ${tctx.worktree || tctx.directory})`;
        },
      }),
    },
    "tool.execute.after": async () => {
      // Observe only; never throw here.
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push("[my-plugin] extra instruction");
    },
  };
};
export default MyPlugin;
```

Rules: `tool()` takes `description` + Zod raw-shape `args` + `execute` returning a string; a plugin tool shadows a same-name builtin. Named hooks mutate `output` in place (`output.system`, `output.context`/`output.prompt` for `experimental.session.compacting`). Throwing in a `before` hook blocks the action; wrap observers and transforms in try/catch and fail open. Log via `ctx.client.app.log({ service, level, message, extra })` with level `debug/info/warn/error`.

Common v1 hooks/events: `tool.execute.before/after`, `chat.message`, `experimental.chat.system.transform`, `experimental.session.compacting`, `event` callback for `session.created/idle/compacted/deleted`, `permission.*`, `message.*`, `command.executed`, `shell.env`, `tui.*`.

## v2 shape

```ts
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "my-plugin",
  async setup(ctx) {
    const worktree = String(ctx.location.project.canonical ?? ctx.location.directory);
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "my_greet",
        description: "Greet a name.",
        input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        execute: async (input) => ({ content: `Hello, ${(input as { name: string }).name} (from ${worktree})` }),
      });
    });
    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: "[my-plugin] extra instruction" });
    });
    return () => {
      // Cleanup: abort subscriptions, close handles.
    };
  },
});
```

Rules: register via `ctx.tool.transform` / `ctx.session.hook("prompt"|"context"|"compaction")` / `ctx.tool.hook("execute.after")` / `ctx.event.subscribe({ signal })`. Tool `execute` returns `{ content: string }`. `setup` may return a cleanup function (replaces v1 `dispose`).

## Checklist before done

- Correct generation API, no v1/v2 name mixing.
- Tools: single source of truth for schema (JSON Schema or Zod-derived, not two hand copies).
- Every observer/transform is try/catch fail-open; only intentional `before` guards throw.
- No secrets logged; paths repo-relative unless the API needs absolute.
- Verified with `bun run typecheck` and a smoke run loading the plugin entry.
