import { memoryPluginV2 } from "./v2.ts";

/**
 * Combined entry point.
 *
 * OpenCode v2 reads `id` + `setup()` from the default export; OpenCode v1 (from
 * 1.18.29) reads `server()`. Spreading the v2 definition and adding `server` lets a
 * single package serve both generations, which is the shape the migration guide
 * documents. The two implementations share one memory core, so behaviour does not
 * fork between them - only the registration API does.
 *
 * Everything below is exported by name as well, so tests and embedders can drive
 * either generation directly without going through a live OpenCode process.
 */

export { memoryPluginV2 } from "./v2.ts";
export { createMemoryTools, zodShapeFor, type ToolDeps, type V1Tools } from "./tools.ts";
export { MemoryService, type ToolCall } from "./service.ts";
export { TOOL_NAMES, TOOL_SPECS, recommendedPermissions, type ToolName, type ToolSpec } from "./tool-schema.ts";
export { MemoryHub, defaultGlobalDir, type WorktreeContext } from "./hub.ts";
export { MemoryStore, parseMarkdown, renderMarkdown } from "./store.ts";
export { DEFAULT_CONFIG, MEMORY_KINDS, SCOPES, type MemoryConfig, type MemoryRecord, type Scope } from "./types.ts";

import { MemoryPlugin as memoryPluginV1 } from "./v1.ts";

export const MemoryPlugin = memoryPluginV1;

export default {
  ...memoryPluginV2,
  server: memoryPluginV1,
};
