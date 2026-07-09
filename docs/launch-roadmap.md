# Hogsend — Prioritized Feature Roadmap (optimized for the OSS launch)

## Context

**Why this plan exists.** An in-depth, research-backed roadmap: what to build next, what's missing, and how to market it — with the north star being **a strong open-source / Show HN launch**.

Two findings reshape everything:

1. **The core positioning bet in `docs/product-spec.md` has broken.** The spec's differentiation #2 says *"No one else does this because PostHog workflows is supposed to do it but doesn't yet."* That is now **false**. PostHog **Workflows shipped from beta at the start of 2026** — a native no-code drip/journey builder with email/Slack/SMS/webhook dispatches, delays, audience splits, tracking-pixel triggers, and 10k free messages/mo. If launched with the stale claim, the top HN comment will be "PostHog already ships this." The positioning must be rewritten *before* launch (see §1).

2. **Hogsend is far more built-out than its own spec admits.** A full codebase inventory shows the product already has: email (Resend + Postmark, swappable via `defineEmailProvider`), a **complete in-app/inbox channel** (`sendFeedItem`/`sendBanner`/`sendSurvey` + `packages/js` client SDK + `packages/react` bell/toast/banner/preference-center), **Discord + Telegram** connectors (`sendConnectorAction`), a **Studio admin SPA** (`packages/studio` — overview, journeys+funnel, contacts, sends, events, templates, buckets, links, an in-app AI agent panel), a **Tauri desktop** monitor, **26 admin API routes**, per-journey funnel + email open/click/bounce metrics, **buckets** (segmentation/cohorts), ~100 vitest tests, and bundled Claude Code skills. So the roadmap is about **unifying, filling gaps, and demoing what's already there** — not building from scratch.

**Competitive landscape (from web research):**
- **PostHog Workflows** — live, GUI no-code, "same data" advantage. Gaps: no native push (webhook workaround), i18n is manual, GUI-only (no code authoring, no exactly-once story). *Hogsend wedge: the tool you reach for when the canvas isn't enough — typed code, replay-safe.*
- **Dittofeed** (YC S22, ex-Braze founder) — the real OSS rival. Omni-channel (email/SMS/push/WhatsApp/Slack), git-versioned templates, CI Testing SDK, headless embeddable builder. But its "code-first" is **GUI-exported JSON**, not typed control flow, and it needs a heavy **Postgres + ClickHouse + Temporal** stack (~4h setup). *Hogsend wedge: journeys are real TypeScript control flow, lighter stack (Hatchet-lite, no ClickHouse), agent-writable.*
- **OpenMail** (new) — Resend-based Customer.io alt that ships an **MCP server for AI agents**. Direct overlap with Hogsend's agentic angle → Hogsend needs an MCP server to not cede this.
- **Loops** — great indie DX, but no durable/replay guarantees, contact-based billing balloons past 5k.
- **Novu / Knock** — multi-channel *notification infra*, not lifecycle orchestration.

**What developers say they want** (validates the thesis): IaC/version-controlled email logic ✅, testable templates ✅, **idempotency/exactly-once** ✅ (Hogsend's headline; most tools lack it), event-driven ✅, unified transactional+marketing (partial), and increasingly **AI-native (MCP/CLI)** — CLI ✅, MCP ❌.

**Intended outcome:** a launch where every headline differentiator is *demonstrable in 30 seconds* (a graph you can see, an agent that writes a journey, a journey you can simulate), the positioning survives HN scrutiny post-PostHog-Workflows, and the genuinely-missing table-stakes (SMS, unified channels) have a credible path.

---

## 1. Positioning rewrite (P0 — do first, gates the launch)

Rewrite `docs/product-spec.md` §Go-to-Market + the docs landing/compare pages. New one-liner:

> **"Customer.io in TypeScript. Journeys are typed `.ts` control flow — not a GUI, not exported JSON — replay-safe by construction, and an AI agent can write them."**

Differentiation, reframed against the *current* market (not "PostHog doesn't have it yet"):
1. **Real code, not exported JSON.** Dittofeed/PostHog give you a canvas that emits JSON. Hogsend journeys are TypeScript `run(user, ctx)` with real `if`/loops/awaits — diffable, testable, refactorable.
2. **Exactly-once by construction.** Hatchet durable replay + auto-keyed `sendEmail`/`ctx.trigger`. Most lifecycle tools double-send on retry; this is a hard problem Hogsend already solved.
3. **Agent-native, provably.** Ships Claude Code skills + (new) an MCP server. An agent reads your funnel, writes a journey, simulates it — live.
4. **Already multi-channel.** Email + in-app inbox (with React components) + Discord/Telegram, one engine, first-party tracking.
5. **Light to self-host.** Postgres + Redis + Hatchet-lite. No ClickHouse, no Temporal cluster. Railway in minutes.

Launch channels (validated): Show HN ("open-source, code-first lifecycle engine — journeys are TypeScript, not a canvas"), r/selfhosted + r/SaaS, **PostHog community + GitHub issue #39519** (active "Resend as a provider" ask — warm audience), YouTube build walkthrough, build-in-public X thread. Add a **feature-matrix page vs PostHog Workflows / Dittofeed / Loops** (the compare docs already exist at `apps/docs/content/docs/compare/`).

---

## 2. Prioritized feature roadmap

Ranked by **launch impact** (demo-ability + surviving scrutiny + closing a dismissible gap). Effort: S ≈ 1-2d, M ≈ 3-5d, L ≈ 1-2wk.

### P0 — Launch-critical (the demo + credibility core)

| # | Feature | Why it matters for launch | Effort |
|---|---------|---------------------------|--------|
| 1 | **Positioning/spec rewrite** (§1) | PostHog Workflows shipped; stale claim = instant HN dismissal | S |
| 2 | **Visual journey graph (read-only)** | Kills the #1 objection ("code-first = I can't see my funnel"); best screenshot; renders in Studio + CLI + docs | M |
| 3 | **MCP server** (`@hogsend/mcp`) | *Proves* the agentic claim; OpenMail already ships one; "AI reads your funnel + writes a journey" is the launch wow | M |
| 4 | **Journey simulator / dry-run** | The "testable in code" proof; one-ups Dittofeed's CI Testing SDK; pairs with the graph (show the path taken) | M |

### P1 — Close the dismissible gaps (table-stakes vs Dittofeed/PostHog)

| # | Feature | Why | Effort |
|---|---------|-----|--------|
| 5 | **Unified channel contract** (`defineChannel`) + **SMS** (`plugin-twilio`) | "Multi-channel" is table-stakes; today email/connectors/in-app are three bespoke seams. One contract makes SMS/push/WhatsApp/Slack-messaging pluggable | L |
| 6 | **A/B testing** — `ctx.variant(key, variants)` | Everyone is weak here (even Dittofeed is manual); Hogsend can win cleanly because `ctx.once()` already gives replay-stable assignment | S |
| 7 | **Slack as a messaging connector** | Slack exists only as event fan-out today; add `plugin-slack` outbound actions via the connector-action pattern | S |

### P2 — Depth & polish (post-launch, still on the near roadmap)

| # | Feature | Why | Effort |
|---|---------|-----|--------|
| 8 | **Per-node drop-off funnel** | Overlay live counts on the graph nodes (§P0-2); today the funnel is a fixed 5-step, not derived from actual journey nodes | M |
| 9 | **First-class i18n** for templates | PostHog's is manual; a `t()`/locale-resolution helper is a concrete "we beat Workflows on X" | M |
| 10 | **Push notifications** (`plugin-webpush` / FCM/APNS) | Genuinely missing; rides on the P1 unified channel contract | L |
| 11 | **Prometheus `/metrics` + OTel spans** | Self-hosted crowd expects a scrape endpoint; none today | M |
| 12 | **SES email provider** | Third `defineEmailProvider` for AWS-native shops | S |

### Deferred (monetization, not launch)
- **Managed hosting / multi-tenant isolation + billing** — the revenue unlock. Correctly deferred by the spec; gate on 500+ GitHub stars + inbound demand. Note Novu's OSS→hosted playbook as the model.

---

## 3. Deep dives (the P0 four)

### 3.1 Visual journey graph (read-only) — feature #2

**Goal.** Render any journey as a Mermaid flowchart from the typed source — no execution — surfaced in three places (CLI + admin route + docs). Renders the *inside* of `run()` (sends, sleeps, waits, branches), not just trigger/exit metadata, because that inside is what answers "show me my funnel."

**Architecture split (important — matches runtime reality):**
- **CLI + docs get the RICH graph** — they read source `.ts` at dev time and parse the `run()` body via the TypeScript compiler API. Full fidelity (branches, waits, sends).
- **Admin route + Studio get the METADATA graph** — at runtime the source is bundled/transpiled away; the engine only has `JourneyMeta` (trigger, exitOn, entryLimit, suppress) via the registry. It renders that skeleton and **overlays live counts** from the existing `/metrics/journeys/{id}` funnel. (A future build step could emit `journeys.graph.json` to give the route the rich graph too — noted, not in scope.)

**Components to build:**
- `packages/core/src/graph/` (pure, no deps — reusable everywhere):
  - `JourneyGraph` type: `{ nodes: GraphNode[], edges: GraphEdge[] }` where node kinds = `trigger | email | inapp | connector | sleep | schedule | wait | branch | trigger-event | checkpoint | exit | end`.
  - `renderMermaid(graph): string` — emit `flowchart TD`.
  - `metaToGraph(meta: JourneyMeta): JourneyGraph` — the metadata-level skeleton (trigger → body-placeholder → exitOn).
- `packages/cli/src/lib/journey-graph.ts` — `extractJourneyGraph(filePath): JourneyGraph` using `typescript` (already a root dep, `5.9.2`). Walk the `defineJourney({ run })` arrow body statement-by-statement:
  - `await ctx.sleep({label})` / `sleepUntil` / `ctx.when…` → sleep/schedule node
  - `await ctx.waitForEvent({event,timeout})` → wait node with two out-edges (fired / `timedOut`)
  - `await sendEmail({template})` / `sendFeedItem` / `sendBanner` / `sendSurvey` / `sendConnectorAction` → channel node (labelled by template/action)
  - `await ctx.trigger({event})` → trigger-event node
  - `if (…) { }` → branch diamond (label from the condition text, e.g. `hasEvent` / `score <= 6`)
  - `return` → early-end node; `ctx.checkpoint(label)` → checkpoint marker
  - Best-effort: unknown statements are skipped with a `%% note`. The observed journeys (`churn-prevention`, `activation-nudge-series`, `feedback-nps`) are sequential with shallow `if` — well within scope. Emit a disclaimer for dynamic control flow.
- **CLI subcommand** in `packages/cli/src/commands/journeys.ts` (extend the existing `list|get|enable|disable` switch): `journeys graph <id>` (stdout mermaid or `--out file.md`), `journeys graph --all --out docs/journeys.md` (docs generator). Resolve journey files from the consumer's `src/journeys/`.
- **Admin route** in `packages/engine/src/routes/admin/journeys.ts`: `GET /journeys/{id}/graph` → `{ mermaid, level: "metadata", counts }` (uses `core.metaToGraph` + `renderMermaid` + the existing metrics query).
- **Studio** `packages/studio/src/views/journey-detail-view.tsx`: add a "Flow" tab beside the existing `journey-funnel.tsx`; add `mermaid` npm dep, render the route's mermaid client-side, overlay funnel counts.

**Reuse:** `JourneyRegistry.get(id)` (`packages/core/src/registry/index.ts:26`), `JourneyMeta` (`packages/core/src/types/journey.ts`), the `/metrics/journeys/{id}` funnel (`packages/engine/src/routes/admin/metrics.ts`).

### 3.2 MCP server (`@hogsend/mcp`) — feature #3

**Goal.** An MCP server that lets Claude/Cursor *operate* Hogsend: read journeys + funnels, simulate a journey, enroll a test user, send a test event, and scaffold a new journey `.ts`. This is the concrete proof of "agent-native" — and answers OpenMail directly.

**Approach.** New `packages/mcp` using `@modelcontextprotocol/sdk`. Tools wrap the **already-existing admin API** via the CLI's HTTP clients (`packages/cli/src/lib/http.ts` — `createAdminClient`), so it's a thin, well-tested layer:
- `list_journeys`, `get_journey` (+ `graph`), `journey_funnel` → wrap `/v1/admin/journeys*` + `/metrics/journeys/{id}`
- `simulate_journey` (→ §3.3), `enroll_test_user` → `/journeys/{id}/enroll`, `send_test_event` → `/admin/events`
- `list_contacts` / `contact_timeline`, `email_metrics`
- `scaffold_journey` — generate a `defineJourney` `.ts` from a spec (mirrors the bundled skills)

Ship as `hogsend mcp` (add to the CLI command registry) and a standalone bin so it drops into `claude_desktop_config.json` / `.mcp.json`. Auth reuses `HOGSEND_ADMIN_KEY` resolution the CLI already does.

**Reuse:** every admin route the inventory found; `packages/cli/src/lib/http.ts`, `lib/config.ts` (key resolution). No new engine surface needed for v1.

### 3.3 Journey simulator / dry-run — feature #4

**Goal.** `hogsend journeys simulate <id>` runs a journey against a fake user with scripted event answers and prints the path taken — **no sends, no sleeps** — and (bonus) highlights that path on the §3.1 graph. This is the "test your lifecycle logic in CI" story, one-upping Dittofeed's Testing SDK with a *local, interactive* runner.

**Approach.** `packages/engine/src/journeys/simulate.ts`:
- Build a **mock `JourneyContext`** implementing the full interface (`packages/core/src/types/journey-context.ts`): `sleep`/`sleepUntil` resolve instantly and record a step; `waitForEvent` returns scripted answers (or `timedOut`); `history.*` returns scripted state; `guard.isSubscribed()` → true; `trigger`/`checkpoint`/`once`/`when` record without side effects.
- Stub the send functions (`sendEmail`, `sendFeedItem`, `sendConnectorAction`) to **record** instead of send (inject via the existing `overrides.mailer` test hatch pattern, or a module-level sim flag).
- Run `options.run(user, ctx)` and collect an ordered **trace** of steps → render as a table and as a highlighted path over the Mermaid graph.
- CLI: `journeys simulate <id> --user email=... --prop score=6 --answer nps.submitted:score=9 --timeout await-score`.

**Reuse:** the standalone-exported `run*` functions already used by vitest (e.g. `demo-inapp.ts` exports `runDemoWelcome`), the `overrides` test hatch in `createHogsendClient`, and the graph renderer from §3.1.

### 3.4 (P1 preview) A/B testing — `ctx.variant`

Add `ctx.variant<T>(key: string, variants: Record<string, number>): Promise<string>` to `JourneyContext` (`packages/core/src/types/journey-context.ts` + impl in `packages/engine/src/journeys/journey-context.ts`). Implement **on top of the existing `ctx.once()`** (already durable + replay-stable) so an assignment is computed once and frozen across replays — no new durability machinery. Persist the choice in `journeyStates.context`, emit a `journey.variant_assigned` event so PostHog can segment by arm. This is why it's only S effort: the hard part (replay-stable random) is already solved.

---

## 4. Verification

- **Graph (CLI/docs):** `cd apps/api && pnpm build` then `hogsend journeys graph churn-prevention` — expect a Mermaid flowchart with the 3 sends, 2 sleeps, and the 2 `hasEvent` branches. `hogsend journeys graph --all --out docs/journeys.md` — one file, all journeys. Paste into GitHub to confirm native render.
- **Graph (route/Studio):** `hogsend dev` → `GET /v1/admin/journeys/churn-prevention/graph` returns `{ mermaid, counts }`; open Studio `/studio` → journey detail → "Flow" tab renders + overlays funnel counts.
- **MCP:** add `packages/mcp` to `.mcp.json`, from Claude Code run "list my journeys and show the churn funnel" and "scaffold a trial-ending nudge journey" — verify tool calls hit the admin API and a valid `.ts` is produced.
- **Simulator:** `hogsend journeys simulate feedback-nps --answer nps.submitted:score=3` → trace shows survey send → wait fired → `score <= 6` branch → `nps.detractor` trigger, with **zero** real sends (assert against `email_sends`). Add a vitest in `apps/api/src/__tests__/` driving `simulate()` directly.
- **A/B:** unit test that `ctx.variant` returns the same arm across a simulated replay (reuse the `journey-replay*.test.ts` harness).
- **Guardrails:** `pnpm lint && pnpm check-types && cd apps/api && pnpm test` green before each PR. New `@hogsend/*` packages (`mcp`, `plugin-twilio`) need a **manual first npm publish** (CI can't create them) — per CLAUDE.md.

---

## 5. Sequenced build order (launch-driven)

1. **Positioning rewrite** (§1) — unblocks all launch copy.
2. **Visual graph core + CLI + docs generator** (§3.1) — the screenshot.
3. **Journey simulator** (§3.3) — reuses the graph renderer; the "testable" proof.
4. **MCP server** (§3.2) — reuses admin API + simulator; the agentic wow.
5. **Graph in Studio + admin route** (§3.1 tail) — polish the demo.
6. Launch (Show HN + PostHog #39519 + r/selfhosted).
7. Post-launch: **A/B** (#6), **unified channels + SMS** (#5), then P2.

---

## Appendix — research sources

- [PostHog — You're doing lifecycle emails wrong](https://posthog.com/blog/your-lifecycle-emails-are-wrong) · [Workflows docs](https://posthog.com/docs/workflows) · [Workflows guide (i18n/push/webhooks)](https://posthog.com/tutorials/complete-workflows-guide) · [Push notifications plan (issue #45009)](https://github.com/posthog/posthog/issues/45009) · [Resend-as-provider ask (issue #39519)](https://github.com/PostHog/posthog/issues/39519)
- [Dittofeed (GitHub)](https://github.com/dittofeed/dittofeed) · [Dittofeed site](https://www.dittofeed.com/)
- [OpenMail (GitHub)](https://github.com/ShadowWalker2014/openmail)
- [Loops review 2026](https://encharge.io/loops-review/) · [Resend vs Loops](https://www.buildcamp.io/blogs/resend-vs-loopsso-choosing-the-right-email-platform-for-your-saas)
- [Novu vs Knock vs Courier (2026)](https://www.pkgpulse.com/guides/novu-vs-knock-vs-courier-notification-infrastructure-2026)
- [Customer.io honest review 2026](https://www.getvero.com/resources/an-honest-review-of-customer-io-in-2026/) · [Braze vs Customer.io](https://www.getvero.com/resources/braze-vs-customer-io-which-is-better-in-2026/)
- [Best API-first email platforms 2026](https://www.sequenzy.com/blog/best-api-first-email-platforms) · [Agentic lifecycle marketing 2026](https://www.getjust.ai/blog/agentic-lifecycle-marketing-guide)
- [Hatchet — durable execution](https://docs.hatchet.run/v1/durable-execution)
