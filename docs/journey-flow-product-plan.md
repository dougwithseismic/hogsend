# Plan: Journey Flow Productization — v2

**Generated**: 2026-07-08 (v2, post design-review feedback)
**Estimated Complexity**: Medium (foundation shipped; this plan is polish + intelligence layers)

## Overview

The journey graph feature shipped its foundation in the current working tree: a source-derived `JourneyGraph` (AST extraction), parser-safe Mermaid, a manifest + `/v1/admin/journeys/:id/graph` API with staleness detection, a Studio Flow tab (React Flow + dagre, node side panel, live counts, Copy Mermaid, PNG export), CLI `journeys graph` (mermaid default, ascii/json opt-in, `--open` mermaid.live, `--all` docs+manifest), and docs mirroring.

This v2 plan folds in design-review feedback and re-plans the remaining work:

1. **Agents are the CLI's primary consumer** — they want structured journey data, not ASCII art. Mermaid is already the default; add a markdown/summary format and reorder docs. ASCII stays as an opt-in nicety.
2. **AST → email template preview in flow nodes** — resolve authored `Templates.X` references to concrete template keys at extraction time; render the existing template preview API inside the node panel.
3. **Deep links** — clicking a node opens the IDE of choice at `file:line`.
4. **Auto-layout polish** — the dagre output needs real tuning; evaluate ELK.
5. **Definition + Flow together** — two columns on desktop (tabs stay for mobile), instead of the current tabs-only toggle.
6. **"Copy as Mermaid" for decks/sales** — shipped in Studio; extend with deck-grade PNG framing and mermaid.live handoff.

## User journeys (who touches this, and how)

### UJ-1 — The agent (Claude Code / future MCP)
An agent working in a consumer repo runs `hogsend journeys graph churn-prevention` and gets Mermaid on stdout (already the default — no ASCII in the way). With `--json` it gets `{ graph, mermaid }` — nodes with kinds, source lines, template refs — enough to reason about the flow, edit the journey file, and re-graph to verify its own change. **New in this plan:** `--format summary` gives a terse markdown digest (trigger, sends, waits, branches, exits, source pointers) it can drop straight into a PR description.

### UJ-2 — The developer authoring a journey
Writes `run(user, ctx)` in their IDE. Runs `hogsend journeys graph <id> --open` to eyeball the flow on mermaid.live. Later, in Studio, clicks a branch node that looks wrong → **"Open in IDE"** jumps to the exact `if` statement in VS Code/Cursor. The loop closes: code → graph → code.

### UJ-3 — The lifecycle operator in Studio
Opens a journey detail page. On desktop, sees the **Definition and Flow side-by-side** — meta/trigger/exit rules on the left, the live flow canvas on the right. Clicks an email node → side panel shows the **rendered template preview**, sent/opened/clicked metrics, and who's parked downstream. Spots 200 users stuck at a wait node; clicks through to states.

### UJ-4 — The founder/seller building a deck
Clicks **Copy Mermaid** (shipped) → pastes into a slide tool or mermaid.live for a branded diagram. Or exports a **framed PNG** (title, timestamp, legend, no clipped labels) that survives a projector.

### UJ-5 — The docs reader
`hogsend journeys graph --all --fumadocs …` mirrors every journey's graph into the docs site, rendered by the `<Mermaid>` component (shipped). CI keeps it from drifting (this plan).

## Already shipped (current working tree — do not re-plan)

- Core renderer: parser-safe class names (`kind_*`), `tag: ` label prefixes, label escaping, `full`/`plain` variants (`packages/core/src/graph/mermaid.ts`)
- Extractor: branch arm relabeling via `labelFirstArmEdge` (no duplicate branch edges), shared end node, switch/loop/try handling, deterministic ids (`packages/cli/src/lib/journey-graph.ts`)
- CLI: `journeys graph <id>` (mermaid default | ascii | json), `--open`, `--out`, `--all` + `--fumadocs` + `--manifest`, lazy `typescript` import (`packages/cli/src/commands/journeys.ts`)
- API: `/v1/admin/journeys/:id/graph` — manifest cache (mtime), stale detection (source hash), per-node counts + funnel, OpenAPI schemas (`packages/engine/src/routes/admin/journeys.ts`)
- Studio: Flow tab (Definition | Funnel | Flow), dagre layout with cycle fallback, custom nodes/edges, node side panel (kind, label, live count, email metrics, `file:line` + copy, parked users), Copy Mermaid, Metrics overlay, PNG export, MiniMap, stale banner (`packages/studio/src/views/journeys/*`)
- Tests: extractor unit tests, CLI command tests, core graph tests, API route test
- Docs: `<Mermaid>` component, `concepts/journey-graphs.mdx`, per-journey docs mirror

## Sprint A: Agent-First CLI (feedback #1)

**Goal**: The CLI's default outputs are what an agent (or a human piping to a file) actually wants; ASCII is a demo garnish, not the pitch.

### Task A.1: `--format summary` (markdown digest)

- **Location**: `packages/cli/src/commands/journeys.ts`, new `packages/cli/src/lib/journey-summary.ts`
- **Description**: Terse markdown: journey id, trigger (+ conditions), entry limit, exit rules, then a table/list of sends (template + subject ref), waits (event/timeout), branches (condition), sleeps (duration), each with `file:line`. No box art. Derived purely from the extracted `JourneyGraph` + meta.
- **Acceptance Criteria**:
  - `hogsend journeys graph <id> --format summary` emits stable markdown.
  - Every send/wait/branch line carries its source pointer.
  - Snapshot test in `journeys-graph-command.test.ts`.

### Task A.2: Reorder docs + help toward agents

- **Location**: `apps/docs/content/docs/cli/journeys.mdx`, CLI usage string
- **Description**: Lead examples with `graph <id>` (mermaid), `--json`, `--format summary`; move `--format ascii` to a "for terminals" aside. State explicitly that mermaid is the default because it round-trips into docs/decks/mermaid.live and is agent-parseable.
- **Acceptance Criteria**: Docs examples ordered mermaid → json → summary → ascii.

## Sprint B: Node Intelligence (feedback #2 + #3)

**Goal**: Nodes are actionable — email nodes preview their template, every node deep-links to code.

### Task B.1: Resolve template refs at extraction time (the "AST our way" step)

- **Location**: `packages/core/src/graph/types.ts`, `packages/cli/src/lib/journey-graph.ts`
- **Description**: Add optional `templateKey` (resolved literal, e.g. `churn.payment_failed`) and `templateRef` (authored text, e.g. `Templates.CHURN_PAYMENT_FAILED`) to `GraphNode`. Resolve `Templates.X` by following the import to the consumer's constants file and reading the `as const` initializer (pure syntax walk, same as the extractor today). String literals resolve trivially; runtime-computed refs stay unresolved and are surfaced honestly (`templateKey: undefined`).
- **Acceptance Criteria**:
  - `churn-prevention` email nodes carry resolved `templateKey`s.
  - Studio's `normalizeTemplateKey` join hack in `journey-flow.tsx` becomes a fallback only.
  - Manifest/JSON output remains backward compatible (new fields optional).
  - Extractor unit tests: literal, `Templates.X` via import, unresolvable dynamic.

### Task B.2: Template preview in the node panel

- **Location**: `packages/studio/src/views/journeys/journey-flow.tsx`, `packages/studio/src/lib/admin-api.ts`
- **Description**: For email nodes with a resolved `templateKey`, call the existing `getTemplatePreview(key)` (`GET /v1/admin/templates/:key/preview`) and render subject + a scaled-down HTML preview (sandboxed iframe, `srcDoc`, no scripts) in the side panel. Fetch only on node select; graceful empty state for unresolved/unknown keys.
- **Acceptance Criteria**:
  - Selecting an email node in `churn-prevention` shows subject + rendered preview.
  - Unknown/dynamic template → "template not resolved from source" note, no error toast.
  - No preview fetch until an email node is selected.

### Task B.3: IDE deep links

- **Location**: `packages/studio/src/views/journeys/journey-flow.tsx`, new `packages/studio/src/lib/ide-links.ts`
- **Description**: "Open in IDE" button next to the existing `file:line` pointer. URL template configurable (localStorage setting, default `vscode://file/{path}:{line}`; presets for Cursor `cursor://file/…`, JetBrains). Needs an absolute path: add optional `projectRoot` to the manifest (written by `graph --all` from `--cwd`), and only render the button when the API says the manifest was generated locally (or a Studio setting supplies the root). Hosted/remote Studio: hide the button, keep the copy fallback — never leak server paths.
- **Acceptance Criteria**:
  - Local dev: clicking opens VS Code/Cursor at the exact line.
  - Remote/hosted: button hidden, copy still works.
  - IDE choice persists (localStorage).

### Task B.4: Kind-specific panel content

- **Location**: `packages/studio/src/views/journeys/journey-flow.tsx`
- **Description**: Panel sections per kind — `branch`: condition + yes/no targets; `wait`: event, timeout, parked users (exists); `sleep`/`schedule`: duration/when expression; `trigger`/`trigger-event`/`exit`: event contract. Replaces the current one-size-fits-all layout.
- **Acceptance Criteria**: `feedback-nps` and `churn-prevention` panels read clearly without raw JSON.

## Sprint C: Layout + Two-Column (feedback #4 + #5)

**Goal**: The flow reads cleanly at a glance, and Definition + Flow coexist on desktop.

### Task C.1: Dagre tuning pass

- **Location**: `packages/studio/src/views/journeys/journey-flow.tsx`
- **Description**: Tune `nodesep`/`ranksep`/`edgesep`/`ranker` (try `tight-tree`), give exits/end lower rank weight so they don't dominate early rows, size nodes by content instead of fixed 220×90 where feasible, keep edge labels off nodes.
- **Acceptance Criteria**: Screenshot compare `churn-prevention` + `feedback-nps` + largest journey: no overlapping labels, branch arms visibly separated.

### Task C.2: Layout modes (TB / LR / compact)

- **Location**: same file
- **Description**: Toolbar segmented control; `fitView` after switch; persist per-user (localStorage).
- **Acceptance Criteria**: Mode switch re-lays-out without refetching; preference persists.

### Task C.3: Two-column Definition + Flow on desktop

- **Location**: `packages/studio/src/views/journey-detail-view.tsx`
- **Description**: ≥`xl`: Definition (meta card) left column, Flow right column, both visible — tab strip collapses to `Funnel` and other tabs only. <`xl`: keep current three tabs. Session-persist the choice.
- **Acceptance Criteria**:
  - 1440px: meta + canvas side-by-side, no nested-card clutter, canvas ≥60% width.
  - 390px: tabs, no horizontal scroll.

### Task C.4: ELK spike (timeboxed, decision doc)

- **Location**: prototype branch only
- **Description**: 1-day spike: ELK layered layout on the 3 reference journeys vs tuned dagre. Adopt only if visibly better AND bundle/latency acceptable; otherwise write the decision down and close.
- **Acceptance Criteria**: Comparison screenshots + decision note in PR; no half-adopted second engine.

## Sprint D: Deck-Grade Exports (feedback #6)

**Goal**: The diagram travels — decks, pitches, docs.

### Task D.1: Framed PNG export

- **Location**: `packages/studio/src/views/journeys/journey-flow.tsx`
- **Description**: Wrap the exported bounds with journey title, generated-at timestamp, and a compact kind legend; 2x pixel density option for retina decks.
- **Acceptance Criteria**: Exported PNG legible in a 16:9 slide, no clipped labels/controls.

### Task D.2: "Open in mermaid.live" in Studio

- **Location**: same toolbar; reuse `mermaidLiveUrl` (move from `packages/cli/src/lib/mermaid-live.ts` into `@hogsend/core` or duplicate the ~30-line pako encoder in studio)
- **Description**: Button next to Copy Mermaid; opens the current diagram in mermaid.live for restyling/exporting — the sales-pitch path without leaving the browser.
- **Acceptance Criteria**: Round-trips: opened diagram matches the copied Mermaid.

## Sprint E: Hardening (freshness + CI)

### Task E.1: `pnpm graph:journeys` root script

- **Location**: root `package.json`, `apps/api/package.json`
- **Description**: One command regenerates manifest (+ optional fumadocs mirror) for `apps/api`: `hogsend journeys graph --all --cwd apps/api --source src/journeys`.
- **Acceptance Criteria**: Fresh manifest from repo root in one command; no accidental markdown writes.

### Task E.2: CI staleness + parse check

- **Location**: CI config / a vitest whole-app smoke in `packages/cli/src/__tests__/`
- **Description**: Discover every `apps/api/src/journeys/*.ts`, extract, render Mermaid, parse (mermaid parser dev-dep), diff source hashes against the committed manifest. Fails on drift or parse error.
- **Acceptance Criteria**: Editing a journey without regenerating the manifest fails CI; all current journeys pass.

### Task E.3: Expand API contract tests

- **Location**: `apps/api/src/__tests__/admin-journey-graph.test.ts`
- **Description**: Assert parser-safe Mermaid, per-node counts join (`countKey` ↔ `currentNodeId`), stale flag both ways, metadata fallback, new `templateKey` field passthrough.
- **Acceptance Criteria**: Route output verified against the core renderer; manifest fallback covered.

## Sequencing

1. **Sprint A** (S — ~1d): pure CLI/docs, no UI risk, immediate agent win.
2. **Sprint B** (M — ~3-4d): B.1 unblocks B.2; B.3/B.4 parallel. The headline demo ("click a node, see the email, jump to code").
3. **Sprint C** (M — ~2-3d): C.1 before C.2; C.3 independent; C.4 timeboxed last.
4. **Sprint D** (S — ~1d): cosmetic, safe anytime after C.1.
5. **Sprint E** (S — ~1d): anytime; E.2 ideally before merging B.1 (manifest schema change).

Ship order for review feedback visibility: **A → B.2+B.3 → C.3 → C.1 → rest**.

## Potential Risks & Gotchas

- **Template ref resolution is best-effort**: import-following covers `Templates.X` from the consumer constants file; re-exports, computed keys, and cross-package constants stay unresolved. UI must say "dynamic" honestly, never guess.
- **IDE links leak paths**: absolute paths only ever come from a locally-generated manifest or an explicit Studio setting. Hosted Studio must not expose server cwd.
- **Preview iframes**: template HTML is consumer-authored; render in a sandboxed `srcDoc` iframe (no `allow-scripts`) — the docs Mermaid XSS lesson applies here too.
- **Dagre limits**: reconverging branches may resist tuning; that's what the ELK spike decides. Don't hand-roll layout.
- **Manifest schema additions**: `templateKey`/`projectRoot` are optional fields; the route and Studio must tolerate old manifests (E.3 covers this).

## Rollback Plan

- Sprint A is additive CLI surface — revert freely.
- B.1 manifest fields are optional; Studio falls back to today's `normalizeTemplateKey` join.
- B.2/B.3 are panel-local; hide behind the existing panel without touching the canvas.
- C.3 keeps the tab code path as the mobile branch — reverting is deleting the `xl` branch.
- D/E are independent leaf features.

## Resolved questions (from v1)

1. **Split vs tab**: split on desktop (≥xl), tabs on mobile — per design review ("perhaps they can exist together in two columns").
2. **IDE priority**: configurable URL template, VS Code default, Cursor preset — localStorage, not env.
3. **Preview props**: static template example props via the existing preview route (already injects engine defaults); journey-derived sample props are a later nicety.
