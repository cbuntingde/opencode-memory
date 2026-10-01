# IMPLEMENTATION_PLAN.md — Local-First Memory Plugin for OpenCode

## 0. Goal and Non-Goals

**Goal:** a local-first OpenCode plugin that persists user preferences, project facts, and session notes across restarts, injects them with citations, verifies them just-in-time, and survives compaction — no SaaS required.

**Non-goals for v1:** vector embeddings, cross-machine sync, hosted API, auto-learning without approval. Those are v2 behind flags.

References the research synthesis in `opencode-memory-plugin-plan.md`.

## 1. Architecture

```
opencode-memory/
  package.json            # name: opencode-memory, type: module
  tsconfig.json
  src/
    index.ts              # Plugin entry, exports MemoryPlugin: Plugin
    config.ts             # load + validate config
    scopes.ts             # global / project / session resolution + repo hash
    store.ts              # Markdown + SQLite persistence
    verify.ts             # citation check + expiry
    inject.ts             # session-start + recall formatting, budgets
    capture.ts            # tool.execute.after observer, keyword nudge
    redact.ts             # <private> + .env/secret redaction
    tools.ts              # memory_add/search/list/forget/profile/help + memory_recall (read-only)
  test/
    scopes.test.ts store.test.ts verify.test.ts redact.test.ts tools.test.ts
  .opencode/plugins/     # local dev install symlink or copy for dogfooding
```

Runtime: Bun + TypeScript. Deps: `@opencode-ai/plugin`, `zod` (via tool.schema), `bun:sqlite` (built-in, no native dep). No network calls in v1.

Plugin entry shape (per `opencode.ai/docs/plugins`):

```ts
import type { Plugin } from "@opencode-ai/plugin";
export const MemoryPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  return {
    "session.created": async (input, output) => {},
    "tool.execute.after": async (input, output) => {},
    "experimental.session.compacting": async (input, output) => {},
    "session.deleted": async (input, output) => {},
    tool: { /* registered tools */ },
  };
};
```

## 2. Data Model

### 2.1 Memory record (SQLite row + Markdown source of truth)

```sql
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('global','project','session')),
  repo_key TEXT NOT NULL,          -- global: 'user'; project: repo_{name}__{hash}; session: session id
  subject TEXT NOT NULL,
  fact TEXT NOT NULL,
  citations TEXT NOT NULL,         -- JSON array: ["src/auth.ts:42","docs/api.md:10"]
  reason TEXT DEFAULT '',
  kind TEXT DEFAULT 'learned-pattern', -- project-config|architecture|error-solution|preference|learned-pattern|conversation
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_validated_at INTEGER,
  use_count INTEGER DEFAULT 0,
  expires_at INTEGER               -- default created + 28d, refresh on verified use
);
CREATE INDEX idx_scope_repo ON memories(scope, repo_key, updated_at DESC);
```

Markdown mirror for auditability:

- Global: `~/.config/opencode/memory/global.md`
- Project: `<project>/.opencode/memory/project.md` + `index.db` (SQLite next to it)
- Session: in-memory + `<project>/.opencode/memory/session-<id>.md` (deleted on session end)

Markdown entry format:

```md
## [m_01HXYZ] subject
- Scope: project | Repo: repo_myapp__a1b2c3
- Fact: API version must match in client, server, docs.
- Citations: src/client/sdk/constants.ts:12, server/routes/api.go:8
- Reason: mismatch breaks integration.
- Kind: architecture | Updated: 2026-10-01 | Uses: 3
```

### 2.2 Scope resolution (`scopes.ts`)

- `global`: always `~/.config/opencode/memory/`.
- `project`: normalize `git remote get-url origin` (lowercase, strip `.git`, `git@` → `https://`), else `realpath(worktree)`. `repo_key = repo_{basename}__{sha1(normalized).slice(0,12)}`.
- `session`: from `sessionID` in tool/hook context; never persisted beyond `session.deleted`.
- Project memories never load outside their `repo_key`.

### 2.3 Config (`memory.jsonc`)

```jsonc
{
  // ~/.config/opencode/memory.jsonc (global defaults) or .opencode/memory.jsonc (project overrides)
  "enabled": true,
  "recallMode": "direct",       // direct | advisory | off
  "maxInjectChars": 4000,
  "maxMemoriesPerInject": 5,
  "captureEveryNTurns": 3,
  "expiryDays": 28,
  "compactionEnabled": true,
  "redactPrivate": true,
  "keywordPatterns": ["remember", "don't forget", "save this"]
}
```

Project file overrides global. All fields optional with the defaults above.

## 3. Hook and Tool Wiring

### 3.1 Hooks

**`session.created` — inject.**
Load global profile (first ~200 lines equivalent, capped by `maxInjectChars/3`) + top 5 recent project memories ordered by `updated_at DESC`. Format:

```
[MEMORY profile]
- prefers tabs, single quotes
[MEMORY project repo_myapp__a1b2 (verified 2026-09-28)]
- [m_abc] Build: bun run build (src/package.json:8)
```

Fail open: on storage error, inject nothing and log via `client.app.log`.

**`tool.execute.after` — observe, never block.**
If tool in (`edit`, `write`, `apply_patch`, `bash`) and turn counter hits `captureEveryNTurns`, stage a capture candidate (diff summary + file paths as proposed citations). Do not auto-write; set a pending nudge the model can flush via `memory_add`, or auto-write only when `recallMode=direct` and confidence heuristic passes (edit to same files ≥2 times). Always redact before staging (see §4).

**`experimental.session.compacting` — preserve.**
Push project memories + current task status into `output.context`. After compaction (`session.compacted` if available, else next `session.created` with parent ID), store the summary as a `kind=conversation` memory with citations to active files.

**`session.deleted` / shutdown — flush.**
Write pending turn batch. Delete session file.

### 3.2 Tools (`tools.ts`)

| Tool | Args | Permission |
|---|---|---|
| `memory_recall` (read-only) | `query: string, scope?: global\|project\|session, limit?: number` | auto-allow |
| `memory_add` | `subject, fact, citations: string[], reason?, scope?, kind?` | ask under strict configs |
| `memory_search` | `query, scope?, limit?` | auto-allow |
| `memory_list` | `scope?, limit?` | auto-allow |
| `memory_forget` | `memoryId, scope?` | ask |
| `memory_profile` | `query?` | auto-allow |

`memory_add` validation: `fact` non-empty, ≥1 citation with `path[:line]` form, path exists relative to worktree (warn, don't fail, if deleted — marks for verification). `memory_recall`/`memory_search` v1: keyword + recency ranking (`use_count`, `updated_at`); embeddings deferred.

Suggested `opencode.json` permission starter:

```json
{ "permission": { "memory_recall": "allow", "memory_search": "allow", "memory_list": "allow", "memory_add": "ask", "memory_forget": "ask" } }
```

## 4. Privacy, Verification, Redaction

- **Redaction (`redact.ts`):** strip `<private>...</private>` blocks, `.env` values, `AKIA|ghp_|sk-` style secrets before capture/injection. Unit-tested.
- **Verification (`verify.ts`):** before injecting a project memory, check each citation file exists and cited line range still contains a keyword overlap with the fact (v1 heuristic: file exists + non-empty + optional line-content fuzzy match). If all citations invalid → exclude and mark `needs_review`. If partially valid → inject with `(partially verified)` tag. On verified use → bump `use_count`, `last_validated_at`, extend `expires_at`.
- **Expiry job:** on `session.created`, delete rows where `expires_at < now` and `use_count = 0` or untouched for `expiryDays`. Default 28d per Copilot retention.
- **Isolation:** global tools never return project facts from another `repo_key`. Log scope + repo_key on every read/write.

## 5. Build Phases

### Phase 0 — Scaffold (0.5d)
Tasks: `bun init`, deps, tsconfig, `src/index.ts` stub returning empty hooks, `bun test` green, local install to `.opencode/plugins/` for dogfooding.
Accept: `opencode` starts with plugin loaded, no errors.

### Phase 1 — Storage + Scopes + Tools (2d)
Tasks: implement `scopes.ts`, `store.ts` (CRUD + SQLite + Markdown mirror), `redact.ts`, `config.ts`; register 6 tools with Zod schemas.
Accept: add → list → search → forget round-trips via agent; scope isolation test passes; redaction test passes.

### Phase 2 — Injection + Capture + Compaction (2d)
Tasks: `inject.ts` with char budgets + dedup per session; `capture.ts` turn counter + keyword nudge; compaction hook; `session.deleted` flush.
Accept: restart retains facts; compaction summary saved; short prompts skip recall; 3s fail-open (no blocking on DB lock).

### Phase 3 — Verification + Expiry + Management (1.5d)
Tasks: `verify.ts` checks; expiry sweep; `/memory` command docs; status footer line (`◪ memory: N recalled / M saved`).
Accept: adversarial test (seed false fact with bad citation → excluded on next session); 28d expiry test with fake clock.

### Phase 4 — Hardening + Release (1d)
Tasks: permission docs, `README`, `opencode.json` examples, CI (`bun test`, `tsc --noEmit`), npm publish as `opencode-memory-local`.
Accept: fresh-project install works from npm; `tsc` clean; README covers config, tools, privacy.

## 6. Test Plan

- Unit (`bun test`): scope hashing (same remote different case → same key; different remotes → different keys), CRUD round-trip, markdown/SQLite consistency, redaction of `<private>` + secrets, verification outcomes (valid/partial/invalid), expiry computation.
- Integration (manual script): seed 5 project facts → restart → assert injection ≤ budget; edit same files twice → capture nudge appears; compact → summary memory exists; forget → gone after restart.
- Adversarial: insert contradicting fact with nonexistent citation → must be excluded and flagged, never injected as truth.
- Perf: recall p95 < 300ms local; injection ≤ `maxInjectChars`; no throw on corrupt DB (rebuild from Markdown).

## 7. Risks

- Hook name drift between OpenCode v1/v2 (`plugin` vs `plugins`, `tool.execute.before` shape) → pin `@opencode-ai/plugin` version, feature-detect `experimental.session.compacting`, keep adapter in `index.ts`.
- Over-injection noise → budgets, dedup, `advisory` default for new installs if noisy.
- Citation rot on fast-moving branches → verification heuristic + `needs_review` surfacing instead of silent use.

## 8. Done Definition

v1 ships when: install from local dir and npm both work; 6 tools operate with scope isolation; session restart + compaction preserve verified facts; redaction + expiry + adversarial exclusion all tested; README + permissions example complete.

---

## Build outcome (2026-10-01)

All five phases are implemented and verified: 99 unit/integration tests, a 28-check end-to-end smoke test that drives both plugin generations against real files, `tsc --noEmit` clean, and a live dogfood run inside OpenCode v2.0.21 where `memory_add` / `memory_recall` / `memory_list` / `memory_forget` were exercised through the real plugin runtime.

### Deviation from the plan: dual-generation entry point

The plan's risk section flagged "hook name drift between OpenCode v1/v2" as the main compatibility risk. It materialised, and it was larger than anticipated.

The installed CLI is **OpenCode v2.0.21**, whose plugin contract is not the v1 one the plan (and `@opencode-ai/plugin`) describes:

| Plan assumed (v1) | Actual v2 |
| --- | --- |
| `export const Plugin: Plugin = async (input) => ({ ...hooks })` | `export default Plugin.define({ id, setup(ctx) })` |
| tools from a returned `tool` map with Zod args | `ctx.tool.transform(editor => editor.add({ input: <JSON Schema> }))` |
| `event` hook | `ctx.event.subscribe({ signal })` |
| `experimental.chat.system.transform` | `ctx.session.hook("context", e => e.system.push(...))` |
| `experimental.session.compacting` | `ctx.session.hook("compaction", ...)` |
| `chat.message` | `ctx.session.hook("prompt", ...)` |
| `dispose` hook | cleanup function returned from `setup` |

Resolution, following the shape the official v1→v2 migration guide documents for supporting both from one package:

- `src/service.ts` holds all tool behaviour, version-agnostic.
- `src/tool-schema.ts` is the single source of truth for tool names, descriptions and arguments; the v1 Zod shapes in `src/tools.ts` are **derived** from the same JSON Schema the v2 adapter registers, so the two cannot drift.
- `src/v1.ts` and `src/v2.ts` are thin adapters over that shared core.
- `src/index.ts` default-exports `{ ...Plugin.define({id, setup}), server }`, which is what OpenCode v2 (`setup`) and v1 ≥ 1.18.29 (`server`) each load.

Injection point also changed from the plan's `session.created` to `experimental.chat.system.transform` (`ctx.session.hook("context")`), because that is the only hook that actually reaches the outgoing model request. `session.created` is now used for the once-per-session expiry sweep instead.

### Additional defects found and fixed during the build

These were not in the plan; each is now covered by a test.

- **Lexical overlap over-constrained verification.** The first implementation required the cited line to share words with the fact, which rejected correct citations where a fact is an abstraction over concrete code. Overlap is now a diagnostic only; validity is file existence plus line presence.
- **Tokenization shredded identifiers.** A case-insensitive camelCase split reduced every word to single characters, so overlap was always zero. Tokens are now split with case preserved.
- **A deleted `index.db` started an empty store.** The Markdown rebuild only ran on the corruption path, so deleting the index silently lost every memory. Rebuild now also runs when the index was absent at open time.
- **Corrupt-index recovery failed on Windows.** The failed handle was never closed, so the rename to `.corrupt-<ts>` was refused and the same bad file was reopened. The handle is closed first, with deletion as a fallback.
- **Windows repo keys were unreadable.** `repoNameFromIdentity` split only on `/`, so a path fallback produced `repo_c-ai-development-opencode-memory__…` instead of `repo_opencode-memory__…`.
- **Silent orphaning on identity change.** Because rows are keyed by `repo_key`, any change to the derivation makes existing memories invisible with no explanation. The hub now warns once per worktree when rows exist under a foreign key.
- **Markdown format was unparseable.** `Kind`, `Updated`, `Validated` and `Uses` shared one line, so `Uses` never round-tripped. One field per line now.

### Not implemented (deliberately out of v1 scope)

Embeddings and semantic search, cross-machine sync, a TUI status footer, and the `/memory` slash command. The plan assigned these to a later increment; the foundations (`revision`-based cache invalidation, `Injector.stats`, `recommendedPermissions()`) are in place for them.

