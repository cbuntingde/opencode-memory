# opencode-memory-local

Local-first persistent memory for [OpenCode](https://opencode.ai/), built around
citation-backed facts that are re-verified against your code every time they are
used.

No hosted service, no vector database, no API key. Memories live as readable
Markdown next to your project and in your OpenCode config directory.

## Why this exists

An agent that forgets your conventions between sessions makes you repeat yourself
constantly. The obvious fix — let the agent write notes freely — fails in the other
direction: notes go stale the moment the code moves, and a confidently wrong note
is worse than no note.

GitHub Copilot Memory solved this by attaching **citations** to every fact and
checking them **at the moment of use**, instead of trying to keep memories fresh
offline. This plugin takes that approach and adds three things Copilot does not
need because it is a hosted product:

- everything stays on your machine, in files you can read, edit and diff
- facts are verified against your **working tree**, not a server snapshot
- the same store is shared by every OpenCode client on the machine

## How a fact is stored

```md
## [m_mupbg7pepiqllv] API version constant
- Fact: The API version is declared in src/version.ts and must be bumped on every release
- Citations: src/version.ts:1
- Reason: Releases break when the constant and the docs disagree
- Kind: project-config
- Scope: project
- Repo: repo_opencode-memory__5c3949273bb0
- Created: 2026-10-01
- Updated: 2026-10-01
- Validated: 2026-10-01
- Uses: 4
- NeedsReview: false
```

`project.md` is regenerated on every write. `index.db` holds the same records and
is what queries run against; if it is ever deleted or corrupted, the plugin
renames the bad file and rebuilds the index from `project.md`.

## Verification

Before a memory reaches the model, each citation is re-checked:

| Result | Meaning | Effect |
| --- | --- | --- |
| `valid` | cited file exists and the cited line is present and non-empty | injected normally |
| `partial` | file exists but the cited line is gone or blank | injected, labelled `(partially verified)` |
| `invalid` | at least one cited file no longer exists | **withheld**, and flagged for review |

Lexical overlap between the fact and the cited line is reported as a diagnostic
but does not decide validity — a fact is usually an abstraction sitting on top of
concrete code, so demanding word-level agreement would reject correct citations.

This is what makes the system self-healing rather than self-degrading: a
convention that was deleted stops being injected within one session, and the model
is told that stored facts were withheld so it can re-record them if still true.

## Installation

### From this GitHub repository

```bash
opencode plugin add github:cbuntingde/opencode-memory
```

That installs the package and adds it to your global OpenCode config.

To pin a branch, tag or commit, append a Git ref:

```bash
opencode plugin add github:cbuntingde/opencode-memory#v0.1.0
```

### Per-project, from a clone

Add the entry to `opencode.json` in the project you want memory for. OpenCode
v2 uses the `plugins` key; v1 uses the singular `plugin` key with a
`[package, options]` tuple:

```jsonc
// v2
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-memory-local"]
}
```

```jsonc
// v1
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-memory-local"]
}
```

With options:

```jsonc
// v2
{
  "plugins": [
    { "package": "opencode-memory-local", "options": { "recallMode": "direct" } }
  ]
}
```

```jsonc
// v1
{
  "plugin": [["opencode-memory-local", { "recallMode": "direct" }]]
}
```

### While developing this repository

No install step. Point OpenCode straight at the source:

```ts
// <repo>/.opencode/plugins/opencode-memory.ts
export { MemoryPlugin, default } from "../../src/index.ts";
```

Files in `.opencode/plugins/` are loaded automatically, and `opencode plugin list`
shows the plugin as `opencode-memory`. The default export serves v2 (`setup`)
and v1.18.29+ (`server`); the named `MemoryPlugin` export keeps the v1 function
shape available to local-file loading.

### Packaging notes

The entry is TypeScript (`exports["."] = "./src/index.ts"`), which OpenCode loads
with Bun. If you install from a local path rather than a Git ref on Windows, pack
it first — copying the directory with its `node_modules` fails with `EPERM`:

```bash
bun pm pack --destination /tmp
bun add /tmp/opencode-memory-local-0.1.0.tgz
```

Verify either install with:

```bash
opencode plugin list
```

The package default-exports both generations, so one install works on OpenCode v2
(`setup()`) and v1 (`server()`).

## Tools

| Tool | Read-only | Purpose |
| --- | --- | --- |
| `memory_recall` | yes | Search all scopes; reports verification state per fact |
| `memory_search` | yes | Keyword search with citations |
| `memory_list` | yes | List a scope, with validation dates and review flags (`includeReview: true` shows flagged facts) |
| `memory_profile` | yes | User-wide preferences that follow you across projects |
| `memory_add` | no | Record one fact. **Requires ≥1 citation** outside session scope |
| `memory_forget` | no | Delete one fact by id, or `all: true` to clear a scope |
| `memory_rebind` | no | List or adopt memories stored under a different project identity |

### Permissions

Reads are safe to auto-approve; writes should not be. On OpenCode v2 this
is the `permissions` array in `opencode.json`:

```jsonc
{
  "permissions": [
    { "action": "memory_recall", "resource": "*", "effect": "allow" },
    { "action": "memory_search", "resource": "*", "effect": "allow" },
    { "action": "memory_list", "resource": "*", "effect": "allow" },
    { "action": "memory_profile", "resource": "*", "effect": "allow" },
    { "action": "memory_add", "resource": "*", "effect": "ask" },
    { "action": "memory_forget", "resource": "*", "effect": "ask" },
    { "action": "memory_rebind", "resource": "*", "effect": "ask" }
  ]
}
```

`recommendedPermissions()` exports exactly this list.

## Scopes

| Scope | Lives in | Survives | Use for |
| --- | --- | --- | --- |
| `global` | `~/.config/opencode/memory/global.md` | restarts, all projects | personal style, workflow |
| `project` | `<repo>/.opencode/memory/project.md` | restarts | conventions, commands, invariants |
| `session` | in memory only | current conversation | working notes, plans |

Project identity comes from the normalised Git origin remote
(`git@github.com:owner/repo.git` and `https://github.com/owner/repo` collapse to
the same key), falling back to the worktree path. Clones of one repository share
memory; same-named repositories on different remotes stay isolated.

## Automatic capture

The plugin observes tool calls and edits but **does not write facts on your
behalf from shell output**. It only records automatically when it has file-level
evidence:

1. **Repeated edits.** If one file is edited two or more times in a session, the
   task clearly revolved around it, so that is stored with the file as citation.
2. **Keyword nudges.** Saying "remember", "don't forget" or "from now on" sets a
   one-shot nudge asking the agent to record what it learned — with a citation.
   The agent does the writing, so the fact stays well-formed.
3. **Compaction.** Memory, touched files and recent shell commands are added to
   the compaction prompt, and the resulting summary is stored as a
   `conversation` memory so the next context window can resume.

## Configuration

`memory.jsonc` in `~/.config/opencode/` (global) and `.opencode/` (project, wins).
Comments and trailing commas are allowed. Malformed values fall back to defaults
rather than breaking the session.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `recallMode` | `"direct"` | `direct` injects automatically, `advisory` tells the agent to decide, `off` disables injection |
| `maxInjectChars` | `4000` | Hard ceiling for the whole injected block |
| `maxMemoriesPerInject` | `5` | Cap on individual memories per session |
| `captureEveryNTurns` | `3` | Completed turns between capture flushes; `0` disables |
| `expiryDays` | `28` | Unused memories are dropped after this |
| `compactionEnabled` | `true` | Participate in context compaction |
| `redactPrivate` | `true` | Strip `<private>` blocks and secrets before writing |
| `autoSaveRepeatedEdits` | `true` | Record repeated-edit patterns automatically |
| `maxMemoriesPerScope` | `500` | Cap per scope; least-used are dropped first |
| `keywordPatterns` | see above | Extra nudge triggers; built-ins are always kept |

## Privacy

- **Redaction runs before every write.** `<private>…</private>` blocks (an opener
  without a closer redacts to end of input), AWS keys, GitHub tokens and PATs,
  OpenAI/Anthropic/Google keys, Slack tokens, JWTs, PEM blocks,
  bearer headers and `KEY=value` env lines are all masked. The key name is kept
  so the line stays legible.
- **`.env` cannot be cited.** Citation parsing rejects dotenv paths outright.
- **Repository knowledge never leaves its repository.** Project scope is keyed by
  remote and only ever loaded for that repository.
- **Nothing is sent anywhere.** No network calls in the default configuration.

## Failure behaviour

Every hook is wrapped. A broken store, a locked database or an unreadable file
degrades to "no memory this turn" and logs a warning — it never fails the session.
A corrupted `index.db` is renamed aside and rebuilt from Markdown.

## Development

```bash
bun install
bun test          # 118 unit + integration tests
bun run smoke     # end-to-end through both plugin generations, on real files
bun run typecheck
bun run check     # typecheck + tests + spawn guard + smoke
```

Layout:

```
src/
  index.ts        combined entry: v2 setup() + v1 server()
  v1.ts           OpenCode v1 adapter (hook object)
  v2.ts           OpenCode v2 adapter (Plugin.define + setup)
  service.ts      version-agnostic tool behaviour
  tool-schema.ts  single source of truth for names, descriptions, JSON Schema
  tools.ts        v1 Zod schemas derived from tool-schema.ts
  store.ts        SQLite + Markdown mirror, retention, rebuild
  verify.ts       just-in-time citation checking
  inject.ts       budgeted, verified context block
  capture.ts      observation, turn cadence, nudges
  session-store.ts in-memory session scope
  hub.ts          per-worktree store ownership
  scopes.ts       repo identity and citation paths
  config.ts       JSONC loading and validation
  redact.ts       secret and private-block redaction
  citation.ts     citation parsing and formatting
  text.ts         tokenization, overlap scoring, truncation
```

## Licence

MIT
