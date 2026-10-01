# Professional Memory Plugin Plan for OpenCode

OpenCode lacks durable cross-session understanding by default, while GitHub Copilot has moved to citation-backed, just-in-time verified memory shared across agents. A professional OpenCode plugin can close that gap by combining OpenCode hooks and custom tools with Copilot memory principles, without requiring an external SaaS dependency.

## 1. OpenCode Platform Characteristics

OpenCode is an open source, MIT-licensed coding agent that runs in the terminal, desktop app, and IDE extensions and connects to more than 75 model providers [1][2]. The project homepage emphasizes LSP loading, multi-session execution, share links, and use of existing GitHub Copilot or ChatGPT Plus subscriptions [1]. Documentation describes initialization with a single `opencode` command after global install [2]. The canonical repository is now `anomalyco/opencode`, formerly `sst/opencode` [3]. Anomaly Innovations is identified as the organization behind the project, with a stated privacy-first position of not storing code or context centrally [2].

This architecture matters for memory design. Because OpenCode is local-first and model-agnostic, memory cannot assume server-side storage or a single model. It must live in the workspace or user config, work offline, and inject context through the plugin layer rather than a hosted service.

## 2. Plugin and Hook Mechanisms

OpenCode plugins are JavaScript or TypeScript modules exporting one or more plugin functions. Each function receives context and returns a hooks object [4].

The context includes project metadata, current directory, worktree path, an SDK client, and Bun shell access [4]. TypeScript plugins import the `Plugin` type from `@opencode-ai/plugin` for type-safe hooks [4].

Loading supports two paths. Local files in `.opencode/plugins/` apply per project and files in `~/.config/opencode/plugins/` apply globally, while npm packages listed in the `plugin` array are installed automatically with Bun and cached under `~/.cache/opencode/node_modules/` [4]. Load order runs from global config to project config to global plugin directory to project plugin directory, with duplicate npm name-version pairs loaded once [4]. External npm dependencies for local plugins are declared in a `package.json` inside the config directory and installed at startup [4].

The event inventory relevant to memory covers session lifecycle, tool execution, files, permissions, shell, and UI. Session events include creation, update, idle, deletion, compaction, diff, error, and status changes [4]. Tool events center on execution before and after calls [4]. Additional signals include file edits, permission prompts, shell environment injection, command execution, and TUI prompt augmentation [4]. A separate experimental compaction hook fires before summary generation and accepts added context or a full prompt replacement [4].

Two extension points combine for memory. Custom tools created with the `tool()` helper expose new agent-callable capabilities with a description, Zod schema arguments, and an execute function [5][4]. Hooks observe or mutate behavior around those tools, for example blocking `.env` reads in `tool.execute.before` or formatting after edits [4]. Permissions then govern execution with allow, ask, and deny outcomes, including granular patterns for shell, edit, read, glob, grep, task, skill, webfetch, external directory access, and loop detection [6]. Reads default to allow except for `.env` files, while external directory and loop guards default to ask [6].

## 3. Copilot Memory Architecture

Copilot Memory stores repository-level facts and user-level preferences, collectively called memories, only in response to activity from users with memory enabled [7]. Repository facts cover conventions, architecture, build commands, and project rules and are visible to others with repository access. User preferences capture individual style and workflow and remain tied to that user [7]. Availability spans cloud coding agent, code review, CLI, and autofix, with facts captured in one surface reusable in another [7].

The table below isolates the mechanism most worth copying.

| Mechanism | Copilot behavior | Relevance for OpenCode |
|---|---|---|
| Citation attachment | Every repository fact stores code locations supporting it [7] | Prevents free-floating claims in markdown memory |
| Just-in-time verification | Citations are checked against the current branch before use; only validated facts apply [7] | Avoids offline curation pipelines [8] |
| Scoped creation and use | Creation requires write access; use is limited to the same repository [7][8] | Maps to OpenCode project versus global plugin paths |
| Retention policy | Unused entries expire after 28 days; successful validation refreshes the timer [7] | Gives a simple expiry default |

The lead pattern is citation checking at read time. Rather than building deduplication and branch-tracking services, Copilot stores citations and verifies them with a small number of read operations during the session [8]. If citations are invalid or contradicted, the agent is expected to store a corrected version, which refreshes its timestamp [8].

Creation is modeled as a tool call the agent invokes when it finds something with future implications [8]. A representative example stores API version synchronization across client constants, server routes, and documentation with three file-line citations and a reason explaining failure risk [8]. Retrieval in the current implementation returns the most recent memories for the repository into the prompt, with search and weighted prioritization noted as future work [8]. Evaluation combined adversarial seeding, noisy historical population including abandoned branches, and live A/B testing. Seeded contradictions were detected and self-healed through citation checks. Organic population improved code review precision by 3% and recall by 4%. Merge rates for coding agent rose from 83% to 90%, and positive feedback on review comments rose from 75% to 77%, both reported as highly significant [8].

Local VS Code behavior adds a file-based complement. Three scopes separate user memory in `/memories/`, repository memory in `/memories/repo/`, and session memory in `/memories/session/`, with persistence across sessions for the first two and conversation-only lifetime for the third [9]. The first 200 lines of user memory load automatically each session [9]. Storage and retrieval use natural language requests, while management uses show and clear commands plus agent-directed edits [9].

## 4. Existing Memory Implementation Patterns

The community reference is `opencode-supermemory`, listed in the official ecosystem as persistent memory across sessions [10]. The repository reports about 1.6k stars and 110 forks and supports both OpenCode generations through parallel config keys [11].

Its behavior shows what users already expect. First-message injection delivers profile and project knowledge silently. Recall operates in direct, advisory, and off modes, with direct search injecting up to five strong matches per substantive prompt and failing open after three seconds [11]. Capture runs every N turns with session-end flushing, exclusion of synthetic plugin context, and redaction of `<private>` blocks [11]. Keyword triggers, codebase indexing commands, compaction enrichment, and update notices round out the loop [11]. Configuration covers similarity threshold, memory limits, profile injection, container tags, keyword patterns, compaction toggles, and capture cadence [11].

Scoping uses a unified container tag derived from project name and normalized Git origin hash, falling back to filesystem path without a remote, while retaining readability of legacy per-tool containers [11]. The tool surface includes add, search, profile, list, forget, and help modes with user and project scopes and typed categories such as project configuration, architecture, error solution, preference, learned pattern, and conversation [11]. OpenCode 2 differences are instructive: recall moves through a read-only tool, recalled context attaches to the outgoing model request rather than the transcript, and compaction enriches the native request instead of triggering summarization [11].

The gap for a professional alternative is local control and Copilot-style verification. Supermemory depends on a hosted or self-hosted service and semantic similarity. An OpenCode-native plugin can offer file-first storage, explicit citations, verification prompts, and deterministic scoping without network calls.

## 5. Professional Memory Plugin Design

The design below translates Copilot guarantees into OpenCode primitives. It assumes a local-first plugin with optional sync, not a hosted vector service.

### 5.1 Memory Scope Model

Three tiers mirror both Copilot and VS Code practice. Global scope holds user preferences and cross-project patterns and lives under the global config directory. Project scope holds repository facts and lives inside the project, keyed by normalized Git remote or path hash to keep forks separate. Session scope holds working notes and plans with conversation lifetime. This separation preserves privacy expectations that repository knowledge stays in its repository while personal style travels with the user [7][9].

### 5.2 Storage and Retrieval Model

Each memory is a small record with subject, fact, citations, reason, scope, timestamp, and last-validated time. Markdown files provide human auditability per scope, while a lightweight SQLite index supports recency and citation lookup. Retrieval follows Copilot staging: load a compact project summary plus recent high-value facts at session start, then targeted search on demand. Full semantic search is optional and deferred; recency plus citation validity covers most value with far less complexity [8].

### 5.3 Memory Capture and Injection Points

Capture centers on three hooks. Session creation injects the compact profile and project summary. Tool execution observation after edit, write, and bash calls proposes new facts with file-line citations. Compaction enrichment preserves decisions and active files into the summary and stores that summary as a memory [4]. Custom tools expose explicit control for add, search, list, forget, and profile operations, with a read-only recall tool auto-approved separately from mutating tools [11][6]. Keyword nudges for phrases such as remember and do not forget guide the model toward explicit saves without hardcoding prompts [11].

### 5.4 Privacy and Permission Model

Defaults follow Copilot scoping and OpenCode permissions. Creation from repository content requires project context, and project memories never inject into unrelated projects. Redaction of fenced private blocks and default denial of `.env` reads carry over from existing practice [11][6]. Mutating memory tools require approval under restrictive configs, while recall stays read-only and auto-approved. Expiry defaults to 28 days of non-use with refresh on successful verification, matching Copilot retention behavior [7]. A management command lists memories with citations and supports deletion per scope, giving repository owners and users direct control [7][9].

## 6. Implementation Stages and Validation Approach

### 6.1 Implementation Stages

Work proceeds in four increments. The first increment implements file storage, scope resolution, session-start injection, and the five core tools behind tests for load order and permission handling. The second adds observation hooks, keyword nudges, and compaction enrichment with redaction. The third adds citation verification prompts, expiry sweeps, and management commands. The fourth adds optional embeddings, cross-machine sync, and TUI status indicators. Each increment ships behind configuration flags for recall mode, capture cadence, and compaction participation.

### 6.2 Risk Factors and Mitigations

Stale guidance is contained by mandatory citations and verification before application [8]. Over-injection is contained by token budgets, short-prompt skipping, per-session deduplication, and fail-open timeouts [11]. Privacy leakage is contained by scope isolation, redaction, and permission separation [6][7]. Adversarial or incorrect entries are contained by requiring evidence locations and encouraging corrected rewrites on contradiction [8].

### 6.3 Success Criteria

Functional completion means memories persist across restarts, respect scope boundaries, survive compaction, and support explicit add, recall, and forget flows. Quality targets adapt Copilot evaluation: adversarial seed recovery, precision and recall movement on review tasks, and merge-rate or approval-rate movement in A/B sessions [8]. Operational targets include bounded injection size, sub-second local recall, and zero blocking failures when storage is unavailable.

## References

[1] https://opencode.ai/ — OpenCode product homepage, agent description and provider support.
[2] https://opencode.ai/docs/ — OpenCode intro and install documentation.
[3] https://github.com/anomalyco/opencode — OpenCode source repository and issue tracker.
[4] https://opencode.ai/docs/plugins/ — Plugin creation, context, load order, events, and hook examples.
[5] https://opencode.ai/docs/custom-tools/ — Custom tool structure, schema, and multi-tool files.
[6] https://opencode.ai/docs/permissions/ — Permission actions, granular rules, and defaults.
[7] https://docs.github.com/en/copilot/concepts/agents/copilot-memory — Copilot Memory types, scoping, retention, and enablement.
[8] https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/ — Agentic memory design, verification, sharing, and evaluation.
[9] https://code.visualstudio.com/docs/agents/run/memory — VS Code memory scopes, storage paths, and management commands.
[10] https://opencode.ai/docs/ecosystem/ — Community plugin and project catalog including memory plugins.
[11] https://github.com/supermemoryai/opencode-supermemory — Persistent memory plugin implementation and configuration.
