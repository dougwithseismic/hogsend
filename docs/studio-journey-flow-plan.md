# Studio Journey Flow — visual workflow, per-stage metrics, mermaid/PNG export, node email preview

**Status:** planned → building (autonomous-loop-ultracode). Owner surface: `packages/studio` + `packages/engine` + `packages/core`.

## Goal (from Doug)

When you click into a journey in Studio, today you get: Definition card, a 5-bar
Funnel, an Email table (iframe preview), and an Instances browser. Expand the
"Email"/visual dimension into a **beautiful, visual workflow graph**:

1. Render the journey as a **React Flow** (`@xyflow/react`) node graph — Start →
   sleeps → email sends → `waitForEvent` branches → terminal (completed / exited /
   failed). Nodes derived from the journey's `run()` via **AST** parsing.
2. **Per-stage metrics** overlaid on each node: how many are *live* there now, how
   many *reached* it, how many *failed* at it, and send-engagement (sent/opened/
   clicked). This plan defines exactly how those metrics are produced.
3. **Copy as Mermaid** (clipboard) + **Open in mermaid.live** (deep link).
4. **Export the visual workflow as PNG.**
5. Click a node → **right detail panel**. For an email node: render the template
   preview; plus a dev-only **"Open in default browser"** button that (when the
   engine runs locally) literally launches the developer's default browser.

Build phase-by-phase; each phase is build → verify → commit. Show Doug a **live
Railway preview before any merge** (brand/product surface rule).

---

## Grounding facts (verified in code, 2026-07-08)

- **`run()` source is NOT reachable at runtime.** `defineJourney(opts)` returns
  `{ meta, task }` and closes over `opts.run` inside `task.fn` — it is never
  exposed. `JourneyRegistry` stores **zod-parsed `JourneyMeta` POJOs only**
  (`packages/core/src/registry/index.ts`). So to build a graph we must **capture
  `opts.run.toString()` at definition time** and parse it.
- **Bundler does not minify.** No `minify` in any tsup config (`apps/api/tsup.config.ts`
  default `minify:false`). So `run.toString()` yields **non-minified JS** in both
  dev (tsx/esbuild per-file) and prod (bundled). Method accesses (`.sleep`,
  `.waitForEvent`, `.checkpoint`, `.trigger`), string literals (`label`, `template`,
  `event`), and `if/else` structure all survive → a **standard-JS parser (acorn)**
  can walk it. Local/param identifiers (`ctx`, `sendEmail`) are preserved without
  minify; import bindings can rename on collision (e.g. `sendEmail2`) → detect send
  nodes **structurally** (call arg object has a `template:` / `to:` key), not by callee name.
- **Node identity == authored label.** Every durable primitive writes
  `journeyStates.currentNodeId = <label>` (`journey-context.ts`): `checkpoint(label)`,
  `sleep({label})` (default `wait:${JSON.stringify(duration)}`), `sleepUntil` (default
  `wait-until:${iso}`), `waitForEvent({label})` (default `wait-event:${event}`). Entry
  sets `currentNodeId:"start"`. So an **AST node keyed on the label shares its id with
  the live `currentNodeId` metric** — this is the join key.
- **`journey_logs` exists but is NEVER written** (`grep insert(journeyLogs)` → 0 hits).
  Columns: `journeyStateId, fromNodeId, toNodeId, action(text, no enum), detail(jsonb)`.
  The admin instance-drawer already renders `logs[]` (always empty today). Populating
  it is the substrate for the true per-node *reached* funnel — additive, no reader changes.
- **Metrics we can compute today (no schema change):**
  - live-at-node: `SELECT current_node_id, count(*) FROM journey_states WHERE journey_id=$id AND status IN ('active','waiting') AND deleted_at IS NULL GROUP BY current_node_id`
  - terminal distribution: `... status IN ('completed','failed','exited') GROUP BY status`
  - failed-at-node (approx): `... status='failed' GROUP BY current_node_id` (currentNodeId = last durable step before throw; NOT reset on failure/resume)
  - send-node engagement: `emailSends INNER JOIN journeyStates ON emailSends.journeyStateId=journeyStates.id WHERE journeyId=$id GROUP BY templateKey` → `count(*) filter (where sentAt/openedAt/clickedAt is not null)`. **`emailSends` has NO `journeyId`** — always join via `journeyStateId`. Always filter `isNull(journeyStates.deletedAt)`.
  - `sql<number>` from Postgres returns **strings** → wrap in `Number()`.
- **Admin route pattern** (`packages/engine/src/routes/admin/journeys.ts`): `createRoute({method,path,tags,summary,request:{params/query/body zod},responses})` then `.openapi(route, async (c)=>{ const {db,registry}=c.get("container"); const {id}=c.req.valid("param"); if(!registry.has(id)) return c.json({error:"Journey not found"},404); ... return c.json({...},200); })`. Chain onto `journeysRouter`; it is already mounted at `/v1/admin/journeys` behind `requireAdmin`+`rateLimit`+`auditMiddleware` (`routes/admin/index.ts`). New top-level prefix → `adminRouter.route("/prefix", xRouter)`.
- **Template preview** (`routes/admin/templates.ts`): `GET /v1/admin/templates/{key}/preview` → JSON `{key,subject,category,html,text}`; `?format=html` → raw standalone HTML doc. Props precedence `engineInjectedDefaults(key) < definition.examples < caller props(base64 JSON)`. **Side-effect-free** (fake unsub URL, no `email_sends`/`tracked_links` write). A journey email node's `sendEmail({template})` arg **is** the registry `key` **is** the preview `{key}` — feed it straight in.
- **Studio == same process as engine in dev.** Engine `mountStudio()` serves the built SPA at `/studio/*` from the same HTTP process (`PORT` default 3002). So a dev-only engine route can shell out to the developer's OS. No `child_process`/`open` usage exists anywhere yet (net-new surface — gate hard). Dev-only gate precedent: `app.ts` gates `/docs` behind `env.NODE_ENV!=="production"`; localhost host-check helper exists in `routes/admin/analytics.ts` (`host==="localhost"||"127.0.0.1"||"[::1]"||endsWith(".localhost")`).
- **Studio frontend**: Vite 6 SPA, base `/studio/`, TanStack Router (flat, code-based; `journeyDetailRoute` path `/journeys/$journeyId`, param passed as prop). Tailwind **v4 config-in-CSS** — tokens live in `@theme{}` in `src/index.css` (crimzon: `--color-accent:#f64838`, `--color-accent-deep`, `--color-raised:#0a0606`, `--color-hairline-faint:rgba(255,255,255,0.08)`, `--color-ink`, card = `bg-white/[0.015] border-hairline-faint`, muted text `text-white/60`). `cn()`=`twMerge(clsx())`. react-query + `qk` factory + thin `api.get/post` (cookie auth) in `lib/admin-api.ts`. **No graph/canvas/PNG/download dep exists.** `@hogsend/studio` is published on the engine version line but ships **only built `dist`** (consumers serve it static — they do not bundle its source), so studio-only deps do NOT need the create-hogsend `_package.json` CJS→ESM mirror. Confirm during release.

---

## Architecture decisions (locked)

- **A1 — Graph structure via runtime `run.toString()` + acorn, not build-time ts-morph.**
  Rationale: the Studio is a **generic engine-shipped SPA** that must work against
  any consumer's journeys with **zero build step**. Capture the source string at
  `defineJourney` time (it is right there), parse **lazily** with acorn in the admin
  route (cached per id, so no boot cost and acorn only loads in the API process, not
  the worker). Degrade gracefully to a **meta+observed-labels** graph if source is
  absent or the parse throws. Extraction must **never throw out of `defineJourney`
  or the route**.
- **A2 — Node id = authored label (join key to `currentNodeId`).** Sends inherit the
  nearest wait/checkpoint label as their idempotency "site"; a send node id =
  `send:<idempotencyLabel ?? nearestLabel ?? template>`. Encourage authored labels
  (synthetic `wait-until:<iso>` is high-cardinality — fine to display, but note it).
- **A3 — Metrics in two layers.** (i) Cheap, retroactive, no-schema: live-at-node +
  terminal + send-engagement (works on existing data). (ii) Precise reached/failed
  funnel: **populate `journey_logs`** going forward. The graph endpoint overlays
  whatever is available and degrades cleanly (a node with no metric shows "—").
- **A4 — In-page tab, not a sub-route.** Add an `Overview | Flow` tab toggle inside
  `JourneyDetailView` via local `useState` (matches the flat-route + prop-drill
  convention). No deep-link requirement for v1.
- **A5 — Hand-rolled layered DAG layout, no dagre.** Journeys are small, mostly-linear
  DAGs. A deterministic longest-path layering (rank → y, sibling index → x) is ~80
  lines and dep-free. Escape hatch: add `@dagrejs/dagre` only if branch layouts look bad.
- **A6 — Export deps:** `@xyflow/react` (graph), `html-to-image` (PNG via RF's
  documented `toPng`+`getNodesBounds`/`getViewportForBounds` recipe), `pako`
  (mermaid.live `pako:` deep-link encoding). Mermaid *text* is pure string-gen (no dep).
- **A7 — "Open in default browser" = dev-only engine spawn route**, plus a
  zero-server-code `window.open(preview?format=html)` "Open in new tab" as the always-on
  fallback. The spawn route is the literal ask (launches the *default* browser, not a
  tab in the current one) and is hard-gated (non-prod + localhost + `spawn` with argv).

---

## Graph IR (the contract) — lives in `@hogsend/core`

```ts
// packages/core/src/journey-graph/types.ts  (new)
export type JourneyNodeType =
  | "start" | "sleep" | "sleepUntil" | "wait" | "send" | "connector"
  | "checkpoint" | "trigger" | "capture" | "branch"
  | "end-completed" | "end-exited" | "end-failed" | "unknown";

export interface JourneyNode {
  id: string;                 // == authored label where possible (joins to currentNodeId)
  type: JourneyNodeType;
  title: string;              // human label for the node header
  subtitle?: string;          // e.g. duration "14 days", event name, template key
  meta?: {
    duration?: Record<string, number>;   // DurationObject for sleep
    timeout?: Record<string, number>;     // waitForEvent timeout
    event?: string;                        // wait/trigger event
    template?: string;                     // send templateKey (→ preview)
    idempotencyLabel?: string;
    connectorId?: string; action?: string;// sendConnectorAction
    conditions?: unknown[];                // PropertyCondition[] for trigger/exit/where
    unstable?: boolean;                    // true if id is synthetic/high-cardinality
  };
  line?: number;              // source line (best-effort, for "jump to code")
}

export interface JourneyEdge {
  id: string;
  source: string; target: string;
  label?: string;             // "14 days", "answered", "timed out", "score ≤ 6"
  kind?: "default" | "timedOut" | "answered" | "conditional-true" | "conditional-false";
}

export interface JourneyGraph {
  journeyId: string;
  nodes: JourneyNode[];
  edges: JourneyEdge[];
  degraded?: boolean;         // true when built without source (meta+labels fallback)
  warnings?: string[];        // e.g. "loop not fully expanded", "dynamic template"
}
```

Zod schema alongside (`journeyGraphSchema`) so the admin route response validates.

---

## Phases

Legend: each phase lists **Goal · Files · Work · Verify · Commit**. `[ ]` unchecked.

### Phase 0 — Graph IR types + schema (`@hogsend/core`)  `[x]`
- **Goal:** the shared `JourneyGraph`/`JourneyNode`/`JourneyEdge` types + zod schema,
  exported from `@hogsend/core` and re-exported from `@hogsend/engine`.
- **Files:** `packages/core/src/journey-graph/types.ts` (new), `.../schema.ts` (new),
  `packages/core/src/index.ts` (+ export), `packages/engine/src/index.ts` (re-export).
- **Verify:** `pnpm --filter @hogsend/core check-types`; tiny vitest asserting the schema
  parses a hand-written sample graph and rejects a malformed one.
- **Commit:** `feat(core): journey graph IR types + schema`

### Phase 1 — Runtime AST extractor (`@hogsend/engine`)  `[x]`  ⟵ hardest, test-heavy
- **Goal:** `buildJourneyGraph({ runSource, meta }) → JourneyGraph`, and the plumbing to
  make `runSource` reachable in the API process.
- **Work:**
  - `pnpm --filter @hogsend/engine add acorn acorn-walk` (pure-JS, ESM, tiny; bundles fine).
  - `defineJourney`: capture `const runSource = safeRunSource(options.run)` (try/catch →
    `undefined`) and add it to `DefinedJourney` as `runSource?: string`. **Must not change
    execution or throw.**
  - Thread sources to the API: in `packages/engine/src/journeys/registry.ts` build a
    `Map<id, string>` of enabled journeys' `runSource` and install a
    **`journeySources` singleton** (mirror `registry-singleton.ts`); expose on the
    container as `client.journeySources` (`container.ts` near `registry`). Worker doesn't
    need it, but building the map is cheap and both processes call `createHogsendClient`.
  - `packages/engine/src/journeys/graph/build-graph.ts` (new): parse `runSource` with
    `acorn.parse(src,{ecmaVersion:"latest",allowReturnOutsideFunction:true})`; locate the
    run arrow/function body; walk statements in source order building nodes/edges:
    - **START** node from `meta` (`trigger.event` + `trigger.where` chips).
    - `await ctx.sleep|sleepUntil|waitForEvent|checkpoint|trigger(...)` → nodes; pull the
      string-literal `label`/`event`/`template`, `DurationObject` literal for
      `duration`/`timeout`. `waitForEvent` → a **branch** node with two out-edges
      (`answered` / `timedOut`) wired to the statements in the following `if
      (answer.timedOut)` / else. Recurse into `IfStatement` branches; merge after.
    - Bare `await sendEmail({...})` / `sendConnectorAction({...})` → `send`/`connector`
      nodes (detect send by `template:`/`to:` key so a renamed import still matches).
    - `getPostHog()?.capture(...)` → `capture` node (annotate "not idempotent").
    - `return` inside a branch → edge to `end-completed`; end of body → `end-completed`.
    - Terminal `end-exited` (if `meta.exitOn`) + `end-failed` (retries:0, always
      reachable) rendered as muted terminal nodes.
    - Unrecognized `await` of an unknown callee → `unknown` node (never silently drop;
      keeps the graph honest). Loops (`while`/`for`) → wrap body once + `warnings`.
  - **Fallback** `degradedGraphFromMeta(meta)` when `runSource` missing/parse throws:
    START → (one node per distinct label seen — filled later by the route from live
    `currentNodeId`s) → END, `degraded:true`.
- **Verify:** vitest `build-graph.test.ts` over **real journey sources** captured as
  fixtures (import the actual journeys and read their `.runSource`): assert node/edge
  shape for `feedback-nps` (sleep→send→wait[branch]→send→wait→checkpoint→trigger),
  `activation-nudge-series` (4 sleeps + conditional sends), `discord-lifecycle`
  (connector-only, no ctx), `link-click-campaign` (`_ctx`). Assert graceful fallback on
  garbage source. `pnpm --filter @hogsend/engine check-types`.
- **Commit:** `feat(engine): AST-based journey graph extractor`

### Phase 2 — `journey_logs` transition writer (`@hogsend/engine`)  `[ ]`
- **Goal:** finally populate `journey_logs` so per-node *reached*/*failed* funnels and the
  instance-drawer timeline become real. Additive; readers already exist.
- **Work:** `logTransition({db, journeyStateId, from, to, action, detail?})` helper
  (best-effort, `.catch` swallow — **never** reject into the journey hot path). Emit:
  - `entered` (`from:null → to:"start"`) at enrollment insert (`define-journey.ts`).
  - `checkpoint` in `ctx.checkpoint`.
  - `sleep`/`wait` at `enterWait` (`from:<prev> → to:<label>`), `resume` at
    `resumeFromWait`, with `detail` = `{duration}`/`{timedOut}` where known.
  - `send` from the tracked mailer when `journeyStateId` present. **`to` MUST be
    `send:<site>` (site = `idempotencyLabel ?? boundary.currentLabel ?? template`) —
    the SAME site the mailer already computes for the exactly-once idempotency key —
    NOT `send:<template>`.** This is the id `buildJourneyGraph` emits for the send node
    (A2), so the log row joins the graph node directly. Put the resolved `template` (the
    real key) + `emailSendId` in `detail`. (Keying by template would fail to disambiguate
    a journey that sends the SAME template twice on different branches — e.g. feedback-nps'
    `nps-survey` vs `nps-reminder` — whereas the site distinguishes them.)
  - `trigger` in `ctx.trigger`.
  - `completed`/`failed`/`exited` at the terminal writes (`define-journey.ts`, and the
    exit path in `ingestEvent`/`checkExits`).
  - Track "previous node" via the boundary's `currentLabel` (already maintained).
  - **Replay note:** a replay re-logs (duplicate rows) — fine for a timeline; reach-counts
    must use `count(DISTINCT journey_state_id)` per `to_node_id`. Document this.
- **Verify:** `/verify` smoke (run real API+worker on a fresh DB, enroll a user in
  `feedback-nps` via `POST /journeys/:id/enroll`, assert `journey_logs` rows appear and
  `GET /journeys/:id/states/:sid` returns a non-empty `logs[]`). `check-types`.
- **Commit:** `feat(engine): write journey_logs transitions for per-stage metrics`

### Phase 3 — Graph + metrics admin endpoint (`@hogsend/engine` + studio client)  `[ ]`
- **Goal:** `GET /v1/admin/journeys/:id/graph` → `{ graph, metrics }`.
- **Work:**
  - New handler on `journeysRouter`. Resolve `meta` via `registry.get(id)` (404 if absent);
    `runSource` via `container.journeySources.get(id)`; build+**cache** the IR
    (`Map<id,JourneyGraph>` module cache; source is static per process).
  - `metrics`: `{ enrolled, terminals:{completed,failed,exited}, nodes: Record<nodeId,
    { live, reached, failed, sent?, opened?, clicked? }> }`.
    - `live`/`failed` per node from `journey_states` grouped by `current_node_id`.
    - `reached` per node from `journey_logs` `count(distinct journey_state_id)` by
      `to_node_id` (0/absent if not flowing yet).
    - send-node `sent/opened/clicked` join onto the `send:<site>` node id **via the
      Phase-2 `journey_logs` row** (`to_node_id = send:<site>`, `detail.emailSendId` → the
      `email_sends` row for engagement, `detail.template` for display). Do NOT map
      `email_sends.templateKey` onto a `send:<template>` id — the graph's send ids are
      site-based (A2), and template-keying can't disambiguate two sends of one template.
      Fallback for a journey with no `journey_logs` yet: parse `<site>` out of the existing
      `email_sends.idempotencyKey` (`journeySend:<anchor>:<site>:<template>`).
    - All queries filter `isNull(deletedAt)`; wrap `sql<number>` in `Number()`.
  - Studio: `getJourneyGraph(id)` in `admin-api.ts` + `qk.journeyGraph(id)` + response TS type.
- **Verify:** vitest route test (`app.request`) asserting shape for a seeded journey with a
  couple of states; 404 for unknown id. `check-types`.
- **Commit:** `feat(engine): journey graph + per-stage metrics endpoint`

### Phase 4 — Dev-only "open in default browser" route (`@hogsend/engine`)  `[ ]`
- **Goal:** `POST /v1/admin/dev/open-preview { key, props? }` that launches the developer's
  **default browser** on a rendered template — only when the engine runs locally.
- **Work:** new `devRouter` mounted `adminRouter.route("/dev", devRouter)` (inherits
  `requireAdmin`). Handler **hard-gates** (return 404 unless
  `env.NODE_ENV!=="production"` **and** request host is localhost/127.0.0.1/[::1]/.localhost).
  Reuse the exact preview render path (`engineInjectedDefaults(key) < examples < props`,
  `getTemplate`, `renderToHtml`). Write HTML to `os.tmpdir()/hogsend-preview-<randomUUID>.html`
  (`node:fs/promises`, `node:os`, `node:crypto`). Launch via `node:child_process.spawn`
  **with argv array** (never a shell string): darwin→`open`, linux→`xdg-open`,
  win32→`cmd /c start ""`. `{stdio:"ignore", detached:true}` then `.unref()`. Return
  `{status:"opened"}`. **Never** touch the send pipeline (side-effect-free preview only).
- **Verify:** vitest — 404 when `NODE_ENV=production`; 404 for a non-localhost `Host`
  header; 200 (mock `spawn`) on localhost+dev. `check-types`.
- **Commit:** `feat(engine): dev-only open-template-preview-in-browser route`

### Phase 5 — React Flow view + node detail + export (`@hogsend/studio`)  `[ ]`
- **Goal:** the visual workflow the user described.
- **Work:**
  - `pnpm --filter @hogsend/studio add @xyflow/react html-to-image pako` + `add -D @types/pako`.
  - Import RF CSS once: `@import "@xyflow/react/dist/style.css";` in `src/index.css` **after**
    `@import "tailwindcss";`. Theme its CSS vars crimzon (`--xy-*` → `var(--color-*)`).
  - `views/journeys/journey-flow.tsx`: fetch `getJourneyGraph(id)`; map IR → RF nodes/edges;
    **hand-rolled layered layout** (`views/journeys/flow-layout.ts`, A5). Custom node
    components per type (crimzon cards: `bg-white/[0.015] border-hairline-faint`, accent for
    branch/terminal), each showing its **metrics badges** (live / reached / failed / sent·
    opened·clicked). Edge labels (duration, "timed out"/"answered", condition). RF
    `Background`, `Controls`, `fitView`, `min-h-0 h-[70vh]`, StrictMode-idempotent init.
  - **Node detail panel** (right column or Drawer): on node click →
    - email/send node: `getTemplatePreview(template)` in an iframe (mirror
      `template-detail.tsx`); **"Open in new tab"** → `window.open(baseUrl+"/v1/admin/templates/"+key+"/preview?format=html")`; **"Open in default browser"** → `POST /v1/admin/dev/open-preview` (button shown always, but on non-2xx/404 show a toast "only available when the engine runs locally").
    - wait/branch/sleep/trigger nodes: event, timeout/duration, conditions, and the node's
      live/reached/failed counts.
  - **Toolbar:** `Copy Mermaid` (`toMermaid(graph)` pure string-gen → `navigator.clipboard`
    + toast), `Open in mermaid.live` (`pako.deflate` → base64url → `https://mermaid.live/edit#pako:<...>`,
    `window.open`), `Export PNG` (RF `getNodesBounds`+`getViewportForBounds`+`html-to-image`
    `toPng`, then a `downloadDataUrl()` helper — `<a download>` click; none exists, write it
    in `lib/download.ts`), `Fit view`.
  - `lib/mermaid.ts` (`toMermaid(graph): string`, flowchart TD; node shapes per type; edge
    labels; escape text) — pure, unit-testable.
  - Wire an `Overview | Flow` tab into `JourneyDetailView` (A4). Loading/empty/error/`degraded`
    banner states.
- **Verify:** `pnpm --filter @hogsend/studio check-types` + `build`; vitest for `toMermaid`
  + `flow-layout` (pure fns); **Claude-in-Chrome smoke** against local Studio (run engine+studio,
  open `/studio/journeys/feedback-nps`, switch to Flow, screenshot, click an email node → preview,
  click a toolbar button). GIF the interaction.
- **Commit:** `feat(studio): visual journey flow with metrics, mermaid + PNG export, node email preview`

### Phase 6 — Polish, docs, changeset, release-prep  `[ ]`
- **Goal:** ship-ready.
- **Work:** empty/degraded states; crimzon dark polish of RF; a11y (focus ring on nodes);
  `docs/operating/studio.mdx` (or the studio doc) — new Flow tab, metrics semantics
  (live vs reached vs failed; the journey_logs note), export buttons, dev open-in-browser
  guardrails; **changeset** covering the engine-line packages (`core`, `engine`, `studio`)
  + note whether `create-hogsend` needs a bump (studio ships dist only → likely not; verify);
  run `pnpm release:check`. **Do NOT merge/release** — hand to Doug for the live-preview gate.
- **Verify:** `pnpm lint`, `pnpm check-types`, `cd apps/api && pnpm test`, `pnpm --filter @hogsend/studio build`, `pnpm release:check`.
- **Commit:** `docs(studio): journey flow docs + changeset`

---

## Guardrails / gotchas (carry into every phase)

- Graph extraction is **best-effort and non-fatal** — a parse failure degrades the graph,
  never breaks `defineJourney`, the route, or a journey run.
- **Known v1 extractor limitations (honest degradation, not bugs):** side effects wrapped in
  a helper fn (e.g. `grantAndAnnounce(...)`) render as an `unknown` node + warning (the
  helper body isn't in `run.toString()`); a send whose options arrive via spread
  (`sendEmail({ ...base })`) also falls to `unknown` (keys aren't statically provable).
  Journeys authored with inline `sendEmail`/`ctx.*` (the recommended style) render fully.
  The extractor's node ids mirror the engine's runtime label semantics EXACTLY for
  deterministic cases (authored labels, `wait:{...}` from a reconstructed duration,
  `wait-event:<event>`), so the Phase-3 metrics join is exact there; dynamic/unresolvable
  ids are flagged `meta.unstable` and simply won't carry live metrics.
- `journey_logs` writes are **fire-and-forget**; they must not reject into the replay-safe
  journey hot path, and reach-counts use `count(DISTINCT journey_state_id)` (replays re-log).
- `currentNodeId` on failed/active rows = **last durable step**, not the exact failing line —
  label failure metrics as approximate.
- `sleepUntil` default labels embed an ISO timestamp = **high-cardinality**; mark such nodes
  `unstable` and prefer authored labels in graph titles.
- `emailSends` join to a journey is **only** via `journeyStateId` (no `journeyId` column);
  always `INNER JOIN` + `isNull(journeyStates.deletedAt)`.
- The dev open-in-browser route is the **first OS-shell surface** in the engine — keep it
  non-prod + localhost + `spawn`-with-argv + tmpdir-only, and never route through the real mailer.
- `@hogsend/studio` rides the engine version line; confirm at release whether the new deps
  reach `create-hogsend` consumers (studio ships built `dist` only → expected: no mirror needed).
- Follow the crimzon token conventions; show Doug the live preview **before** merge.

## Open items for Doug (surface at the Phase 5 preview gate, not blocking earlier phases)
- Confirm the visual direction (node styling, which metrics on the badge) against the live preview.
- mermaid.live via `pako:` deep link vs. just "Copy Mermaid" — keep both unless he prefers one.
