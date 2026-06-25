# Studio Co-Working Agent — Definitive Build Plan + Foundation Spec

Status: proposed (DEFINITIVE, replaces the MVP-scoped prior plan) · Engine line: 0.34.0 · Model: **GLM-5.2 (`z-ai/glm-5.2`)** via OpenRouter · Owner: Doug · Author: lead eng

This is the single source of truth for the **full best-in-class** Studio co-working agent. It supersedes the prior MVP plan, carries forward everything that plan nailed (engine streaming route under `adminRouter`, HMAC proposal-token HITL, Crimzon UX, `DebugDrawer` reuse, `env.ts`/route-registration conventions), and **expands** to the two-tier design: a **runtime Operate tier** (act on live data, no deploy) and a **code-authoring Author tier** (write real TypeScript, typecheck-repair, diff-approve, dev-apply or prod-PR).

---

## 1. TL;DR

We are building a **two-tier co-working agent** into Hogsend Studio, backed by **GLM-5.2 (`z-ai/glm-5.2`, 1M context)** on the Vercel AI SDK (`ai` v6) + OpenRouter, served by one built-in streaming route `POST /v1/admin/agent/chat` mounted under `adminRouter` (inherits `requireAdmin` + `rateLimit` + `auditMiddleware`; the browser never sees the OpenRouter key). The **Operate tier** acts on the live instance through the same existing `/v1/admin/*` and `/v1/*` endpoints Studio already calls — find/filter contacts, build ad-hoc audiences, fire events, send transactional/campaign, enroll, manage lists — every write gated by a server-minted, single-use, HMAC'd, TTL'd **proposal token** that a human approves and the server re-validates (test-mode re-resolved, tier re-derived) and executes idempotently. The **Author tier** writes real TypeScript into the consumer's `apps/api/src/` (journeys, buckets, email templates, constants, registries) into an **in-memory draft overlay**, runs `tsc --noEmit` + biome over the integrated result in a **bounded self-repair loop**, presents a unified **diff** the operator approves, then in **dev** writes the files to disk (tsx/hatchet hot-reload makes it live in seconds) or in **prod** opens a **GitHub PR** (read-only container → live only after CI + redeploy). The whole system is **one safety model**: the model can only ever *mint a proposal*; a human click on a separate `/confirm` route is the sole place any effect — a real send, a fired event, a written file, a PR — actually happens, re-validated and audited (`audit_logs` + git).

---

## 2. Capability matrix

Honest accounting of what each capability can do, in which tier, in which deploy mode. **"Prod-via-PR"** means the agent generates code, opens a PR, and the change is live only after CI builds the Docker image and Railway redeploys — never "live now".

| Capability | Runtime (Operate) tier | Authoring (Author) tier | Works in dev | Works in prod |
|---|---|---|---|---|
| **Find/filter contacts by event** ("did checkout_started in last 7d, never purchase") | yes — `find_contacts(byEvent)`: paginate `/v1/admin/events`, dedupe userIds, negative-filter, resolve contacts (O(events), capped + `truncated` flag) | n/a | yes | yes |
| **Build an ad-hoc audience** (criteria + live count + samples) | yes — `build_audience`: compile NL → `ConditionEval` via `criteriaBuilder`, resolve client-side into a **session-scoped** handle (no audience table exists) | n/a | yes | yes |
| **Create a persistent bucket** (reusable, campaign-targetable, auto-maintained) | no (no runtime bucket-write API) | yes — `create_bucket` writes `src/buckets/*.ts` + `index.ts`; backfill materializes members **async** on next boot | yes (write + hot-reload + backfill) | yes (PR → deploy → backfill) |
| **Write a journey** | no | yes — `create_journey`/`edit_journey` writes `src/journeys/*.ts` + `index.ts` + optional constants | yes (write + hot-reload re-registers task) | **prod-via-PR** |
| **Create/edit an email template** | no (templates are code-first React Email; no DB store, no runtime create) | yes — `create_email_template` (4-file: `.tsx`+`types.ts`+`registry.ts`+`templates.d.ts`); `edit_email_template` (precise JSX/subject/prop part-edit) | yes (write + in-process registry live) | **prod-via-PR** |
| **Edit a specific part of a template** (one CTA, the subject line) | no | yes — `edit_email_template` string-anchored surgical edit (one `<Button>`, `defaultSubject`, a prop default) | yes | **prod-via-PR** |
| **Edit subject line only** | no | yes — one-line edit to `registry.ts` `defaultSubject` | yes | **prod-via-PR** |
| **Fire an event** (drive journey triggers / bucket re-eval) | yes — `fire_event` → `POST /v1/events` → `ingestEvent()` (write_safe in test-mode, write_external otherwise) | n/a | yes | yes |
| **Send transactional email** | yes — `send_transactional_email` → `POST /v1/emails` (per-recipient preference-gated; delivered ≤ blast radius) | n/a (to a NEW template, only after that template is authored + live) | yes (test-mode → operator inbox) | yes (real send when domain verified) |
| **Send test email** (operator's own inbox, bypasses suppression) | yes — `send_test_email` → `POST /v1/admin/templates/{key}/send-test` | n/a | yes | yes |
| **Send a campaign** (one template → all members of a list OR bucket) | yes — `send_campaign` → `POST /v1/campaigns` (requires a **persistent** list/bucket id; refuses ad-hoc audiences) | only via promote→author→deploy→backfill before the bucket is targetable | yes (test-mode redirects) | yes |
| **Enroll a contact / audience in a journey** | yes — `enroll_in_journey` → `POST /v1/admin/journeys/{id}/enroll` (dispatches the trigger; entry guards still apply) | n/a | yes | yes |
| **List management** (subscribe/unsubscribe a contact) | yes — `subscribe_list` / `unsubscribe_list` → `POST /v1/lists/{id}/(un)subscribe` | a NEW list is `defineList` code (out of v1 author set) | yes | yes |
| **Contact CRUD** (upsert / update props / soft-delete) | yes — `upsert_contact`, `update_contact`, `delete_contact` (type-to-confirm) | n/a | yes | yes |
| **Add an event / template constant** | no | yes — `update_constants` edits `constants/{events,templates}.ts` (refuses key/value collision) | yes | **prod-via-PR** |

The hard line: **Operate mutates *data* through existing HTTP routes (live immediately); Author mutates *code* (live only after a process restart).** `promote_audience_to_bucket` is the one hinge that crosses from Operate into Author.

---

## 3. Architecture

```
 BROWSER — Studio SPA (Better Auth session cookie, credentials:"include")
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  AgentPanel (right slide-over) ── useChat (@ai-sdk/react) ───────────┐         │
 │   localStorage multi-chat (useSyncExternalStore)                     │ POST    │
 │   renders typed cards off message-stream PARTS:                      │ /v1/    │
 │     tool-call · write-confirm · DIFF · email-preview · audience      │ admin/  │
 │   [Approve & send] / [Approve & apply] / [Open PR]  ── POST /confirm │ agent/  │
 └─────────────────────────────────────────────────────────────────────┼─────────┘
                                                                         │ chat
 ENGINE — adminRouter ( requireAdmin → rateLimit → auditMiddleware )     ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  routes/admin/agent.ts                                                         │
 │   0. 503 agent_unconfigured if OPENROUTER_API_KEY unset (fail-closed)          │
 │   1. assembleContext(container)  → 1M manifest: A static exemplars/.d.ts        │
 │      (cache prefix) + B registries+mode+testMode + C live snapshot (last)       │
 │   2. streamText({                                                              │
 │        model: openrouter("z-ai/glm-5.2"),                                      │
 │        system: buildSystemPrompt(manifest),                                    │
 │        tools: { ...runtimeOperateTools, ...codeAuthoringTools, ...coreTools }, │
 │        stopWhen:[stepCountIs(64), hasToolCall("apply_changes"),                │
 │                  hasToolCall("propose_runtime_write")],                        │
 │        abortSignal: budget.signal, prepareStep: injectRepairContext,           │
 │      })                                                                        │
 │                                                                                │
 │  ┌── READ tool ──────────────────┐  ┌── RUNTIME WRITE tool ─────────────────┐ │
 │  │ execute() in-process vs        │  │ propose_runtime_write:                │ │
 │  │ container.db (same query the   │  │  derive tier from live domainStatus,  │ │
 │  │ GET /v1/admin/* route runs)    │  │  mint HMAC proposalId (Redis 10m),    │ │
 │  └────────────────────────────────┘  │  stream proposal part, END turn       │ │
 │                                       └────────────────────────────────────────┘
 │  ┌── AUTHORING tool ─────────────────────────────────────────────────────────┐│
 │  │ write_draft/edit_draft → in-memory overlay (allowlist apps/api/src/**)     ││
 │  │            │                                                               ││
 │  │            ▼  typecheck (tsc --noEmit over real-src+draft overlay)         ││
 │  │      ┌─ fail → {file,line,code,msg}[] → GLM self-repairs ─┐ (bounded ≤4)   ││
 │  │      └─ pass ─────────────────────────────────────────────┘               ││
 │  │            ▼  biome over changed drafts                                    ││
 │  │            ▼  apply_changes → mint authoring_apply proposal (unified DIFF) ││
 │  └────────────────────────────────────────────────────────────────────────────┘
 └───────────────────────────────────────┬────────────────────────────────────────┘
                  toUIMessageStreamResponse()  (Web Response, Hono returns it)
                                          │
            operator reviews the card, clicks Approve  ──► POST /v1/admin/agent/confirm { proposalId }
                                          ▼
 ENGINE confirm route — the ONLY place any effect happens (idempotent on proposalId):
   verify HMAC + TTL → burn (Redis SET NX) → re-resolve testMode → re-derive tier →
   ├─ RUNTIME  → call same internal handler the public endpoint uses (sendEmail /
   │             ingestEvent / POST /v1/campaigns), Idempotency-Key = proposalId
   └─ AUTHORING → re-gate typecheck/biome (draftHash match) → then:
        ├─ DEV  : write allowlisted files to apps/api/src → git commit (no co-author)
        │         → tsx/hatchet watcher restarts → task re-registers (~seconds)
        └─ PROD : refuse disk write → branch + write + commit + push + gh pr create
   → write audit_logs (actor = "studio-agent:<email>")  → outcome resumes the chat
```

The confirmation round-trip is **two physically separate routes**. The chat route can only *mint*; `/confirm` is the only one that *executes*. The LLM has no execute tool — structural, not policy.

---

## 4. Full tool catalog

`tier` = operate | author | core. `confirm`: `none` (reads, auto-run) · `confirm` (one-click HITL) · `type-to-confirm` (high blast / irreversible) · `diff-approve` (operator approves a rendered diff). Backing column is the verified route/service.

| # | name | tier | r/w/authoring | confirm | backing |
|---|---|---|---|---|---|
| 1 | `find_contacts` | operate | read | none | `GET /v1/admin/contacts` (search) · `/v1/admin/buckets/{id}/members` (byBucket) · `/v1/lists/preferences` (byList) · `/v1/admin/events?event&from&to` then resolve (byEvent) |
| 2 | `get_contact` | operate | read | none | `GET /v1/admin/contacts/{id}` (+ preferences) |
| 3 | `get_contact_timeline` | operate | read | none | `GET /v1/admin/contacts/{id}/timeline` |
| 4 | `query_events` | operate | read | none | `GET /v1/admin/events?event&userId&source&from&to&limit&offset` |
| 5 | `list_buckets` | operate | read | none | `GET /v1/admin/buckets` + `/{id}` |
| 6 | `list_lists` | operate | read | none | `GET /v1/lists` |
| 7 | `list_journeys` | operate | read | none | `GET /v1/admin/journeys` + `/{id}` |
| 8 | `list_sends` | operate | read | none | `GET /v1/admin/emails` + `/{id}` |
| 9 | `overview_stats` | operate | read | none | `GET /v1/admin/metrics/overview` |
| 10 | `preview_email` | operate | read | none | `GET /v1/admin/templates/{key}/preview?props=base64` (getTemplate → renderToHtml); staged render for a pending new template |
| 11 | `build_audience` | operate | read | none | `criteriaBuilder` + `evaluateCondition` composed over `GET /v1/admin/{events,contacts}` → session-scoped `AudienceHandle` (no audience table) |
| 12 | `fire_event` | operate | write | confirm | `POST /v1/events` → `ingestEvent()` (tier flips by test-mode) |
| 13 | `send_test_email` | operate | write | confirm | `POST /v1/admin/templates/{key}/send-test` (sanctioned suppression bypass → operator inbox) |
| 14 | `send_transactional_email` | operate | write | confirm | `POST /v1/emails` (per-recipient preference-gated) |
| 15 | `send_campaign` | operate | write | type-to-confirm | `POST /v1/campaigns` (list XOR bucket; refuses ad-hoc audiences) |
| 16 | `enroll_in_journey` | operate | write | confirm | `POST /v1/admin/journeys/{id}/enroll` (dispatches trigger; entry guards apply) |
| 17 | `subscribe_list` | operate | write | confirm | `POST /v1/lists/{id}/subscribe` |
| 18 | `unsubscribe_list` | operate | write | confirm | `POST /v1/lists/{id}/unsubscribe` |
| 19 | `upsert_contact` | operate | write | confirm | `POST /v1/admin/contacts` |
| 20 | `update_contact` | operate | write | confirm | `PATCH /v1/admin/contacts/{id}` |
| 21 | `delete_contact` | operate | write | type-to-confirm | `DELETE /v1/admin/contacts/{id}` (soft-delete; removes from all live queries) |
| 22 | `read_repo_file` | core | read | none | fs read over consumer root, allowlist `src/**` + `package.json` (read) + engine `*.d.ts` (eject.ts root-resolution idiom) |
| 23 | `typecheck` | core | read | none | `pnpm --filter @hogsend/api check-types` over the real-src+draft overlay; parsed tsc, truncated ~30 diagnostics; returns `draftHash` + repair-budget |
| 24 | `biome` | core | read | none | `pnpm biome check <changed drafts>` over the overlay |
| 25 | `write_draft` | author | authoring | none | in-memory draft overlay keyed by relative path; allowlist `apps/api/src/**` |
| 26 | `edit_draft` | author | authoring | none | exact-string replacement on a draft (or src pulled into drafts); same allowlist |
| 27 | `create_journey` | author | authoring | diff-approve | CREATE `src/journeys/{id}.ts`; EDIT `src/journeys/index.ts`; conditional EDIT `constants/{events,templates}.ts` |
| 28 | `edit_journey` | author | authoring | diff-approve | EDIT `src/journeys/{id}.ts` (+ constants if new keys) |
| 29 | `create_bucket` | author | authoring | diff-approve | CREATE `src/buckets/{id}.ts`; EDIT `src/buckets/index.ts` (import + **un-annotated** array + re-export) |
| 30 | `edit_bucket` | author | authoring | diff-approve | EDIT `src/buckets/{id}.ts` (warns: criteria-hash change → backfill on boot) |
| 31 | `create_email_template` | author | authoring | diff-approve | CREATE `src/emails/{name}.tsx`; EDIT `types.ts` + `registry.ts` + `templates.d.ts`; optional `constants/templates.ts` (one atomic 4-part proposal) |
| 32 | `edit_email_template` | author | authoring | diff-approve | precise part-edit: `target:"subject"` (registry) / `"jsx"`+anchor (one node) / `"prop"` (default + types) / `"section"` (props-gated block) |
| 33 | `update_constants` | author | authoring | diff-approve | EDIT `constants/events.ts` \| `constants/templates.ts` (refuse key/value collision) |
| 34 | `promote_audience_to_bucket` | author | authoring | diff-approve | **handoff**: hands an `AudienceHandle`'s `ConditionEval` to `create_bucket`; surfaces "live only after deploy + backfill (async)" |
| 35 | `apply_changes` | author | authoring | diff-approve | refuse unless typecheck+biome passed for the current `draftHash`; mint `authoring_apply` proposal carrying the unified diff (dev) / PR plan (prod) |
| 36 | `open_pr` | author | authoring | diff-approve | prod path invoked by confirm: branch from HEAD, write, conventional-commit (no co-author), push, `gh pr create`; agent reports "live after deploy" |
| 37 | `propose_runtime_write` | core | write | confirm | mints the runtime proposal (Redis 10m); executed by `/confirm` through the existing idempotent engine paths; `proposalId` = idempotency key; writes `audit_logs` |

> **`confirm_proposal` is NOT a model tool** — it is the human `POST /v1/admin/agent/confirm` endpoint. The `stopWhen` terminals (`apply_changes`, `propose_runtime_write`) refer to the model handing work to the operator, not self-confirming.

### v1 (FOUNDATION) subset — build NOW

Phase 0+1 ships only enough to **prove both loops end-to-end**, lowest blast radius:

- **Core/route:** `read_repo_file`, `typecheck`, `biome`, `write_draft`, `edit_draft`, `apply_changes`, `propose_runtime_write` (the chokepoints) + the `/chat` stream + `/confirm` route.
- **Operate reads (auto-run):** `find_contacts`, `get_contact`, `query_events`, `list_journeys`, `preview_email`, `list_buckets`.
- **One operate write (proves HITL):** `fire_event` (test-mode reclassification is the showcase).
- **Author surface deferred to Phase 3** — but the draft/typecheck/apply core tools (#22–26, #35) are foundation so the loop is real, not stubbed. `create_journey`/`create_bucket`/`create_email_template` are thin composers over `write_draft`/`edit_draft` and land in Phase 3.

Everything else (full operate writes, campaign, audience build, the named author tools, prod PR) lands Phase 2–4.

---

## 5. The code-authoring loop

The Author tier is the differentiator. It writes **real TypeScript** the operator can see, validated before it touches disk.

### write → typecheck → self-repair → diff → approve → apply

```
1. GLM calls a high-level author tool (create_journey / edit_email_template / …)
   which decomposes into write_draft + edit_draft calls →
   an in-memory DRAFT OVERLAY (relative-path keyed), NEVER disk.

2. typecheck — run `pnpm --filter @hogsend/api check-types` against an OVERLAY
   = real consumer src with the draft files swapped in. This is what catches the
   CROSS-FILE invariants GLM can't see alone:
     • templates.d.ts key with no matching registry.ts entry
     • a journey referencing Events.FOO that doesn't exist in constants
     • sendEmail({template, props}) whose props don't match TemplateRegistryMap[key]
     • a ': DefinedBucket[]' annotation that erased the buckets array's literal ids
   Parse tsc output → {file,line,code,message}[], truncate to ~30, return + draftHash.

3. self-repair (BOUNDED, max AGENT_TYPECHECK_REPAIR_BUDGET=4 passes on one draft set):
   on failure GLM re-emits the changed draft(s) and typechecks again. After 4
   failures, typecheck returns {ok:false, exhausted:true, advice} and the system
   prompt forces GLM to STOP and hand the diagnostics to the operator (no spiral).

4. biome — `pnpm biome check <changed drafts>` over the overlay. Must pass too.

5. diff — apply_changes produces a unified diff per file (oldContent vs newContent).
   It REFUSES unless typecheck+biome passed for the CURRENT draftHash (server gate —
   the model literally cannot apply un-typechecked code). It mints an
   authoring_apply proposal (Redis, 10m TTL) carrying the diff (dev) or PR plan (prod).

6. approve — operator sees the diff (+ inline email render for templates) in Studio,
   clicks Approve (diff-approve). POST /confirm re-validates the gate state.

7. apply — DEV vs PROD (below).
```

### DEV apply

1. **Git guard:** if on `main`, create `agent/authoring-<shortid>` and switch; else stay on current branch.
2. Write the approved files to the real `apps/api/src/...` paths (allowlist only), **per-file with a flush** (the codebase has no multi-file-atomic-write primitive; on mid-flow failure report which files landed, leave the rest as a still-pending proposal).
3. `git add` + one `git commit` per approved proposal (conventional message, **no co-author**) → **git is the undo** (`git revert`/branch).
4. Hot-reload is automatic, needs no agent action: `apps/api` runs `tsx watch src/index.ts`; the worker runs `hatchet worker dev` (watches `src/**/*.ts`, `reload:true`) or the `tsx watch src/worker.ts` fallback. File write → process restart → `import { journeys } from "./journeys/index.js"` re-evaluates → `selectJourneyTasks` re-registers every `defineJourney` task. New journey live in seconds. The agent **verifies** by polling `GET /v1/admin/journeys` (or `/buckets`) for the new id; templates are in-process registry lookups (live on next `preview`).
5. If `ENABLED_JOURNEYS`/`ENABLED_BUCKETS` is a CSV (not `*`), warn that the new id won't register until the env includes it + worker restarts — **never edit `.env`** (out of allowlist).

### PROD apply

Read-only container, no compiler — the only honest path is a **GitHub PR**:
1. Branch `agent/authoring-<shortid>` from `main`, write the approved files, conventional-commit (no co-author), push.
2. `gh pr create` with a body: operator intent + per-file diff + `preview_email` render for templates + "this is a code change — live after CI builds the image and Railway redeploys."
3. CI re-runs the same gates the agent passed locally; merge → Railway watchPattern → image rebuild → worker restart re-registers from bundled defs.
4. Studio shows the PR link + a persistent "Needs deploy" badge; the agent says **"PR #N opened — live after deploy,"** never "live now."
5. Fallback: if no git remote / `gh` auth, return the diff as a copy-paste block with paste instructions (the honest prod-without-CI path); never report a PR that wasn't created.

### The src-sandbox allowlist (server-enforced, never agent-trusted)

- **Write-allow:** `apps/api/src/journeys/**`, `apps/api/src/buckets/**`, `apps/api/src/emails/**`, `apps/api/src/lists/**`, plus the specific `constants/{events,templates,buckets}.ts`, `emails/{types.ts,registry.ts,templates.d.ts}`.
- **Hard-deny:** `packages/**` (engine + all engine packages), `node_modules`, `.env*`, `package.json`, `tsconfig*.json`, `docker-compose*`, `railway*.toml`, `Dockerfile`, `.git/`.
- **Read-allow (read_repo_file):** the write-allow set + `package.json` (read-only) + engine `*.d.ts`.
- **Path-traversal guard:** every proposed path is `path.resolve` + `realpath`-validated against the resolved consumer-src root; reject any `..` or symlink escape (the `eject.ts` "resolve root → validate → only-then write, explicit paths only" precedent).
- **No arbitrary shell:** the only commands the server runs are fixed allowlisted gates (`pnpm --filter @hogsend/api check-types`, `pnpm biome check <files>`) and fixed git/gh invocations whose only agent-supplied arg is the (escaped) commit message. No `pnpm <agent-string>`, no `rm`, no `eval`.

### Which consumer files each authoring tool touches

| tool | CREATE | EDIT |
|---|---|---|
| `create_journey` | `src/journeys/{kebab-id}.ts` | `src/journeys/index.ts` (import + array + re-export); conditional `constants/{events,templates}.ts` |
| `edit_journey` | — | `src/journeys/{id}.ts` (in `meta`/`run`); conditional constants |
| `create_bucket` | `src/buckets/{kebab-id}.ts` | `src/buckets/index.ts` (import + **un-annotated** array + re-export) |
| `edit_bucket` | — | `src/buckets/{id}.ts` |
| `create_email_template` | `src/emails/{kebab-name}.tsx` | `src/emails/types.ts` + `registry.ts` + `templates.d.ts`; optional `constants/templates.ts` |
| `edit_email_template` | — | `src/emails/{name}.tsx` and/or `registry.ts` and/or `types.ts` |
| `update_constants` | — | `constants/events.ts` \| `constants/templates.ts` |

**Git-as-undo** is the rollback story everywhere: dev = branch-off-main + one-commit-per-proposal (`git revert`/`git reset`); prod = revert/close the PR. `audit_logs` is the runtime-write audit trail; git is the code audit trail; both write on every confirm. Nothing the agent does is un-auditable.

---

## 6. UX

Reuses the existing **Crimzon** dark design system verbatim — no new tokens, no CVA. The agent mounts in `AppShell` as a sibling of the global `DebugDrawer`, opened via a shared React context (mirrors `FireEventContext`).

### Both tiers, one chat surface

A turn from the agent is a stream of typed **cards** rendered off AI-SDK message parts. Each card is a focused component under `packages/studio/src/components/agent/cards/`:

- **`tool-call-card`** (operate reads) — thin `Card` row: status icon + `font-mono` one-liner (`find_contacts → 42 contacts`) + expand chevron → the exact `DebugDrawer` `<pre>` JSON treatment. No buttons (reads auto-run).
- **`write-confirm-card`** (runtime writes) — full `Card` with a **blast-radius strip** (recipient count in `font-display`, audience label, irreversibility line), a tier `Badge` (`write_safe`="Test send", `write_external`=accent+`AlertTriangle`), a test-mode redirect `Badge` ("Test mode → you@…"), a collapsible params `<pre>`, a live **10-min TTL countdown**, footer `[Reject]` + `[Approve & send]` (`destructive` variant when irreversible). On approve → POST `/confirm` with `Idempotency-Key: proposalId` (double-click safe). Resolved → one-line receipt + deep-link.
- **`diff-card`** (authoring — the centerpiece) — full `Card`: intent title + artifact `Badge` + file-count chip; per-file collapsible diff (new file expanded, `index.ts`/registry edits collapsed); **single-accent diff tinting** (added = `bg-white/[0.04]`, removed = `bg-accent/5 text-accent/80`, context muted — honors "red = negative only"); a validation strip (typecheck + biome rows, failing expands the compiler error inline and **disables the apply CTA**); footer decided by mode — dev `[Approve & apply]`, prod `[Open PR]` (`GitPullRequest`); an `enablement` warning strip when the new id isn't in `ENABLED_*`. Email-template diffs **embed the rendered preview inline** so code + render are one decision.
- **`email-preview-card`** — the `template-detail.tsx` idiom verbatim: `<iframe srcDoc={html} sandbox="" className="h-[480px] w-full">` inside `rounded-lg border bg-white`, fed by props-aware `getTemplatePreview(key, props)`; a `[Send test to me]` button. Standalone or embedded in a diff card.
- **`audience-preview-card`** — `description` + a **big live count** with an honest `~ estimate` badge when iterated (no `POST /contacts/query` exists); criteria summary via the `PropertyTable` idiom + a `[View as code]` toggle showing the `ConditionEval`/builder form; 3-5 sample contacts in a compact `Table`; footer three actions — `[Use for campaign]` (enabled **only** when `source==="bucket"`; disabled for ad-hoc with a tooltip steering to the next button), `[Make a persistent bucket]` (the author handoff → streams a `diff-card`), `[Refine]` (seeds the composer).

### Diff viewer · email preview · audience preview cards (called out)

These three are the heaviest components and the visual proof of the two tiers: the **diff viewer** is the Author tier's whole surface (multi-file, typecheck-gated, dev/prod CTA); the **email preview** turns "approve blind" into "approve what you see"; the **audience preview** is the literal embodiment of "people based on XYZ" → criteria + count + samples + the one-shot-campaign vs persistent-bucket fork the architecture actually supports.

### Wireframe (open panel, prod mode, email-template authoring, typecheck passing)

```
┌──────────────────── Agent ──── [Win-back ▾] [+] [🔒 Prod · PR-only] [✕] ────────┐
│ you:  Edit the welcome email CTA to say "Start free"                            │
│ agent: Found `activation-welcome`. Here's the preview + the 1-line diff.        │
│  ┌─ Edit welcome email CTA ──────────── [✓ Typecheck] [✓ Lint] [1 file] ──────┐ │
│  │ ┌────────────────────── white iframe (rendered email) ──────────────────┐  │ │
│  │ │  Welcome to Hogsend          [  Start free  ]  ← live render          │  │ │
│  │ └────────────────────────────────────────────────────────────────────────┘ │
│  │  ▾ 📝 apps/api/src/emails/activation-welcome.tsx        +1 −1   tsx         │ │
│  │      22   <Button href={ctaUrl}>                                            │ │
│  │    − 23     {ctaText ?? "Get started"}                                      │ │
│  │    + 23     {ctaText ?? "Start free"}                                       │ │
│  │      24   </Button>                                                         │ │
│  │  ✓ check-types passing     ✓ biome passing                                  │ │
│  │                                          [ Reject ]   [ Open PR ⤴ ]         │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────┤
│ > Message the agent…                                                      [Send] │
└────────────────────────────────────────────────────────────────────────────────┘
```

Empty state: a `Sparkles` `EmptyState` + two chip groups — **Operate** ("Who clicked the pricing email last week?", "Send the launch to power users") and **Author** ("Write a win-back journey for dormant trials", "Edit the welcome CTA to 'Start free'") — each chip `openWith(prompt)`. Footer microcopy: *"Reads run automatically. Sends and code changes always ask first. History is local to this browser."*

---

## 7. Safety model

One unified, **server-enforced** risk model. The agent reads freely; **every effect on the world — a real send, a fired event, a campaign, a written file, a PR — is a server-minted proposal that a human approves by clicking, re-validated at click time, executed idempotently on the proposalId, and recorded in `audit_logs` (+ git for code).**

### Risk tiers (the server re-derives the tier; never trusted from the model or client)

| Tier | Examples | Behaviour |
|---|---|---|
| `read` | all `GET /v1/admin/*`, `preview_email`, `build_audience` (preview/count), `read_repo_file`, `typecheck`, `biome` | Auto-run, no proposal, bounded + paginated |
| `write_safe` | `send_test_email`; **any send / `fire_event` while test-mode ON** (redirected to operator inbox) | Confirm once (it's still a real send), labeled low-risk |
| `write_external` | real send / campaign / `fire_event` with test-mode OFF, enroll | Confirm + audience size + resolved from/redirect |
| `destructive` | `delete_contact`, `send_campaign` over the cap | Confirm + **type-to-confirm** (type the recipient count or "SEND") |
| `authoring_apply` | write authored files (dev) / open a PR (prod) | Confirm + **diff-approve** + the typecheck gate below |

The killer detail: `fire_event` and sends are **dynamically reclassified** `write_safe → write_external` from **live `domainStatus`** via `domainStatus.testModeCached()` / `resolveTestMode()`. The effective tier is computed at proposal-mint **and recomputed at confirm** — a test-mode flip between mint and confirm is caught (the operator is re-prompted with the new tier, not silently sent live). The model cannot talk its way around a stale classification.

### Runtime-write proposal-token HITL (server-enforced)

- Two physically separate routes: chat **mints**, `/confirm` **executes**. The LLM has no execute tool.
- Proposal token = HMAC over `BETTER_AUTH_SECRET` (reuse the `lib/user-token.ts` `sign`/`timingSafeEqual` pattern) over `{ proposalId, sessionId, adminUserId, tool, argsHash, effectiveTier, recipientCount, exp }`. Args stored server-side in Redis (10-min TTL; the client never mutates them).
- `/confirm`: verify HMAC + TTL constant-time → burn via Redis `SET NX EX` (replay → 409) → re-check `argsHash` unchanged → re-resolve test-mode + re-derive tier → execute via the same internal handler the public endpoint uses, **Idempotency-Key = proposalId** (double-click deduped by the engine's existing two-layer dedup: Hatchet memoize + `(endpointId, idempotencyKey)` unique index).

### Authoring diff-approve + typecheck-gate + src-sandbox

- **Sandbox:** drafts never touch disk; typecheck/biome run over an overlay; writes allowlisted to `apps/api/src/**` with realpath traversal guard (§5).
- **Typecheck-gate:** `apply_changes` refuses unless the draft set has a passing typecheck **and** biome whose `draftHash` matches — and `/confirm` re-checks the gate state. Apply is structurally impossible on a red diff.
- **Diff-approve:** `apply_changes` mints a proposal carrying the diff; only `/confirm` writes files (dev) or opens a PR (prod), after the operator approves the specific diff.

### Caps, audit, test-mode (cross-cutting)

- **Caps** (enforced at `/confirm`, the only place writes happen): `AGENT_CAMPAIGN_MAX_RECIPIENTS` (above → type-to-confirm the exact count), per-call enroll cap, a Redis token bucket (`agent:<sessionId>`/`agent:<adminUserId>`): N write executions / 5 min, M campaigns / hour, a daily live-send budget circuit breaker. **No raw SQL, no shell, no eval** — a fixed allowlist of existing endpoints + fixed gate commands is the single biggest blast-radius control, free.
- **Audit:** every agent write flows through the same internal handlers, so `auditMiddleware` already fires; enrich `actor = "studio-agent:<adminEmail>"`, `detail = { proposalId, tool, model, dryRun }` → queryable in `GET /v1/admin/audit-logs`. Agent-fired events stamp `source: "studio-agent"`. No new audit table. Code changes are additionally git-auditable.
- **Test-mode:** sends inherit `createTrackedMailer`'s test-mode redirect; the system prompt bakes live test-mode into its text and the confirm card surfaces it directly, so a mid-session domain verification can't mislead the operator.
- **Multi-tenancy reality:** Studio is single-tenant; `requireAdmin` treats any authenticated session as admin. There is no lower-privilege role to drop to — the agent acts as the admin. Do not build fake RBAC; the real controls are allowlist + mandatory confirm + caps + audit + (recommended) re-auth on destructive. `risk.ts` is shaped so a future per-role check can slot into `/confirm`.

---

## 8. Dependencies

Use `pnpm add <pkg>@latest` (don't hardcode versions). `ai@6.x` already resolves in-workspace (`apps/api` ships `ai@^6.0.208` + `@ai-sdk/anthropic`), so the engine add dedupes to the same line.

```bash
# Engine — route + tools + OpenRouter provider (built-in admin route)
pnpm --filter @hogsend/engine add ai@latest @openrouter/ai-sdk-provider@latest

# Studio client — useChat + HITL helpers + the stream client
pnpm --filter @hogsend/studio add @ai-sdk/react@latest ai@latest

# Diff lib — render unified diffs in the diff-card (lightweight, no syntax highlighter)
pnpm --filter @hogsend/studio add diff@latest
```

Notes: the route lazy-imports the SDK inside the handler so a disabled-agent consumer never pays the load cost. Adding `ai` to `@hogsend/engine` widens the published surface → rides a normal changeset on the 0.34.0 line. The `diff` package (jsdiff) computes hunks client-side from `oldContent`/`newContent`; tinting is `cn()` + existing tokens (no rainbow highlighter, no new dep beyond `diff`).

---

## 9. Implementation spec — FOUNDATION (Phase 0+1)

The part to build NOW, file by file. Goal: prove **both loops** end-to-end — the streaming chat over GLM-5.2, 2-3 read tools, one runtime write with full HITL, and the draft→typecheck→apply core (even if the named author tools land later). Precise enough to implement directly.

### 9.1 Engine — `packages/engine/src/env.ts` (TOUCH)

Add to the `server:` block (next to `RESEND_API_KEY`, ~line 62), validated by `@t3-oss/env-core` — never read `process.env` raw:

```ts
// --- Studio co-working agent (GLM-5.2 via OpenRouter) ---
// Optional: when unset, the agent route fail-closes (503 agent_unconfigured).
OPENROUTER_API_KEY: z.string().min(1).optional(),
// The OpenRouter model id. Default GLM-5.2; swappable per-deploy.
AGENT_MODEL: z.string().default("z-ai/glm-5.2"),
// Hard ceiling on tool-loop steps per turn (authoring runs many).
AGENT_MAX_STEPS: z.coerce.number().default(64),
// Per-conversation token budget (abort the stream above it).
AGENT_TOKEN_BUDGET: z.coerce.number().default(1_200_000),
// Max consecutive typecheck self-repair passes on one draft set.
AGENT_TYPECHECK_REPAIR_BUDGET: z.coerce.number().default(4),
// Authoring posture: off | dev (disk write+reload) | pr (prod GitHub PR).
HOGSEND_AGENT_AUTHORING: z.enum(["off", "dev", "pr"]).default("off"),
// Runtime-write caps (enforced at /confirm).
AGENT_CAMPAIGN_MAX_RECIPIENTS: z.coerce.number().default(1000),
AGENT_LIVE_SEND_BUDGET_PER_DAY: z.coerce.number().default(5000),
```

Wire into `runtimeEnv` at the bottom of `createEnv` (the same `process.env.X` mapping the file already uses for every key). No other change.

### 9.2 Engine — `packages/engine/src/routes/admin/agent.ts` (ADD)

The new sub-router: `POST /chat` (streaming, not OpenAPI-doc'd), `POST /confirm` (`createRoute`-documented, the execute chokepoint), `GET /config` (`.openapi()` probe Studio calls on mount).

```ts
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  convertToModelMessages,
  hasToolCall,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import type { AppEnv } from "../../app.js";
import { assembleContext } from "../../lib/agent/context.js";
import { buildSystemPrompt } from "../../lib/agent/prompt.js";
import { TokenBudget } from "../../lib/agent/budget.js";
import { coreTools } from "../../lib/agent/tools-core.js";
import { runtimeOperateTools } from "../../lib/agent/tools-operate.js";
import { confirmProposal } from "../../lib/agent/proposals.js";
import { errorSchema } from "../../lib/schemas.js";

export const agentRouter = new OpenAPIHono<AppEnv>();

// ---- GET /config (probe; Studio renders not-configured state off this) ----
const configRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Admin — Agent"],
  summary: "Agent availability + active model",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            enabled: z.boolean(),
            model: z.string(),
            mode: z.enum(["off", "dev", "pr"]),
            testMode: z.boolean(),
          }),
        },
      },
      description: "Agent config",
    },
  },
});
agentRouter.openapi(configRoute, (c) => {
  const { env, domainStatus } = c.get("container");
  return c.json({
    enabled: Boolean(env.OPENROUTER_API_KEY),
    model: env.AGENT_MODEL,
    mode: env.HOGSEND_AGENT_AUTHORING,
    testMode: domainStatus.testModeCached().active,
  });
});

// ---- POST /chat (streaming; opts out of OpenAPI by design) ----
agentRouter.post("/chat", async (c) => {
  const client = c.get("container");
  const { env, logger } = client;
  if (!env.OPENROUTER_API_KEY) {
    return c.json({ error: "agent_unconfigured" }, 503);
  }
  const body = await c.req.json<{ messages: UIMessage[] }>();
  const openrouter = createOpenRouter({
    apiKey: env.OPENROUTER_API_KEY,
    headers: { "HTTP-Referer": env.BETTER_AUTH_URL, "X-Title": "Hogsend Studio" },
  });
  const manifest = await assembleContext(client);
  const budget = new TokenBudget(env.AGENT_TOKEN_BUDGET);

  const result = streamText({
    model: openrouter(env.AGENT_MODEL), // z-ai/glm-5.2
    system: buildSystemPrompt(manifest),
    messages: convertToModelMessages(body.messages),
    stopWhen: [
      stepCountIs(env.AGENT_MAX_STEPS),
      hasToolCall("apply_changes"),
      hasToolCall("propose_runtime_write"),
    ],
    abortSignal: budget.signal,
    tools: {
      ...runtimeOperateTools(c),
      ...coreTools(c, { manifest, budget }),
    },
    prepareStep: async ({ steps }) => budget.injectRepairContext(steps),
    onStepFinish: async (step) => {
      budget.add(step.usage);
      if (budget.exceeded()) budget.abort();
    },
    onError: (e) => logger.warn("agent stream error", { error: String(e) }),
    experimental_telemetry: { isEnabled: true, functionId: "studio-agent" },
  });
  return result.toUIMessageStreamResponse({ originalMessages: body.messages });
});

// ---- POST /confirm (the ONLY place effects execute; idempotent) ----
const confirmRoute = createRoute({
  method: "post",
  path: "/confirm",
  tags: ["Admin — Agent"],
  summary: "Approve and execute a pending agent proposal",
  request: {
    body: { content: { "application/json": { schema: z.object({ proposalId: z.string() }) } } },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            proposalId: z.string(),
            tier: z.string(),
            status: z.enum(["executed", "files_written", "pr_opened"]),
            detail: z.record(z.string(), z.unknown()),
          }),
        },
      },
      description: "Confirmed and executed",
    },
    409: { content: { "application/json": { schema: errorSchema } }, description: "Expired / tier changed / gate failed" },
  },
});
agentRouter.openapi(confirmRoute, async (c) => {
  const { proposalId } = c.req.valid("json");
  const res = await confirmProposal(c, proposalId); // re-resolves testMode, re-derives tier, idempotent
  if (!res.ok) return c.json({ error: res.error }, 409);
  return c.json(res.value, 200);
});
```

Key signatures/exports: `export const agentRouter`. Reuses `c.get("container")` for `{ env, logger, domainStatus, db, registry, bucketRegistry, listRegistry, emailService }`.

### 9.3 Engine — `packages/engine/src/routes/admin/index.ts` (TOUCH)

```ts
import { agentRouter } from "./agent.js";          // add to the import block
// ...after the existing .route() registrations:
adminRouter.route("/agent", agentRouter);          // inherits requireAdmin + rateLimit + auditMiddleware
```

### 9.4 Engine — `packages/engine/src/lib/agent/provider.ts` (ADD)

Thin provider factory so the route + tests share one wiring point (per-request, never module-level, so each self-host's key comes from env):

```ts
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { HogsendClient } from "../../container.js";

export function agentModel(client: HogsendClient) {
  const { env } = client;
  if (!env.OPENROUTER_API_KEY) return null;
  const openrouter = createOpenRouter({
    apiKey: env.OPENROUTER_API_KEY,
    headers: { "HTTP-Referer": env.BETTER_AUTH_URL, "X-Title": "Hogsend Studio" },
  });
  return openrouter(env.AGENT_MODEL); // z-ai/glm-5.2
}
```

(The route may inline this; the module exists so Phase-2 tools and tests import one factory.)

### 9.5 Engine — `packages/engine/src/lib/agent/tools.ts` (ADD — re-export barrel) + `tools-core.ts` + `tools-operate.ts` (ADD)

`tools.ts` is a barrel: `export { coreTools } from "./tools-core.js"; export { runtimeOperateTools } from "./tools-operate.js";`.

**`tools-core.ts`** — the cross-cutting chokepoints. Foundation ships `read_repo_file`, `typecheck`, `biome`, `write_draft`, `edit_draft`, `apply_changes`, `propose_runtime_write`:

```ts
import { tool } from "ai";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../../app.js";
import { mintProposal } from "./proposals.js";
import { getAgentSandbox } from "./sandbox.js";

export function coreTools(c: Context<AppEnv>, deps: { manifest: ContextManifest; budget: TokenBudget }) {
  const sandbox = getAgentSandbox(c.get("container")); // draft overlay, allowlisted to apps/api/src/**
  return {
    read_repo_file: tool({
      description: "Read a consumer src/** file or engine .d.ts to inspect an exemplar or confirm an export exists.",
      inputSchema: z.object({ path: z.string(), maxLines: z.number().max(800).default(400) }),
      execute: ({ path, maxLines }) => sandbox.read(path, maxLines),
    }),
    write_draft: tool({
      description: "Create/overwrite a DRAFT file (not disk). Path under apps/api/src/**. TypeScript, .js import extensions.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: ({ path, content }) => sandbox.writeDraft(path, content),
    }),
    edit_draft: tool({
      description: "Exact-string replacement on a draft (or an src file pulled into drafts).",
      inputSchema: z.object({ path: z.string(), find: z.string(), replace: z.string() }),
      execute: ({ path, find, replace }) => sandbox.editDraft(path, find, replace),
    }),
    typecheck: tool({
      description: "Run check-types over the draft overlay. MUST pass before apply_changes. Returns diagnostics + draftHash + repair budget.",
      inputSchema: z.object({}),
      execute: () => sandbox.typecheck(),
    }),
    biome: tool({
      description: "Run biome check over the changed draft files. MUST pass before apply_changes.",
      inputSchema: z.object({}),
      execute: () => sandbox.biome(),
    }),
    apply_changes: tool({
      description: "Propose applying the draft set. Refuses unless typecheck+biome passed for the current draftHash. Mints a diff-approve proposal (dev: disk on confirm; prod: PR on confirm).",
      inputSchema: z.object({ summary: z.string() }),
      execute: ({ summary }) => sandbox.proposeApply(c, summary),
    }),
    propose_runtime_write: tool({
      description: "Mint an operator-approval proposal for a RUNTIME write. Server derives the tier + snapshots test-mode. Returns a proposalId. You never execute it yourself.",
      inputSchema: z.object({
        action: z.enum(["fire_event", "send_test_email", "send_transactional_email", "create_campaign"]),
        params: z.record(z.string(), z.unknown()),
      }),
      execute: ({ action, params }) => mintProposal(c, { action, params }),
    }),
  };
}
```

**`tools-operate.ts`** — foundation read tools (auto-run, in-process against `container.db`, the same query the GET route runs). Ship `find_contacts`, `get_contact`, `query_events`, `list_journeys`, `preview_email`, `list_buckets`:

```ts
import { tool } from "ai";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv } from "../../app.js";
// each execute reuses the existing route's underlying service/query helper —
// NOT a literal fetch. e.g. find_contacts → contactSearchFilter + paginate.

export function runtimeOperateTools(c: Context<AppEnv>) {
  const client = c.get("container");
  return {
    query_events: tool({
      description: "Filter the events feed by name/userId/source/time. The primitive find_contacts(byEvent) builds on.",
      inputSchema: z.object({
        event: z.string().optional(), userId: z.string().optional(),
        source: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
        limit: z.number().max(100).default(50), offset: z.number().default(0),
      }),
      execute: (args) => queryEventsImpl(client, args),
    }),
    find_contacts: tool({
      description: "Find/filter people by search OR by event history (did X in last Nd, optionally never Y). Returns resolved contacts + a truncated flag.",
      inputSchema: z.object({
        search: z.string().optional(),
        byEvent: z.object({ event: z.string(), within: z.object({ days: z.number() }).optional(), notEvent: z.string().optional() }).optional(),
        limit: z.number().max(200).default(100),
      }),
      execute: (args) => findContactsImpl(client, args),
    }),
    get_contact: tool({ description: "One contact + email preferences.", inputSchema: z.object({ id: z.string() }), execute: ({ id }) => getContactImpl(client, id) }),
    list_journeys: tool({ description: "All journeys with trigger + enabled + state counts.", inputSchema: z.object({}), execute: () => listJourneysImpl(client) }),
    list_buckets: tool({ description: "All buckets with criteria + member counts.", inputSchema: z.object({}), execute: () => listBucketsImpl(client) }),
    preview_email: tool({
      description: "Render real template HTML with props (or staged pending template).",
      inputSchema: z.object({ key: z.string(), props: z.record(z.string(), z.unknown()).optional() }),
      execute: ({ key, props }) => previewEmailImpl(client, key, props),
    }),
  };
}
```

### 9.6 Engine — `packages/engine/src/lib/agent/system-prompt.ts` (ADD)

`export function buildSystemPrompt(manifest: ContextManifest): string`. The static spine (code-first, two-tier, author-vs-operate decision rules, the file-layout block, the HARD RULES — typecheck-before-apply, propose→confirm, test-mode, dev-vs-prod, ESM `.js`, ids unique, un-annotated buckets array, generate TypeScript) + the dynamic tail appending the manifest (registries, exemplars, live snapshot, resolved `mode` + `testMode`). The full spine text is in §6 of the Agent-Core design proposal — port it verbatim.

### 9.7 Engine — `packages/engine/src/lib/agent/context.ts` (ADD)

`export async function assembleContext(client: HogsendClient): Promise<ContextManifest>` and `export type ContextManifest`. Three layers ordered stable→volatile (so the static A+B prefix hits provider prompt-caching every turn):
- **A (memoized per engine version):** exemplar files verbatim (`activation-welcome.ts`, `ai-onboarding.ts`, `power-users.ts`, `trial-expiring-soon.ts`, `activation-community.tsx` + its props, the three `index.ts` shapes) + the `CriteriaBuilder`/`defineJourney`/`defineBucket` `.d.ts` excerpts + the authoring-recipe rules block.
- **B (memoized per registry hash):** journey/bucket/list/template registries from `client.registry` / `bucketRegistry` / `listRegistry` / `templates`; resolved `mode` (dev/prod) + `testMode`.
- **C (always fresh, last):** a small dashboard slice — counts (contacts, journey states by status, top-N bucket sizes, recent send volume, suppression count) + the last ~20 events with `source`.

Foundation can ship A+B+C minimal (registries + small snapshot + a couple of exemplars); the full exemplar set fills in with the author tools in Phase 3.

### 9.8 Engine — `packages/engine/src/lib/agent/proposals.ts` (ADD)

Mint/verify/burn proposal tokens. Copy the HMAC pattern from `lib/user-token.ts` (`createHmac("sha256", BETTER_AUTH_SECRET)` + `timingSafeEqual`). Exports:
- `export async function mintProposal(c, { action, params }): Promise<{ proposalId, tier, summary, blastRadius, testModeSnapshot, expiresAt }>` — derive tier from `domainStatus.testModeCached()`, compute blast radius, store args in Redis `agent:proposal:<id>` (10-min TTL), return the proposalId + summary as a tool-result part.
- `export async function confirmProposal(c, proposalId): Promise<Result>` — verify + burn (Redis `SET NX EX`) → re-resolve test-mode + re-derive tier (409 on change) → re-check `argsHash` → for runtime: execute via the existing internal handler (`Idempotency-Key = proposalId`); for authoring: re-gate typecheck/biome by `draftHash` → dev write+commit / prod `open_pr` → write `audit_logs`.
- `export function effectiveTier(action, params, testMode): Tier`.

### 9.9 Engine — `packages/engine/src/lib/agent/sandbox.ts` (ADD)

`export function getAgentSandbox(client): AgentSandbox`. The draft overlay + allowlist + gate runner + apply. Methods: `read`, `writeDraft`, `editDraft`, `typecheck` (spawn `pnpm --filter @hogsend/api check-types` over an overlay, parse tsc, return `{ ok, diagnostics[], draftHash, repairBudgetRemaining, exhausted? }`), `biome`, `proposeApply` (refuse unless gate passed for draftHash → mint authoring_apply proposal), `applyDev` (allowlisted write + git commit), `openPr` (branch/commit/push/`gh pr create`). Resolve consumer root via the `eject.ts` precedent (probe `node_modules/@hogsend/engine`, walk up to the dep'd `package.json`); realpath-validate every path against the src root. Foundation ships `read`/`writeDraft`/`editDraft`/`typecheck`/`biome`/`proposeApply`/`applyDev`; `openPr` lands Phase 4.

### 9.10 Engine — `packages/engine/src/lib/agent/budget.ts` (ADD)

`export class TokenBudget` — `{ signal: AbortSignal }`, `add(usage)`, `exceeded()`, `abort()`, `injectRepairContext(steps)` (re-surface the last typecheck failure compactly for the next step). Constructed from `AGENT_TOKEN_BUDGET`.

### 9.11 Studio — `packages/studio/src/components/agent/` (ADD) + app-shell wiring (TOUCH)

Foundation scaffold (mirrors `DebugDrawer`):
- **`agent-context.tsx`** — `AgentContext` + `useAgent()` (mirrors `FireEventContext`): `{ open(), openWith(prompt), isOpen }`.
- **`agent-launcher.tsx`** — bottom-right floating `Sparkles` `Button` (`fixed bottom-6 right-6 z-40`), `unread` accent dot.
- **`agent-panel.tsx`** — right slide-over borrowing `drawer.tsx` container classes (`fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-white/10 bg-raised`) + backdrop + Escape; three regions: header (`font-display "Agent"`, `[+]` new chat, mode badge, `✕`), transcript (`flex-1 overflow-y-auto`), composer (`border-t`, pending-gated).
- **`use-agent-chats.ts`** — `useSyncExternalStore` + localStorage multi-chat store (`hogsend.studio.agent.chats`): `{ chats, activeId, create, switchTo, rename, remove, appendMessage }`.
- **`agent-store.ts`** (in `src/lib/`) — the `useSyncExternalStore` subscribe/getSnapshot wiring backing the hook.
- **`agent-stream.ts`** (in `src/lib/`) — raw `fetch` reader with `credentials:"include"` (NOT `api.request`, which buffers and can't stream) feeding `useChat`'s transport; 401 → reuse the app auth-gate redirect.
- **`message-list.tsx`** + **`message-bubble.tsx`** — map `UIMessage` parts → cards.
- **`cards/tool-call-card.tsx`** — collapsed one-liner → `<pre>` JSON (foundation card, reads).
- **`cards/write-confirm-card.tsx`** — blast-radius + tier badge + TTL countdown + `[Approve & send]` (proves the HITL loop with `fire_event`).
- **`use-agent-mode.ts`** + **`agent-mode-badge.tsx`** — `GET /v1/admin/agent/config` → dev/prod + testMode badge.
- **`agent-api.ts`** (in `src/lib/`) — typed `confirmProposal(proposalId)` mutation (POST `/confirm`, `Idempotency-Key: proposalId`) + the `WriteProposal` type.

**`app-shell.tsx` (TOUCH):** add `const [agentOpen, setAgentOpen] = useState(false)`, wrap the provider stack with `<AgentContext.Provider value={{ open: () => setAgentOpen(true), ... }}>`, mount `<AgentLauncher onClick={() => setAgentOpen(true)} />` + `<AgentPanel open={agentOpen} onClose={() => setAgentOpen(false)} />` next to `<DebugDrawer />`. Header: an outline "Agent" (`Sparkles`) `Button` next to "Fire event". `package.json` (TOUCH): add `@ai-sdk/react`, `ai`, `diff`.

The diff-card and audience/email-preview cards are scaffolded as stubs in Phase 1 and filled in Phase 2–3 (the panel can be built against mocked `agent-api` responses first, since the author/audience engine endpoints land later).

---

## 10. Phased plan

### Phase 0 — Config + stream spike (~0.5–1 day)
- **Scope:** env vars; prove the streaming round-trip end-to-end with one trivial read tool, no UI polish; confirm **GLM-5.2** tool-calling fidelity over OpenRouter; confirm the Better Auth cookie travels on the `useChat` transport (`credentials:"include"`).
- **Files:** `env.ts`, `routes/admin/agent.ts` (config + chat skeleton + `/confirm` stub), `routes/admin/index.ts`, `lib/agent/{provider,context,prompt,budget}.ts` (minimal), deps. Throwaway Studio fetch to validate the stream reader.
- **Acceptance:** `GET /v1/admin/agent/config` → `{enabled, model:"z-ai/glm-5.2", mode, testMode}`; a curl/Studio POST streams tokens; one read tool round-trips; `503` when `OPENROUTER_API_KEY` unset.
- **Effort:** 0.5–1 day.

### Phase 1 — Panel + read tools + one runtime write with HITL (~5–6 days)
- **Scope:** the full bottom-right panel (launcher, slide-over, composer, streaming, markdown, multi-chat localStorage) + the **foundation read tools** (`find_contacts`, `get_contact`, `query_events`, `list_journeys`, `list_buckets`, `preview_email`) + **one runtime write** (`fire_event`) proving the proposal-token mint/verify/burn + `/confirm` chokepoint + idempotency + audit enrichment + `source:"studio-agent"` + **test-mode reclassification**. Not-configured + error states. The draft/typecheck/apply **core tools** (`write_draft`/`edit_draft`/`typecheck`/`biome`/`apply_changes`) wired and sandbox-real (so the loop isn't stubbed), even though the named author tools are deferred.
- **Files:** all `src/components/agent/*` + `lib/{agent-store,agent-stream,agent-api}.ts`; engine `lib/agent/{tools-core,tools-operate,proposals,sandbox,risk}.ts`; `app-shell.tsx` edits.
- **Acceptance:** operator can investigate via reads that auto-run; proposing `fire_event` streams a write-confirm card; nothing fires without `/confirm`; a double-click Approve fires exactly once; the write lands in `audit_logs` as `studio-agent:<email>` and in the Events feed as `source:studio-agent`; tampering with proposal args fails; test-mode flip between mint and confirm is caught.
- **Effort:** 5–6 days.

### Phase 2 — Full runtime tier (~1.5–2 weeks)
- **Scope:** the rest of the Operate tier — `find_contacts(byEvent)` resolver + `build_audience` (event-feed pagination, dedupe, negative-filter, `criteriaBuilder` compile, blast-radius count, truncation), `send_transactional_email` (per-recipient fan-out), `send_test_email`, `send_campaign` (type-to-confirm, refuses ad-hoc audiences), `enroll_in_journey`, `subscribe/unsubscribe_list`, `upsert/update/delete_contact`; caps + agent rate limits + live-send budget at `/confirm`; the **audience-preview-card** + **email-preview-card** filled in.
- **Files:** expand `tools-operate.ts` + `risk.ts` + `proposals.ts`; new audience resolver lib; Studio `cards/{audience-preview,email-preview}-card.tsx`.
- **Acceptance:** "find everyone who hit checkout_started in 7d, never purchased, send cart-recovery" runs end-to-end as fan-out; an ad-hoc audience refuses `send_campaign` and routes to promote/fan-out; campaign over the cap is hard-rejected with the exact number; delivered count shown as "up to N".
- **Effort:** ~1.5–2 weeks.

### Phase 3 — Authoring tier (~2.5–3 weeks)
- **Scope:** the named author tools (`create_journey`/`edit_journey`, `create_bucket`/`edit_bucket`, `create_email_template`/`edit_email_template`, `update_constants`, `promote_audience_to_bucket`) as composers over `write_draft`/`edit_draft`; the full **typecheck-repair loop** (overlay + structured tsc/biome parsing + bounded self-repair + repair-budget exhaustion); **dev apply** (allowlisted write + git commit + reload verification via `GET /v1/admin/{journeys,buckets}`); the full **context manifest** (all exemplars + `.d.ts`); the Studio **diff-card** (`diff-file`, `diff-hunk`, single-accent tinting, validation strip, check-badge, enablement warning) + the audience→bucket handoff flow.
- **Files:** `tools-authoring.ts`; expand `sandbox.ts` + `context.ts`; Studio `cards/{diff-card,diff-file,diff-hunk,check-badge}.tsx`.
- **Acceptance:** "write a win-back journey for dormant trials" produces a typecheck-clean multi-file diff; approve → files written → worker reloads → the new id appears in `/v1/admin/journeys`; a deliberately-broken request self-repairs ≤4 passes then hands diagnostics to the operator; an email-template diff shows the inline render; sequence shipped smallest-blast-first (journeys/buckets, then templates 4-part, then edit_* part-edits).
- **Effort:** ~2.5–3 weeks (the sandbox overlay + typecheck loop is the highest-risk pole).

### Phase 4 — Prod PR apply + server persistence + audit + polish (~1.5 weeks)
- **Scope:** **prod PR apply** (`open_pr`: branch/commit/push/`gh pr create` + the copy-paste fallback when no remote/`gh`) + Studio prod-mode CTA ("Open PR", "Needs deploy" badge, "live after deploy" messaging); optional server-side transcript (two additive Drizzle tables `agent_chats` + `agent_messages`, engine-track migration, persisted in `onFinish`, cross-linked by `proposalId`) so threads survive a browser wipe; suggestion chips; ops reads with redaction; message-window pruning; tests for the confirm gate, replay/idempotency, cap enforcement, test-mode reclassification, the typecheck gate, the path allowlist.
- **Files:** `sandbox.ts` `open_pr`; `packages/db/src/schema/agent-chats.ts` + migration; engine `onFinish` persistence; Studio transcript view + tests.
- **Acceptance:** a prod-mode authoring request opens a real PR (never claims "live"); transcripts persist + reopen; all safety tests green; changeset cut on the engine line.
- **Effort:** ~1.5 weeks.

**Total to the full two-tier agent: ~8–10 weeks.** A trusted Operate-only agent (Phase 0–2) ships in ~3.5–4 weeks; the Author tier (Phase 3–4) is the larger, riskier half.

---

## 11. Open decisions for Doug

1. **Default model = `z-ai/glm-5.2` — confirm.** The whole plan defaults to it and `AGENT_MODEL` keeps it swappable. If `z-ai/glm-5.2` isn't yet live on OpenRouter at build time, the safe fallback is `z-ai/glm-4.6` (battle-tested tool-use) with zero code change (just the env default). **Recommendation: default `z-ai/glm-5.2`, fall back to `glm-4.6` only if the id 404s on OpenRouter.**
2. **Dev-only authoring first, or prod-PR early?** Recommendation: **dev-only authoring in Phase 3, prod-PR in Phase 4.** Dev apply (disk write + hot-reload) is the smallest blast radius and lets us harden the typecheck loop before adding the git/`gh` surface. Confirm you're OK with the dogfood instance being the authoring proving ground before prod-PR lands.
3. **How wide is the v1 (Phase 1) write set?** Recommendation: **exactly one — `fire_event`** — to prove the HITL chokepoint end-to-end at the lowest blast radius. The full operate writes (transactional, campaign, enroll, list, contact CRUD) land in Phase 2. Confirm, or do you want `send_transactional_email` in Phase 1 too?
4. **Re-auth on destructive confirms?** Recommendation: **require a password/passkey re-auth for `destructive`-tier + live-campaign confirms** (a stolen admin session is more leverageable when an LLM can NL-drive bulk actions). Worth the friction, or rely on caps + type-to-confirm alone for v1?
5. **Authoring posture default.** `HOGSEND_AGENT_AUTHORING` defaults `off`. Recommendation: ship Phase 1–2 with it `off` (operate-only), flip the dogfood to `dev` when Phase 3 lands. Confirm authoring stays opt-in (off by default) for scaffolded consumer apps.
6. **Server transcript in v1?** Recommendation: **localStorage in v1 (Phases 0–3)**, server tables deferred to Phase 4 — matches Studio's view-owned-state idiom and the no-server-transcript reground; every *committed* effect is durable anyway (`audit_logs`/`email_sends`/git). Confirm OK shipping without cross-device thread history initially.

---

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Client can't be trusted to skip confirmation** | Execution is a physically separate `/confirm` route gated by a server-minted, single-use, HMAC'd, TTL'd proposal token; the LLM has no execute tool — structural. |
| **Test-mode flips between mint and confirm** → a "redirected to my inbox" approval goes live | `/confirm` re-resolves `domainStatus.testModeCached()` + re-derives the tier; on any change it 409s and the operator is re-prompted with the new tier, never silently sent. |
| **No bulk filter / contacts-by-event JOIN endpoint** → `find_contacts(byEvent)` + `build_audience` are O(events) client-side | Cap the candidate set, return a `truncated` flag, steer large segments to `promote_audience_to_bucket` (set-based SQL backfill). |
| **Ad-hoc audience can't feed a campaign** (campaigns require a persistent list/bucket id) | `send_campaign` hard-refuses an `AudienceHandle` and routes to fan-out (one-off) or promote→author→deploy→backfill; never surfaces a raw 404. |
| **Builder-criteria one-shot + async backfill** → operator thinks a just-authored bucket is empty | The author tool + diff card always state "members materialize on next boot via backfill (async, minutes for large bases)." |
| **GLM hallucinates an engine export / a `: DefinedBucket[]` annotation / missing `.js`** | typecheck catches it; `read_repo_file` + `.d.ts` in context reduce it; the un-annotation + ESM rules are pinned hard-rules in the prompt; the repair-budget exhaustion path hands diagnostics to the operator instead of spiraling. |
| **typecheck latency** (multi-second × ≤4 repairs) over the SSE stream | Warm tsc/overlay, parallel biome, a visible "typechecking…" stream part; bounded repair budget; the connection is kept alive by the stream. |
| **Sandbox overlay vs the live tsx watcher in dev** (a real-disk write mid-overlay; apply triggers a worker restart) | typecheck/biome validate the integrated overlay without disk mutation; dev apply is per-file with a flush; the agent tells the operator "files written — worker reloading." |
| **Token cost at 1M ctx over a 64-step loop** | Lean on provider prompt-caching of the static A+B prefix (ordered first, volatile C last + small); `AGENT_TOKEN_BUDGET` hard-stop; verify cache hit-rate empirically. |
| **proposalId idempotency requires all runtime paths honor it** | `create_campaign` already supports `idempotencyKey`; confirm `fire_event`/send paths thread it before shipping each (else a double-click double-fires); `sendConnectorAction` is explicitly out of agent scope (no Layer-2 backstop). |
| **Prompt injection** via attacker-influenceable instance data read into context | At worst it produces a *proposal* the human still approves; label fetched instance data untrusted in-context; never derive write args from free-text alone without the operator restating intent. |
| **Adding `ai` to the engine bloats the surface / cold start** | Lazy-import inside the handler; gate route behavior on `OPENROUTER_API_KEY` (503 when unset); ship via a normal changeset on 0.34.0. |
| **Prod `open_pr` with no remote / `gh` auth** | Fall back to returning the diff as a copy-paste block with instructions; never report a PR that wasn't created. |
| **Studio dev serves a stale static dist (not live Vite)** | Iterating the agent UI needs `pnpm --filter @hogsend/studio build` per change; build the cards against mocked `agent-api` first; documented as a known dev-loop cost. |
| **4th global overlay (sidebar + header + DebugDrawer + AgentPanel) z-index/focus collisions** | Launcher `z-40`, panel `z-50` reconciled with `drawer.tsx`'s `z-50`, toasts above; single shared opener context prevents stack-fighting. |
