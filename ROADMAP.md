# ROADMAP.md — Remaining Work

Plan for the five items that were deliberately deferred out of v1, plus the one
open question from the v1 release verification.

Written against the current tree (commit `7f5aa7d`, "Local-first persistent memory
plugin for OpenCode"). Design decisions here reuse the patterns already
established in `IMPLEMENTATION_PLAN.md` and its build-outcome notes: one shared
core with thin per-generation adapters, a single source of truth for tool
definitions, and every external dependency made optional and fail-soft.

---

## 0. Current state

Shipped and verified in v1:

- Three scopes (global / project / session) with Git-remote-derived identity
- Citation-backed facts re-verified before every injection, with
  `valid` / `partial` / `invalid` outcomes
- SQLite index plus regenerated Markdown mirror, with rebuild-on-loss and
  rebuild-on-corruption
- 28-day expiry for unused memories, refreshed on verified use
- Redaction of `<private>` blocks and 11 secret shapes before any write
- Seven tools, keyword-only retrieval
- Dual-generation entry point (OpenCode v2 `setup`, v1 `server`)

Verification harness in place: 101 unit/integration tests, a 28-check end-to-end
smoke test across both generations, a 16-check no-console-flash regression guard,
and `tsc --noEmit` clean. New work must extend these rather than replace them.

Foundations already present for this work: `revision`-based cache invalidation on
both stores, `Injector.stats` / `noteSave()`, `MemoryHub.stats()`, `recommendedPermissions()`,
`repo_id` stable identity (which is what makes machine-independent sync possible),
and `MemoryService` as a version-agnostic tool layer.

## 0.1 Principles carried forward

1. **Local-first means optional-by-default.** Anything that talks to a network
   service must be off unless configured, and must degrade to current behaviour
   when unavailable. Nothing in this roadmap may become a hard dependency.
2. **Injection stays synchronous and fast.** The `context` hook runs on every
   model request. Anything expensive or async (embeddings, sync) must be computed
   off the injection path and consumed from a cache, never awaited inline.
3. **One definition per tool.** New tools follow the `tool-schema.ts` pattern:
   name, description and arguments declared once, with the v1 Zod shape and the
   v2 JSON Schema both derived from it.
4. **Fail soft, loudly.** Errors are logged through the plugin logger, surfaced
   to the user via `/memory status` or a toast, and never thrown into a hook.

---

## 1. Workstream A — Semantic retrieval

### Problem

Retrieval is keyword-only (`tokenize` + overlap scoring in `store.ts`). A fact
stored as "releases bump the version in three places" is not found by a query for
"API_VERSION synchronization", because nothing in the two strings matches. This is
the main recall gap and the reason a citation-verified memory can be invisible.

### Scope

Add a pluggable embedding layer and blend its ranking with the existing keyword
ranking. Two consumers with different constraints:

- **Tools** (`memory_recall`, `memory_search`) are async and may embed the query
  inline. This is where semantic ranking pays off most.
- **Injection** is effectively synchronous. It consumes a per-session cache that
  the async path primes; until primed it falls back to recency + verification
  exactly as today.

### Providers

| Provider | Network | Notes |
| --- | --- | --- |
| `hash` | none | Default. Deterministic hashing vectorizer over tokens plus character trigrams. **Fuzzy lexical, not semantic** - see honesty note below. |
| `ollama` | localhost:11434 | Real semantics via `POST /api/embeddings`. Model configurable, default `nomic-embed-text`. |
| `openai-compatible` | remote | `POST {baseUrl}/embeddings` with a bearer key read from a named env var. |
| `none` | none | Disables embeddings; ranking stays keyword-only. |

Honesty note, which must also appear in the README: the built-in `hash` provider
does not understand meaning. It improves on exact-token matching by tolerating
word order, inflection and typos, but it cannot relate "deploy" to "ship".
Genuine semantic recall requires `ollama` or an OpenAI-compatible endpoint, and
that is a deliberate trade of privacy for quality that the user opts into.

### Data model

New table in the existing `index.db`, alongside `memories`:

```sql
CREATE TABLE IF NOT EXISTS embeddings (
  memory_id TEXT PRIMARY KEY,
  provider  TEXT NOT NULL,
  dim       INTEGER NOT NULL,
  vector    BLOB NOT NULL,     -- Float32Array, dim * 4 bytes
  text_hash TEXT NOT NULL,     -- detects stale vectors without re-reading the row
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embeddings_updated ON embeddings(updated_at);
```

Vectors are keyed by `memory_id` and tagged with `provider`; switching providers
invalidates the whole table rather than mixing vector spaces.

### Files

| File | Change |
| --- | --- |
| `src/embeddings.ts` | New. Provider interface, the four providers, `cosine()`, `blendScores()`. |
| `src/semantic.ts` | New. `SemanticIndex`: `ensureIndexed()`, `search()`, `primeSession()`, `cachedFor()`, `clear()`. |
| `src/store.ts` | Embeddings table in `SCHEMA`, plus `putEmbedding` / `allEmbeddings` / `clearEmbeddings`. |
| `src/service.ts` | `recall` / `search` blend semantic ranking; new `memory_semantic_status` reporting. |
| `src/inject.ts` | Optional `semantic?: SemanticIndex`; uses the primed session cache when present. |
| `src/hub.ts` | Owns one `SemanticIndex` per worktree. |
| `src/config.ts` | `embeddings` config section with per-field validation. |
| `src/types.ts` | `EmbeddingsConfig`, `SyncConfig`. |

### Configuration

```jsonc
{
  "embeddings": {
    "enabled": false,              // opt-in; false keeps today's behaviour exactly
    "provider": "hash",            // hash | ollama | openai-compatible | none
    "model": "nomic-embed-text",
    "baseUrl": "http://127.0.0.1:11434",
    "apiKeyEnv": "OPENAI_API_KEY", // read from env, never stored in config
    "dimensions": 256,             // hash provider only; ignored by API providers
    "blend": 0.5,                  // 0 = keyword only, 1 = semantic only
    "indexOnAdd": true,
    "maxIndexOnStart": 200         // bounds startup work on large stores
  }
}
```

### Blending

Per candidate: `score = (1 - blend) * keywordScore + blend * semanticScore`.
Candidates come from the keyword path (bounded at 300 rows) so the semantic pass
never widens the search space unexpectedly; it only re-ranks what keyword recall
already found. Pure semantic search is deliberately not offered in v2 - it is
unbounded, slower, and harder to explain to the agent.

### Tests

- Hash provider is deterministic, unit-normed, and stable across runs
- Cosine of identical vectors is 1; of orthogonal vectors is 0
- `ensureIndexed` embeds only missing or stale rows (assert `text_hash` reuse)
- Switching provider invalidates and rebuilds the table
- Blending preserves keyword ranking when `blend: 0`, and can reorder at `0.5`
- A provider that throws is logged and leaves ranking keyword-only
- `ollama` / `openai-compatible` request shape asserted against a stub `fetch`
- Injection with no primed cache produces byte-identical output to today

### Acceptance

With `enabled: false` (the default) every existing test passes unchanged and no
network call is made. With `provider: "hash"` a synonym query that keyword search
misses returns the expected fact, and `/memory semantic` reports index coverage
and the active provider.

### Risks

| Risk | Mitigation |
| --- | --- |
| Remote provider leaks memory text | Off by default; the key comes from an env var; README states exactly what is sent. |
| Startup cost on large stores | `maxIndexOnStart`, run lazily after first turn, never in a hook. |
| Mixed vector spaces after a provider change | `provider` column plus full invalidation. |
| Injection latency regression | Semantic ranking is cache-only on that path. |

---

## 2. Workstream B — Cross-machine sync

### Problem

Memories are per-machine. Two clones of the same repository on a laptop and a
desktop keep separate stores, so knowledge earned on one is invisible on the
other. Today the only route is hand-copying `project.md`.

### Scope

A portable, mergeable bundle format plus explicit export/import, optionally
mirrored to a directory that the user already syncs (a git-tracked folder,
Dropbox, OneDrive, a network share). No server, no account, no daemon.

This is deliberately the boring mechanism: memory files are already text, and a
JSONL bundle is diffable and merges better than SQLite ever will.

### Format

One JSON object per line, sorted by `id`, in `<syncDir>/<repoId>.jsonl`. Keyed by
`repoId`, which is derived from the origin remote and therefore identical on every
machine - this is the property that makes cross-machine sync possible at all, and
it is why `repo_id` was separated from the display name.

```jsonc
// header line
{ "t": "meta", "v": 1, "scope": "project", "repoId": "…", "repoKey": "…",
  "exportedAt": 1767225600000, "count": 42 }
// record line
{ "t": "mem", "id": "m_…", "subject": "…", "fact": "…", "citations": [...],
  "reason": "…", "kind": "…", "createdAt": 0, "updatedAt": 0,
  "lastValidatedAt": 0, "useCount": 0 }
// tombstone line: propagates a deletion to other machines
{ "t": "del", "id": "m_…", "deletedAt": 1767225600000 }
```

### Merge rules

1. Union by `id`.
2. Incoming record wins when `incoming.updatedAt > local.updatedAt`; otherwise the
   local copy is kept and counted as a conflict-free skip.
3. An incoming tombstone deletes the local row when `deletedAt > local.updatedAt`.
4. Tombstones are retained locally for `syncTombstoneDays` (default 90) so a
   deletion cannot be resurrected by a peer that still holds the record.
5. `lastValidatedAt` and `useCount` merge with `max`, never with the incoming
   value, so a peer that never verified a fact cannot erase local verification.
6. `needsReview` is OR-ed: either machine may flag a fact, and one flag suffices.
7. Deleting an exported file is **not** a deletion signal; only explicit
   `memory_forget` writes a tombstone. Losing the bundle must never destroy data.

### Files

| File | Change |
| --- | --- |
| `src/sync.ts` | New. `exportBundle()`, `parseBundle()`, `mergeBundle()`, `SyncReport`. |
| `src/store.ts` | `tombstones` table, `tombstone()`, `applyRecord()`, `isTombstoned()`, `purgeTombstones()`. |
| `src/service.ts` | `memory_sync` tool: `status`, `export`, `import`, each with `dryRun`. |
| `src/hub.ts` | Optional `syncOnStart` wiring, failures logged. |
| `src/config.ts` | `sync` config section. |
| `src/tool-schema.ts` | `memory_sync` spec. |

### Configuration

```jsonc
{
  "sync": {
    "enabled": false,
    "directory": "",                 // empty disables the mirror; export/import still work
    "scope": "project",              // project | global | both
    "autoOnStart": false,            // import on session start, then export
    "writeTombstones": true,
    "tombstoneDays": 90,
    "conflictPolicy": "newer-wins"   // the only policy in v2; named for future-proofing
  }
}
```

### Tests

- Round-trip: export then import into an empty store reproduces every field
- Merge is idempotent - importing the same bundle twice changes nothing
- Newer remote record wins; older remote record is skipped, not reverted
- Tombstone deletes locally, is itself idempotent, and is purged after its window
- A record cannot be resurrected by an older peer after deletion
- `lastValidatedAt` / `useCount` survive a merge from an unverified peer
- A hand-edited bundle line is skipped, not fatal
- `dryRun` reports counts and mutates nothing
- Sync is skipped entirely when `enabled: false`

### Acceptance

Two stores seeded from the same bundle, mutated independently, then exchanged via
`memory_sync`, converge to an identical set of records with no data loss, and a
`memory_forget` on one machine removes the fact on the other.

### Risks

| Risk | Mitigation |
| --- | --- |
| Two machines write simultaneously | Last-write-wins on a monotonic timestamp; the loser is skipped, never reverted. |
| Clock skew between machines | `updatedAt` only decides direction, never deletes; conflicts resolve toward the newer write and are reported. |
| Bundle deleted by a sync client | Deletion is never inferred from a missing file; only tombstones delete. |
| Partial write during auto-sync | Write to a temp file then rename, which is atomic on both NTFS and POSIX. |

---

## 3. Workstream C — The `/memory` command

### Problem

Everything the plugin can do currently requires the agent to decide to call a
tool. There is no way for a human to inspect, repair or sync memory directly,
which is exactly what you need when recall looks wrong.

### Scope

A single `/memory` slash command with subcommands, registered on OpenCode v2 via
`ctx.command.transform`. It reports through `ctx.session.prompt`, so output
appears as normal assistant text.

| Subcommand | Behaviour |
| --- | --- |
| `/memory` or `status` | Store counts per scope, active project identity, provider, sync state, last activity. |
| `/memory list [scope]` | Same as `memory_list`. |
| `/memory search <query>` | Same as `memory_search`. |
| `/memory verify` | Re-verify every stored fact now and report the state distribution. |
| `/memory why <id>` | Show one record with citations, validation date, use count, and current verification. |
| `/memory forget <id>` | Delete one fact. |
| `/memory clear <scope>` | Clear a scope, with explicit confirmation in the reply text. |
| `/memory rebind` | Same as `memory_rebind`: list then adopt foreign identities. |
| `/memory semantic` | Embedding provider, index coverage, blend weight. |
| `/memory sync status\|export\|import` | Bundle state and manual sync. |
| `/memory help` | Usage. |

### Files

| File | Change |
| --- | --- |
| `src/command.ts` | New. `parseMemoryCommand()`, `runMemoryCommand()`, `registerMemoryCommand(ctx, hub)`. |
| `src/v2.ts` | Register the command transform during `setup`. |
| `src/v1.ts` | Not registered. v1 exposes no plugin-command API; the tools remain available and `/memory help` text is printed if a user tries. |

The command is a thin dispatcher: it parses, then calls the same `MemoryService`
methods the tools call, so behaviour cannot diverge between the two surfaces.

### Tests

- Parser: every subcommand, aliases, unknown subcommand, empty input, quoted
  arguments with spaces
- Each subcommand produces its expected key phrases
- Unknown subcommand returns help rather than an error
- `verify` reports the `valid` / `partial` / `invalid` distribution

### Acceptance

`/memory status` in a real session reports live counts; `/memory verify` on a
store seeded with a deleted citation reports that fact as invalid.

### Risks

| Risk | Mitigation |
| --- | --- |
| Command name collides with another plugin | `editor.update` on the same name instead of blind `add`; log a warning if the name is taken. |
| Output too long for a chat message | Cap every listing, and point at the tools or `project.md` for the full set. |

---

## 4. Workstream D — TUI status footer

### Problem

Whether memory did anything is invisible. Recall and save activity only appears in
tool output, so a user cannot tell whether the block was injected, whether it was
withheld, or whether the store is even being read.

### Scope

An **optional companion plugin** at the `./tui` export, matching the pattern the
ecosystem already uses for a server + TUI split. The host provides
`@opentui/solid` and compiles the JSX; the plugin must not depend on either.

```ts
// package.json
"exports": { ".": "./src/index.ts", "./tui": "./src/tui.tsx" }
```

```
.opencode/plugins/opencode-memory-tui.ts   -> re-exports the companion
```

The footer claims the `prompt.footer.status` slot and renders a compact status
line:

```
memory 3 facts · 1 withheld        (idle)
memory verifying…                  (running)
memory off                         (disabled)
```

Toasts are used for discrete events - a fact withheld, a rebind applied, a sync
conflict - because they need no JSX and work even if the slot is unavailable.

### Server to TUI channel

The two plugins are separate instances, so the server publishes its stats to
`ctx.storage` under a small key (`status`), and the companion reads it. This is
exactly what plugin storage is for, is already durable, and needs no IPC.

Stats published: `enabled`, `recallMode`, counts per scope, `recalled`, `saved`,
`withheld`, `needsReview`, `lastActivity` (kind + timestamp), semantic provider,
sync state.

### Files

| File | Change |
| --- | --- |
| `src/tui.tsx` | New. The companion; JSX, excluded from this repo's `tsc` run because the JSX runtime is host-provided. |
| `src/status.ts` | New. `MemoryStatus` shape, `publishStatus(ctx, status)`, `readStatus(ctx)`. |
| `src/v2.ts` | Publish status after each injection, tool call and turn. |
| `package.json` | `./tui` export, and `jsxImportSource` config. |
| `tsconfig.json` | Exclude `src/tui.tsx`, with a comment explaining why. |

### Honest limitation

The companion cannot be typechecked or tested in this repository, because
`@opentui/solid` and `solid-js` are supplied by the host at runtime and are not
installable dependencies. The claim and toast logic will be written defensively
(defensive try/catch, no import of the JSX runtime, degrade to toasts-only if the
slot claim throws) and verified manually in a real TUI session. This will be
stated plainly in the README rather than presented as tested.

### Tests

Not applicable for rendering. What *is* testable and will be tested:
`MemoryStatus` serialisation round-trip, and that `publishStatus` writes a shape
`readStatus` accepts.

### Acceptance

With the companion installed, the footer shows a live count during a session and
a toast appears when a fact is withheld.

---

## 5. Workstream E — Release verification

### Open question

`opencode plugin list` reported `-` for the ID and version when the plugin was
installed as a package, while the file-based `.opencode/plugins/*.ts` shim
reported `opencode-memory` correctly and registered all tools. Importing the
installed package directly confirmed a correct shape (`id: "opencode-memory"`,
`setup: function`), so this looks like `plugin list` not resolving IDs for
package-installed plugins rather than a broken package - but that was not proven.

### Steps

1. In a clean throwaway project, `opencode plugin add github:cbuntingde/opencode-memory`.
2. `opencode plugin list` - record whether the ID resolves.
3. `opencode run` with a prompt that must call `memory_add`, then confirm the
   tools are visible to the model and a fact lands in `.opencode/memory/`.
4. Repeat on OpenCode v1 to confirm the `server()` path.

### Outcome

Either fix the packaging if the package genuinely fails to load, or record the
observed behaviour in the README as a known cosmetic quirk of `plugin list`.
Either way the answer ends up written down rather than left as a suspicion.

---

## 6. Sequencing

Workstreams B and A both change `store.ts` and `config.ts`, so they are ordered to
keep the tree green at every step.

| Milestone | Work | Exit criteria |
| --- | --- | --- |
| M1 | E - release verification | Install path proven or the discrepancy explained and documented. |
| M2 | C - `/memory` command | Depends on nothing; built first because it is the diagnostic surface for A and B. |
| M3 | A - semantic retrieval | Embeddings behind `enabled: false`; existing tests unchanged; `ollama` path asserted against a stub. |
| M4 | B - cross-machine sync | Two-store convergence test passes; tombstones proven idempotent. |
| M5 | D - TUI footer | Compromise shipped as optional; server-side status publishing tested. |
| M6 | Release | README updated for every new tool, config key and limitation; full harness green. |

Each milestone is one commit or a small series, and each ends with
`bun run check` green (typecheck, 101+ tests, spawn guard, smoke).

## 7. Explicit non-goals

- **No background daemon.** Sync runs on demand or at session start, never resident.
- **No hosted memory service.** The plugin never becomes a client for someone
  else's store.
- **No automatic deletion from a missing bundle file.** Only explicit tombstones
  delete.
- **No embeddings on the injection path.** Ranking there stays cache-only.
- **No semantic ranking without keyword candidates.** Re-ranking a bounded
  candidate set keeps search explainable to the agent.

## 8. Done definition for this roadmap

When all five workstreams land:

- `/memory status`, `verify`, `why`, `rebind`, `semantic` and `sync` work from a
  real session
- Semantic retrieval is opt-in, degrades to keyword-only on any provider failure,
  and makes no network call by default
- Two machines converge on an identical store, and a delete on one propagates
- The optional TUI companion shows a live status line without adding a
  host-owned runtime as a dependency
- The install path from GitHub is verified on both plugin generations
- `README.md` documents every new tool, config key, and every limitation,
  including the ones that cannot be tested here
