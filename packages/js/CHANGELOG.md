# @hogsend/js

## 0.44.0

### Minor Changes

- 820cceb: The revenue spine: first-class value on events, ad-click attribution capture, lead intake, a CRM deals ledger, conversion points, and server-side ad-platform feedback.
  - **Value on events**: `user_events` gains first-class `value numeric(14,2)` + `currency char(3)` — settable via `POST /v1/events`, `@hogsend/client` (`events.send({ value, currency })`), and `@hogsend/js` (`capture(name, props, { value, currency })`). Malformed money is dropped at ingest; every rollup is per-currency, never cross-summed. The analytics mirror forwards both.
  - **Ad-click attribution capture** (`@hogsend/js`): attributed landings (allowlisted click IDs — `fbclid`, `gclid`, `gbraid`, `wbraid`, `ttclid`, `msclkid`, `li_fat_id`, `twclid`, `rdt_cid`, `epik`, `sccid` — or `utm_*`) auto-fire **`campaign.arrived`** with a sessionStorage + server-idempotency dedup guard, persist the set as last-touch, and expose `getAttributionFields()` for form hidden fields. `@hogsend/core` ships the canonical click-ID allowlist and touchpoint event classifier.
  - **Lead intake**: `buildLeadSubmission` (`@hogsend/core`) normalizes any form vendor's webhook into the canonical **`lead.submitted`** event — `hs_anonymous_id` hidden-field identity stitching (browser session + ad clicks + lead land on ONE contact), first-class value passthrough, `submission_id` retry dedup.
  - **CRM deals ledger**: the `CrmProvider` contract (`defineCrmProvider`) with per-provider stage maps onto canonical stages (`lead → contacted → survey_booked → quoted → sold`, plus `lost`); webhooks at `POST /v1/webhooks/crm/:providerId` plus a 10-minute reconciliation poll; a **monotonic deals projection** (late webhooks never regress `sold`; `lost` never overwrites `sold`) minting once-per-deal-per-stage money events **`deal.quoted`** / **`deal.sold`** (+ `funnel.stage_changed`) on the outbound catalog; `crm_links` alias identity so email-less CRM webhooks still resolve the right contact. Reference providers for GoHighLevel, Attio, and HubSpot live in-repo (unpublished).
  - **Conversion points**: `defineConversion` — declare WHICH events count as valued conversions (condition `where` sees the first-class `value`, so "quotes over £10k" works), with a forged-value guard (browser/`pk_` events rejected by default), three value sources (event / fixed / property), and recorded-once semantics (unique on definition + event row).
  - **Conversion destinations**: `defineConversionDestination` + a durable dispatch pipeline — per-destination rows unique on (destination, event_id), a retrying Hatchet task, deterministic `event_id = sha256(contact:definition:eventRow)`, and click-evidence recovery (the contact's latest `campaign.arrived` at-or-before the conversion). New **`@hogsend/plugin-meta-capi`**: Meta Conversions API destination with per-Meta-spec hashing, `fbc` reconstructed from the real stored click (never fabricated), `action_source: system_generated`, and per-definition event naming for Conversion Leads funnel stages.
  - **Admin + Studio revenue surfaces**: `GET /v1/admin/deals` + `/stats` (per-currency sold 30d/lifetime, open pipeline, AOV, avg time-to-close); contacts list gains `minRevenue` + `dealStage` long-tail filters and a per-contact revenue rollup; Studio ships a **Deals** pipeline board with revenue stats and the new contact value filters.

## 0.43.0

### Minor Changes

- 45e2188: First-class SMS channel, mirroring the email architecture.
  - New `SmsProvider` contract in `@hogsend/core` (`defineSmsProvider`) — a dumb plain-text `send` + normalized-webhook (`SmsEvent`) wire; all preference/suppression/render/STOP logic lives in the engine.
  - New `@hogsend/sms` package: SMS templates authored as React components rendered to plain text (`renderSmsToText`), an augmentable `SmsTemplateRegistryMap`, and a GSM-7/UCS-2 segment counter.
  - New `@hogsend/plugin-twilio` (reference provider): send with retry + Twilio error classification, and `X-Twilio-Signature` webhook verification + inbound normalization. Opt-in via `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` + a sender; with no provider configured the SMS service is an inert stub and `sendSms` throws, so existing deploys are unaffected.
  - Engine: `SmsProviderRegistry`, env preset, the engine-owned `createTrackedSmsSender` (idempotency short-circuit with stored-body replay, suppression/consent gate, SMS frequency cap, journey `meta.suppress` min-gap, link rewrite, STOP footer, deploy-coherent test-mode redirect), a replay-safe `sendSms()` for journeys (disjoint `smsSend` key kind; auto-attributes `journeyStateId` from the boundary; passes the pipeline verdict through), `POST /v1/webhooks/sms/:providerId` (guarded-monotonic delivery-status callbacks + inbound STOP/START/HELP), `ctx.history.sms`, and `sms.sent`/`sms.delivered`/`sms.failed`/`sms.clicked` on the outbound catalog.
  - **Explicit consent (TCPA)**: the `sms` channel is opt-in (`defaultOptIn: false`, not configurable) — a marketing send needs an explicit `categories.sms === true` grant (`POST /v1/lists/sms/subscribe`, SDK, preference center) or phone-track consent (inbound START), else it fails closed (`no_consent`). Transactional sends bypass only the consent+topic gates — never the phone STOP list or `unsubscribed_all`. Every genuine grant emits the new **`contact.subscribed`** outbound event (the opt-in mirror of `contact.unsubscribed`) with `source` provenance.
  - **First-party SMS link tracking** (on by default): bare URLs in rendered bodies become `<host>/s/<code>` short links (8-char GSM-7-safe codes; `SMS_LINK_HOST` for a branded short domain, falling back to `API_PUBLIC_URL`; `SMS_LINK_TRACKING=false` disables) riding the existing `tracked_links` → `link_clicks` click spine — per-hit `sms.clicked` outbound, first-touch `sms_sends.clicked_at`, and the `sms.link_clicked` bus event for journeys (unfurl-bot-gated). The tracked rows commit in the same transaction as the send row, and crash replays reuse the stored body, so a code on the wire always resolves.
  - DB: `sms_sends` (+ `clicked_at`), `sms_suppressions` (tri-state: active STOP / express phone consent / none), a `contacts.phone` identity column, and `tracked_links.sms_send_id` + `short_code`.
  - Full TCPA/CTIA opt-out: an inbound STOP (whole-message or leading keyword, so "STOP texting me" counts) suppresses the phone in both the phone-keyed `sms_suppressions` table and the `sms` channel category on `email_preferences` (emitting `contact.unsubscribed`); START grants/resubscribes (emitting `contact.subscribed`).
  - The outbound catalog grows to 21 events (`contact.subscribed`, `sms.sent`, `sms.delivered`, `sms.failed`, `sms.clicked`); the `@hogsend/client` event union also picks up the previously-missing `link.clicked`/`link.arrived`.

## 0.42.0

### Minor Changes

- 6e17712: Promote a Journey Blueprint to a code-first `defineJourney()` file.
  - New `hogsend blueprints promote [id...]` CLI command — generates a `defineJourney()` TypeScript file from one or more blueprints, registers it in `src/journeys/index.ts` on a fresh git branch, prints the staged diff, and — after confirmation — marks each blueprint promoted. Never commits or pushes. `hogsend blueprints list` shows every blueprint's status, trigger, and promotion state.
  - New engine capability backing it: `POST /v1/admin/blueprints/{id}/promote` stamps `promotedAt`/`promotedToJourneyId` and disables the blueprint in one update. A promoted blueprint is now frozen — `PATCH` and `enable` both refuse it (409), closing a gap where a promoted blueprint's graph could previously still be edited or re-enabled out from under the generated code.

- 01ac1f3: Journey Blueprints example content for scaffolded apps.
  - New vendored skill `hogsend-authoring-journey-blueprints` (`packages/cli/skills/`, synced into every scaffold's `.claude/skills/`) — teaches an agent how to create/validate/enable a blueprint via the MCP tools, with the full node/edge vocabulary reference (and what's excluded from v1: `digest`/`sleepUntil`/`capture`/`unknown`).
  - New `pnpm seed:example-blueprint` script in the scaffold — seeds one example Journey Blueprint (a JSON-authored companion to the `welcome` code journey, same primitives) so a fresh app has one to look at in Studio → Journeys immediately, without needing an agent/API call first.

- df76ac6: Fix `hogsend upgrade` breaking existing consumers' type-checking after a new engine dependency ships.

  `@hogsend/engine` ships raw `.ts` source (no build step), so a consumer's own `tsc` type-checks engine's source directly against whatever is in the consumer's `node_modules`. `@types/qrcode` and `@types/papaparse` were declared in the engine's `devDependencies` — which never propagate to consumers — instead of `dependencies`. Any consumer scaffolded before the vanity-links/QR feature (#385) landed hit a `TS7016` on `qrcode` the moment `hogsend upgrade` bumped them past 0.40.0, even though `check-types`/build succeeded in this repo.

  Moved both `@types/*` packages to `dependencies` so they install transitively for every consumer, old and new, regardless of whether `hogsend upgrade` or a fresh `create-hogsend` scaffold picked them up.

- 57e6272: New `@hogsend/mcp` package — a distributable Model Context Protocol server for a running Hogsend instance.
  - New publishable `@hogsend/mcp` package with two transports over one tool implementation: **stdio** (`npx @hogsend/mcp`, for Claude Desktop / Cursor / any local client) and **Streamable HTTP** — a consumer-mounted route (`mcpRoutes()` passed to `createApp`'s `routes` option) served at `POST /v1/mcp` for claude.ai connectors. The hosted route is admin-gated by the engine's existing `requireAdmin` and runs each tool call in-process with the caller's own credential, so there is no new engine dep and no parallel auth path.
  - Surface: three tools (`manage_blueprint` — create/update/validate/enable/disable Journey Blueprints; `hogsend_report` — a read-only health report with severity-ranked findings across the health/blueprints/journeys/deliverability/catalog scopes; `send_test_email`), the `hogsend://blueprint-authoring-guide` resource, and the `find_and_fix_bottleneck` prompt.
  - Engine changes backing it: new `GET /v1/admin/api-keys/self` (returns the calling credential's identity) and `GET /v1/admin/events/names` read routes, `requireAdmin` exported from the engine barrel, the blueprint authoring-guide extracted into a shared env-free `@hogsend/engine/mcp/authoring-guide` export, blueprint `409` conflict bodies now carry a machine-readable `code`, and stricter `entryPeriod` / `within` schema validation.

## 0.41.0

### Minor Changes

- a9d2b9d: Multi-step campaigns: email waves (phase 1 of `docs/campaign-steps-spec.md`).

  A journey runs code per person; a campaign runs waves per audience. Campaign steps are data, executed as set operations over the audience — a 3-step campaign to 100k people costs ~3 durable runs, not 100k.
  - **Steps authoring** — `defineCampaign({ steps: [...] })` with `step.send({ template, props?, subject?, from?, where? })` and `step.wait(duration)` (exported from `@hogsend/engine`). The legacy single-template form is unchanged and compiles to one send step. Validation at definition time: 1–10 steps, first must be a send, no trailing wait, waits ≥ 5 minutes, `where` only on send steps after the first, and every `where` condition must be one the wave runtime can compile to bulk SQL (`property`/`composite`/event-`count` are rejected at deploy, not mid-campaign).
  - **Cohort builder** — `where: (c) => [c.notOpened(), c.notFiredEvent(Events.X)]` with `opened`/`notOpened`/`clicked`/`notClicked(template?)` (first-party engagement over THIS campaign's prior sends), `firedEvent`/`notFiredEvent(event)` (since the campaign started), `linked`/`notLinked(connector)` (v1: `"discord"` via `contacts.discordId`). Conditions normalize to plain `ConditionEval` data at definition time; new core condition type `channel_identity`.
  - **Wave runtime** — the audience is resolved once and anchored into the new `campaign_recipients` cohort ledger at wave 0; later waves qualify from the cohort ∩ the step's conditions ∩ a fresh suppression/unsubscribe/erased-contact re-check (suppression is never snapshotted). Waits park the row in the new non-terminal `waiting` status (`nextStepAt`, punctual scheduled resume + reaper backstop, mirror early-fire guard). Multi-step sends carry step-scoped idempotency keys `campaign:<id>:<step>:<email>`; single-step campaigns keep the legacy key byte-for-byte. Crash/retry resumes at `currentStep` with counts seeded from a wave-boundary snapshot — no double-sends, no double-counting. Cancel works from `waiting` too. DB migration 0037.
  - **Stats + Studio** — `GET /v1/admin/campaigns/:id/stats` gains a per-step breakdown; campaign responses gain `steps`/`currentStep`/`nextStepAt`. The Studio campaign detail page renders a per-step funnel (condition chips, wait separators, current-step highlight) and a `waiting` chip with a next-wave countdown.

  `POST /v1/campaigns` is unchanged (single-template; API/Studio multi-step authoring is a later phase). Channel steps (`step.discord.post`/`.dm`) and timezone-bucketed local-time delivery are phases 2–3 of the spec.

- a8b31e2: Channel-granular recipient preferences, enforced automatically on every send path — and the shipped `<PreferenceCenter>` now renders them. Zero migrations: channels are lists.
  - **Channels are auto-registered opt-out lists** (`kind: "channel"` on `ListMeta`): `in_app` (the notification feed) plus one per connector that exposes member-directed actions (`telegram`, `discord`). They live in the same `email_preferences.categories` key namespace and are managed through the existing `GET /v1/lists` + `POST /v1/lists/:id/(un)subscribe` endpoints. Polarity is identical to the old unknown-key fallback, so existing data behaves exactly as before. `in_app` is now a reserved `defineList` id, and a user list id colliding with a channel id throws at boot.
  - **Member-directed connector actions are preference-gated** — Discord `dmMember`, Telegram `dm`/`sendMessage` now check the resolved recipient's `unsubscribedAll` + channel list BEFORE the plugin runs, returning a typed `ConnectorActionSkipped` (guard: `isConnectorActionSkipped`) instead of sending. The verdict is recorded in the durable journal and replays verbatim. A ref that resolves no contact (raw platform id, group chat) has no preference surface and proceeds. Ops actions (roles, broadcasts, mentions, channel messages) are never gated. Namespaced refs (`telegram:<chatId>`) additionally resolve contacts via their `properties.<ns>` platform metadata, so a Telegram identity linked onto an already-identified contact still gates.
  - **Feed preference check is now replay-safe and multi-row aware.** The `in_app` gate previously ran before the durable idempotency key was registered — a preference flip between run and replay shifted the positional journal and killed the run. The verdict now lives inside the recorded closure. The read also aggregates ALL `email_preferences` rows (matching the email path), so an unsubscribe imported as an `(email, email)` row suppresses the feed too — a deliberate, suppression-conservative fix.
  - **`defineJourney` meta gains `category`** — stamps this journey's `sendEmail` sends in place of the built-in `journey` category, giving per-journey topic granularity through the existing enforcement. Validated fail-closed at boot (unknown → throw; a channel list → throw; an `ENABLED_LISTS`-excluded opt-in list → throw). Campaigns likewise reject channel lists as audiences.
  - **New public write `POST /v1/lists/preferences`** sets the global master `unsubscribedAll` behind the same publishable identity gate as list writes; `GET /v1/lists` items carry `kind`; new `GET /v1/admin/lists` exposes the registry to Studio; the hosted preference page sections Channels above Email topics (byte-identical on channel-less engines).
  - **`@hogsend/js` / `@hogsend/react`**: `ListSummary.kind?`, `preferences().setUnsubscribedAll()`, `ALL_EMAILS_CATEGORY` (`"$all"`) sentinel on `inapp.preference_changed`; `usePreferences().setUnsubscribedAll`; `<PreferenceCenter>` auto-sections into Channels (with a synthetic Email master row) and Topics when the catalog carries channel kinds — flat and matrix modes render byte-identically to before, so existing consumers need zero changes. New props `layout`, `emailToggle`, `sectionLabels`; new `section`/`sectionHeader` classNames; new `data-sectioned`/`data-section`/`data-kind` attributes.
  - **Studio**: the contact drawer gains Channels/Topics preference toggles (email master included) over the new admin lists endpoint.

- ed0351c: Digest and throttle land as journey primitives — the "14 events fired, we emailed the user 14 times" class of problem ends here.
  - **`ctx.digest({ window, event?, where?, maxEvents?, lookback?, label? })`** — aggregate a burst of events into ONE execution. The first event enrolls the journey; every same-named event landing during the window is absorbed by the active-enrollment guard (stored in `user_events`, spawning no run) and collected at flush. The window deadline and the flushed result are recorded set-once in the journey state row, so a replay-from-top returns the verbatim same event set on ANY engine — even if backfilled events land inside the closed window afterwards. The scan applies the journey's `trigger.where` by default, excludes Studio debug events, re-verifies rows against the strict condition engine, and orders deterministically. Windows go up to 720h and are never tier-gated. "Batch" is deliberately not a primitive: `Object.groupBy(digest.events, …)` in plain TypeScript is the batch recipe, documented in the journeys guide.
  - **`ctx.throttle({ limit, window, category?, label? })`** — an advisory "has this user had too many emails already?" branch. Counts the recipient's windowed non-failed `email_sends` (the same count the mailer-level frequency cap enforces on) and RECORDS the verdict set-once per site, so a replay branches identically even though the run's own send has since landed in the counting window. The client-level `frequencyCap` remains the hard send-time backstop.
  - **`JourneyMeta.suppress` is now enforced.** It was documented ("minimum time between sends within this journey") but read by nothing. The tracked mailer now skips a journey-bound send (`journey_suppressed`, no provider call, no row) when a non-failed send for the same journey and recipient exists inside the suppress window, across all enrollments; the verdict is recorded for replay stability. Zero disables; transactional and non-journey sends are untouched.
  - **Enrollment burst hardening** — two near-simultaneous first events racing enrollment no longer surface the loser as a failed Hatchet run: the insert carries `ON CONFLICT` against the live-enrollment partial unique index and folds to the `already_active` skip.
  - **Stranded-waiting detection** — check-alerts now flags `waiting` journey states whose `wait_deadline` or un-flushed digest deadline is more than an hour past due, with an operator hint: such a row silently absorbs every future trigger event for that user+journey until repaired.
  - **Studio** — journeys using `ctx.digest` render a digest node in the flow graph (`ctx.throttle` is a decision input, not a node).
  - **Foundation** — `ctx.once`'s durable record-once write is now SQL-level first-writer-wins with a read-back, shared by the new primitives via the exported `recordOnce`/`peekRecord`; reserved context namespaces `__digest__`/`__throttle__` join `__once__`.
  - **Durable sleeps/timeouts normalized to whole-seconds durations** — `ctx.sleep`/`ctx.sleepUntil`/`ctx.digest` and the `waitForEvent` timeout branches now pass Hatchet a single-unit whole-seconds Go string (`"120s"`) instead of a millisecond number. The SDK renders a raw ms number as a multi-unit string (`"1m59s"`) that some hatchet-lite versions silently fail to honor as a durable sleep condition — the wait resolves instantly with an empty match. This also fixes latent instant-fire on `ctx.sleepUntil` and the `waitForEvent` timeout branch for any non-whole-hour duration.
  - **Graceful worker shutdown no longer marks in-flight waiting journeys as failed** — a SIGTERM/`worker.stop()` aborts suspended durable runs so Hatchet can REASSIGN them; the abort surfaced as a journey failure (row → `failed` + `journey:failed`), permanently poisoning the enrollment so the re-dispatched run found a terminal row and never resumed. The engine now detects the SDK abort (by error name/code + the aborted signal) and, when the row is still `waiting`/`active`, leaves it untouched and rethrows — so recovery-first resumes the recorded window after restart. Enrollments now survive a redeploy mid-wait (any `ctx.sleep`/`waitForEvent`/digest window). Pre-existing bug, maximally exposed by digest's long in-process waits.

- 398ebf0: Journey Blueprints — JSON-authored journeys, DB-stored, worker-executed. Same worker, same durable primitives (`ctx.sleep`/`ctx.waitForEvent`/`sendEmail`/`ctx.trigger`) as a code `defineJourney`, but stored as a row instead of committed code — an agent or admin can create and run a lifecycle automation without a PR.
  - **New `journey_blueprints` table** (migration `0044`): `id` (= the graph's `journeyId`), `status` (`draft`/`enabled`/`disabled`), `version`, `triggerEvent`/`triggerWhere`, `entryLimit`/`entryPeriod`, `exitOn`, `suppress`, `graph` (jsonb), `source` (`mcp`/`studio`/`api`), `createdBy`, `promotedAt`/`promotedToJourneyId`.
  - **Execution-tier graph validation** (`blueprintGraphSchema`, `@hogsend/core`) — a stricter profile of the existing `JourneyGraph` IR (acyclic, no `unknown`/`digest`/`sleepUntil`/`capture` nodes, resolved conditions), layered with engine-side template/connector registry checks. Every write path runs through one `validateBlueprintGraphForSave` — an invalid graph is never saved.
  - **One generic `journeyBlueprintInterpreter` Hatchet task** walks a blueprint's graph using the SAME primitives a code journey calls, so replay-safety and exactly-once sends needed zero new engine work. Dispatch-at-ingest (`checkBlueprintTriggers`) routes matching events to it without a worker redeploy.
  - **Admin CRUD + lifecycle API** (`/v1/admin/blueprints/*`): create/list/get/patch, a dry-run `/validate` (and per-blueprint `/:id/validate`), `/enable`/`/disable`. A graph-changing edit is rejected (409) while the blueprint has any active/waiting enrollment — Hatchet's durable sleep/wait primitives are matched positionally on replay, so changing the node sequence out from under a suspended run could desync it.
  - **Agent-facing MCP tool set** (`create_journey_blueprint`, `update_journey_blueprint`, `validate_journey_blueprint`, `enable_journey_blueprint`, `disable_journey_blueprint`, `list_email_templates`, `list_events`) over the same service layer the HTTP routes use — no parallel auth or storage path.
  - No forced approval gate: a blueprint can be created already `enabled`. Studio gives post-hoc oversight (visible immediately, `createdBy` provenance, instant disable), not a pre-send review step.

- 398ebf0: Journey Blueprints are now visible in Studio, colocated with code-defined journeys.
  - The `/journeys` list merges in blueprint rows alongside `defineJourney` journeys — a Kind badge (Code/Blueprint) tells them apart, and blueprint rows carry their own three-state status (draft/enabled/disabled).
  - A new blueprint detail page renders the same flow-graph view as a code journey — a blueprint's `GET /:id/graph` is byte-identical in shape to the code-journey route, so the existing renderer needed no changes, plus a definition card and a recent-instances table.
  - View + enable/disable only for now — blueprints are still authored via MCP or the admin API, not from Studio (no visual graph editor yet).

  No migrations; API changes are additive.

- 3bc1b2a: Studio campaign detail pages at journey-page fidelity.

  **Campaign detail view.** Campaigns rows now click through to `/studio/campaigns/:id` — the broadcast sibling of the journey detail page. The page leads with a lifecycle band in the flow view's node-card language (created → scheduled → sending → terminal; the live stage carries a pulsing "now" chip, a `sent/total` counter, and a progress bar; stages that never happened render dashed), then a Definition card (audience, template, subject/from overrides, schedule), a Delivery funnel (recipients → sent → delivered → opened → clicked with per-stage drop badges, plus a skipped/failed/bounced/complained strip), the template's engagement row with an inline preview, and a per-recipient sends browser (cumulative Opened/Clicked/Bounced/Failed chips) that opens the shared send-detail drawer. In-flight campaigns poll every 4s so a live blast visibly advances; cancel (with the same chunk-boundary confirm copy) is available from both the list and the detail header.

  **New admin surfaces backing the page.** `GET /v1/admin/campaigns/:id/stats` aggregates post-dispatch engagement (delivered/opened/clicked/bounced/complained/failed + `lastSentAt`) from the campaign's `email_sends` rows, attributed via the deterministic `campaign:<id>:<email>` idempotency key — now minted and matched through one shared `campaignSendKey`/`campaignSendKeyPattern` helper so the format can't drift. `GET /v1/admin/emails` accepts `campaignId` to list one campaign's sends (composes with the existing status/engagement filters). Campaign responses (data plane + admin) additionally carry the per-campaign `subject` and `fromEmail` overrides.

  **Shared crimzon primitives.** The funnel stage-strip geometry (`FunnelStages`/`FunnelNotes`) and the sandboxed `TemplatePreviewFrame` are extracted into shared Studio components; the journey funnel and journey email card now render through them, so journey and campaign pages speak one visual language.

  No migrations; API changes are additive.

- d549293: Vanity slugs and QR codes on managed links.

  **Vanity slugs.** A managed link can now carry an operator-chosen slug — `/l/black-friday` — layered over the UUID short URL. Slugs are 1–64 chars of `[a-z0-9-]` (no leading/trailing hyphen), normalized lowercase at every write, and unique per instance (`links.slug`, migration `0037`). Mint one with `mintLink({ slug })` or `POST /v1/admin/links { slug }` (409 when taken); `PATCH` sets, replaces, or clears it (`slug: null` frees it for reuse). The new root-mounted `GET /l/:slug` redirect resolves the link's canonical tracked row and runs the exact same click pipeline as `/v1/t/c/:id` — same `link_clicks` row, same counters, same `link.clicked` events — so counts never split by entry path. Archived links keep resolving (matching UUID-redirect behavior); clearing the slug is the explicit kill switch. The Studio Links view grows a slug field on create/edit with inline conflict handling and shows the copyable `/l/…` short link.

  **QR codes.** Every managed link can render a QR code: `GET /v1/admin/links/:id/qr?format=svg|png&size=64..2048&transparent=true|false` (admin-authed; `transparent` renders a transparent background in both formats, for print/overlay). The code encodes the link's durable scan URL — a second `tracked_links` row (`source: "qr"`, lazily minted, race-safe via a partial unique index, migration `0038`) — never the vanity slug, so printed codes survive slug changes AND destination re-targets (`PATCH` updates the scan row alongside the canonical row). Scans are counted separately: link responses now carry `scanCount` (QR-only subtotal) next to `clickCount` (all-paths total), and `source: "qr"` rides the existing `link.clicked` outbound payload.

  **Print-first QR codes with per-destination stats.** Every `link_clicks` row now stamps `destination_url` — the redirect target that was live when that hit landed — so after a re-target, each destination keeps its own numbers: `GET /v1/admin/links/:id` returns a `destinations` array (`url`, `clicks`, `scans`, `firstAt`, `lastAt`; pre-feature rows bucket as `url: null`). Links gain a nullable `description` (mint + PATCH + responses) for telling printed codes apart in bulk, and `GET /v1/admin/links?hasQr=true` filters to links whose QR scan row exists. Studio gains a **QR codes** view over that lens — "New QR code" mints from destination + label + description, and the shared QR dialog adds inline re-targeting, the per-destination breakdown, and a split-button export (PNG / transparent PNG / SVG; the journeys `SplitButton` is now a shared `@hogsend/studio` UI primitive).

  **Arrival attribution — "did a known user scan this?"** Opt-in per link (`appendRef`, default false), the redirect appends `hs_ref=<hit id>` to the destination (same URL-build pass as `hs_t`); the landing page reports the visitor back to the new unauthenticated `POST /v1/t/arrive`. Identity is evidence-based and mirrors the existing trust model exactly: a `userToken` proves a userId (`visitor_kind: "token"` — a known contact); a raw anon id is provenance-only, collision-checked against identified contacts before stamping and ingested under `restrictToAnonymous`; a bare asserted email/userId isn't in the schema. The hit row is stamped first-write-wins (replays re-run ingest from the stamped identity via `idempotencyKey link:arrived:<ref>` — self-healing, never re-attribution), and a new **`link.arrived`** event (16th catalog member; bus + outbound) fires with the visitor's identity — trigger journeys on it, filtered by `linkId`/`campaign`/`source: "qr"`. Every outcome answers `200 {"ok":true}` (no contact-existence oracle). Link detail gains `arrivalCount`/`identifiedArrivalCount` + stamp fields on `clicks[]`; Studio gets the "Append arrival ref" toggle (QR create defaults ON) and known-contact arrival counts in the QR dialog. `@hogsend/js` auto-captures `hs_ref` on init (config `captureRef: false` to disable; manual `hogsend.captureRef()` for SPAs).

  Migrations `0037`/`0038`/`0039`/`0040` are additive (nullable columns + indexes + a default-false boolean) — no data changes, no breaking API changes. New engine dependency: `qrcode` (mirrored in the create-hogsend template).

### Patch Changes

- 8a793ea: Campaign reaper: the in-flight (`queued`/`sending`) give-up now actually fires for poison campaigns.

  The give-up window was measured from `updatedAt`, but the stale sweep's own re-enqueue bumps `updatedAt` as its re-pick guard — so a deterministically-crashing campaign was re-bumped every cycle and could never age past the window (the give-up was dead code for in-flight rows). New nullable `campaigns.stale_since` column (migration 0042) separates "when did progress last happen" from "when did we last poke it": the stale sweep coalesce-sets it once on the first re-enqueue, every genuine progress flush of the send task clears it back to NULL, and the crash-path flush preserves it. The give-up clause reads `stale_since < now() - CAMPAIGN_GIVE_UP_AFTER_MS` — "continuously stuck for 6h with zero progress", which is what the docstring always claimed. `scheduled`/`waiting` give-ups are unchanged (still measured from `scheduledAt`/`nextStepAt`).

- 683b74a: `bucket_memberships.userEmail` is now normalized (trim + lowercase) at every write site — the realtime join, the reconcile cron, and the backfill task — and migration 0043 backfills existing rows (`UPDATE … WHERE user_email IS DISTINCT FROM lower(trim(user_email))`, a no-op for already-clean rows).

  Previously the realtime join wrote the email verbatim from the raw event payload, so a mixed-case membership email could case-miss its normalized `email_preferences` row — the reason every read site (campaign resolvers, suppression pre-filters) carried defensive `lower(trim(…))` joins (audience-model.md wart #1). Those read-side defenses are retained for one release as belt-and-braces and can then be stripped. The emitted `bucket:entered`/`bucket:left` events and the fast-expiry timer payload now carry the normalized address too.

- a9b5fc2: Studio journey detail: the Definition and Funnel cards move off the top of the page and into the flow's side panel, shown when no node is selected. The workflow is now the first thing on the page; selecting a node still swaps the panel to the node inspector. The funnel restacks vertically (label, drop badge, share of enrolled, count, ratio bar per stage) so it reads cleanly at panel width, and the node-type legend is gone — the "Left the journey" strip closes the funnel instead. Engine-line packages are version-bumped in lockstep with no code changes.

## 0.40.0

### Minor Changes

- 4ebdcb9: Campaigns grow up into schedulable, code-first broadcasts.
  - **`sendAt` scheduling** — `POST /v1/campaigns` accepts a future ISO instant; the campaign is created `scheduled` and delivered by a punctual Hatchet scheduled run, with the reaper cron promoting any due-but-unfired row as backstop. A `sendAt` more than 60s in the past is rejected.
  - **`defineCampaign()`** — a broadcast as a committed file. The worker's boot reconciler upserts each definition (keyed `campaign-def:<id>`): future `sendAt` schedules, edits to a still-`scheduled` campaign sync on redeploy (moving `sendAt` re-schedules), a stale `sendAt` at first deploy is marked `expired` (never a surprise blast, grace window `CAMPAIGN_DEFINE_GRACE_MS` default 1h), and a `sent` campaign is retired — redeploys no-op. Wire via `createHogsendClient({ campaigns })`.
  - **Cancel** — `POST /v1/campaigns/{id}/cancel` cancels a `scheduled`/`queued`/`sending` campaign. A mid-send cancel stops at the next chunk boundary; completion uses a CAS so a cancel racing the final chunk is never overwritten. New statuses: `scheduled`, `canceled`, `expired` (db migration 0036 adds `scheduled_at`/`canceled_at`).
  - **List** — `GET /v1/campaigns?status=&limit=&offset=` (newest first, `hasMore`).
  - **Studio** — new Campaigns view (admin routes `GET/POST /v1/admin/campaigns...`): statuses, counts, scheduled-for, cancel.
  - **SDK** — `hs.campaigns.send({ sendAt, idempotencyKey })` (the key was previously accepted by the route but dropped by the SDK), `hs.campaigns.list()`, `hs.campaigns.cancel(id)`.
  - **CLI** — `hogsend campaigns send --at <iso> --idempotency-key <k>`, `campaigns list --status`, `campaigns cancel <id>`.
  - **Fixes** — the route/reaper enqueued sends with `.run()` (which waits for the whole blast to finish inside the request / cron timeout); now `runNoWait()`. The keyed create's `ON CONFLICT` now carries the partial-index predicate (`WHERE idempotency_key IS NOT NULL`) — without it Postgres rejected the insert (42P10).

### Patch Changes

- ee4518f: Give the engine's Better Auth its own cookie namespace so the Studio stops fighting a sibling web app's SSO cookie.

  The engine's Better Auth (the Studio, e.g. `t.hogsend.com`) used Better Auth's default cookie name (`__Secure-better-auth.session_token`) with no prefix. A sibling web app on the shared parent domain can set a cross-subdomain SSO cookie of that SAME default name (e.g. `crossSubDomainCookies: { domain: ".hogsend.com" }`), which the browser also delivers to the Studio host. The engine reads it under the shared name, looks the token up in its OWN database — a different DB — finds nothing, and `get-session` returns null, so the Studio bounces back to login in a loop even though the user "has a session" on the sibling app.

  The engine now sets `advanced.cookiePrefix`, so its session cookie is `__Secure-hogsend.session_token` (dev/http: `hogsend.session_token`) and no longer collides. The prefix is configurable via a new optional env `AUTH_COOKIE_PREFIX` (default `"hogsend"`), plumbed `env.ts → container.ts → createAuth`. This is server-config-only — no client, middleware, or literal cookie-name changes: every consumer resolves the session through `auth.api.getSession(...)`, which derives the prefixed name from the same options.

  Any sibling web app that intentionally shares a cross-subdomain cookie keeps Better Auth's default prefix, so its own single-sign-on is fully preserved; the two cookies simply no longer share a name.

  Note: renaming the cookie logs existing Studio sessions out ONCE (they must sign in again to mint a cookie under the new name). There is no database migration — session rows are untouched, and the old cookie lingers ignored until it expires. CLI-created and `STUDIO_ADMIN_*` bootstrap admins are unaffected. `AUTH_COOKIE_PREFIX` does not need to be set on any deploy; the `"hogsend"` default is authoritative.

## 0.39.0

### Minor Changes

- aa3eedc: Boot-validate config ids — fail loud on unresolved references instead of silently mis-behaving.
  - `ANALYTICS_PROVIDER`: throw at boot when the env-selected id resolves to no registered provider (symmetric with `EMAIL_PROVIDER`); the raw `process.env` read distinguishes an explicit request from the zod default, so a no-analytics deploy still boots.
  - `ENABLED_JOURNEYS`: throw at boot on an id that matches no journey, with a did-you-mean. Bucket-reaction journey ids are accepted; validation is skipped when no top-level journeys are injected.
  - `JourneyRegistry.register()`: throw on a duplicate journey id instead of silently overwriting (which also double-routed the trigger).
  - Template `category`: boot-validate every template's category against the email-list namespace. Unknown → throw; an opt-IN list (`defaultOptIn:false`) excluded via `ENABLED_LISTS` → throw (excluding it un-gates consent at send time — CAN-SPAM/GDPR); an opt-OUT list excluded → warn; reserved built-ins and registered lists → ok.
  - `POST /v1/emails`: reject an unknown `category` (the request-time twin of the template-category guard — a caller-supplied category overrides the template's).

- b3bb1f6: Fail the build on unregistered journey email template keys.

  `sendEmail`'s `template` is now typed against the registered-key union
  (`TemplateName`) instead of `string`, so a journey referencing an email template
  that was never registered is a compile error at every send site. As a runtime
  backstop, `@hogsend/email`'s `getTemplate` / `getTemplateDefinition` /
  `getPreviewText` throw a loud, actionable error naming the bad key and the
  registered ones (an own-property check, so inherited `Object.prototype` keys
  can't slip through). Fixes the class of bug where a journey could point at a
  template that doesn't exist and only fail when a real send ran.

## 0.38.2

### Patch Changes

- e059b87: Harden long-running journeys against two narrow strand windows (both distinct from the recovery-first fix in the previous release).
  - **Durable-wait resumes survive a redeploy's slot saturation.** The journey task now sets `scheduleTimeout: "15m"` (the SDK default is ~5m). When a durable-wait resume is re-queued during a deploy and every worker slot is momentarily busy, the tighter default could cancel the resume in the queue and strand the enrollment in `waiting`; 15m gives it head-room to land on a freed slot. This adds no replay path — it is pure queue head-room.
  - **A transient DB error while resolving the enrollee's timezone no longer strands the row.** The pre-`run()` timezone lookup fetches the contact row and PostHog person props concurrently; the PostHog leg already swallowed errors but the contact read did not, so a blip there rejected out of the task _before_ the try/catch and left the just-inserted `active` row unhandled. The contact read now falls through to the client-default timezone, mirroring the PostHog leg.

  Journey `retries` are intentionally left at `0`: a retry replays `run()` from the top, and the tracked mailer / connector delivery is "missed > doubled" (it re-drives a `queued` row and voids the idempotency key of a failed send), so enabling retries would re-deliver any message whose `provider.send()` had already gone out before its durable status flip committed. Making sends provider-idempotent is a prerequisite and is tracked separately.

## 0.38.1

### Patch Changes

- 1bd79ff: Fix: multi-step `once` journeys silently stalling after their first durable wait.

  On an eviction-capable Hatchet engine (hatchet-lite >= v0.80.0) every `ctx.sleep` / `ctx.waitForEvent` evicts the durable task and **replays the journey `fn` from the top** on resume. The enrollment guards (`entryLimit`, email-preference, `trigger.where`, `enabled` / admin-disable, active-state) ran at the top of `fn` **before** the replay-recovery lookup by `hatchetRunId`. So on every resume they re-ran against live state — and for `entryLimit: "once"` the entry-limit guard found the row the first entry had created and returned `skipped: already_entered_once`, short-circuiting **before** recovery and `run()`. The journey never advanced past its first wait: it was stranded in `waiting`, and every email / step after the first sleep was silently dropped (no error, no `journey:failed` — nothing sweeps a stuck `waiting` row). Multi-step `once` journeys (welcome series, conversion nudges) therefore stopped completing whenever a worker redeploy or eviction landed in a wait window; short / `unlimited` journeys were unaffected.

  The recovery lookup now runs **first**: a resume recovered by `hatchetRunId` reuses its enrollment and bypasses the entry-eligibility guards (a resume is not an entry), while those guards run only on the genuinely-new-enrollment path. The same guards that also affected `once_per_period` (wait shorter than the period) and unsubscribe-during-a-wait are fixed by the same reorder. Sends inside `run` still re-check subscription (`ctx.guard.isSubscribed()`), and the tracked mailer enforces suppression at send time, so bypassing the entry-time preference gate on a resume never emails an unsubscriber. Exactly-once is preserved: a recovered resume keeps the same `stateId` / run-anchored idempotency keys, so a replayed pre-wait send dedups via the existing unique-index backstop. Covered by a new regression test that evicts a `once` journey at its first sleep, replays from the top, and asserts it resumes and completes with no duplicate send.

## 0.38.0

### Minor Changes

- b7a4a2d: Bulk suppression-list import + migration importer CLI.

  **Engine — `POST /v1/admin/suppressions/import`** (+ `GET /v1/admin/suppressions/import/{jobId}`): async bulk import of unsubscribes / bounces / spam complaints via a new `import-suppressions` Hatchet task (CSV or JSON, batches of 500, `import_jobs` lifecycle, errors capped at 100). Rows are `email` (required), `reason` (`unsubscribed` | `bounced` | `complained`, default `unsubscribed`), `externalId` (optional), mapped onto the existing `email_preferences` semantics — no schema change: `unsubscribed` → `unsubscribed_all`, `bounced` → `suppressed` + `bounce_count = GREATEST(bounce_count, 1)` (idempotent re-runs) + bounce timestamps, `complained` → `suppressed` with the bounce count untouched. Writes go through the single `upsertEmailPreference` choke point, which gains an `emitOutbound` opt-out (default `true`; the import passes `false`) so a historical import does not fan out per-row `contact.unsubscribed` outbound events.

  **Behavior change — `POST /v1/admin/contacts/import` no longer awaits the task run.** The route previously `await`ed `importContactsTask.run(...)` to completion before returning its 202, defeating the async job + status-poll contract on large imports. Both import routes now enqueue with `runNoWait()` fire-and-forget: the 202 means "queued", and a failed enqueue marks the job row `failed` (with the error recorded) so status pollers get a terminal state. Both routes also cap `data` at 4MB — the Hatchet gRPC message ceiling a bigger payload could never clear anyway.

  **Send-time suppression gate aggregates per address.** `checkSuppression` now reads every `email_preferences` row for the recipient address (the PK is `(user_id, email)`, so a suppression imported before the contact existed lives on a different row than later interactive writes) — any suppressed / unsubscribed-all signal on any row blocks the send, and category maps merge with explicit false winning.

  **CLI — new `hogsend import` command** (`@hogsend/cli`): migrates contacts _and_ suppression state into a running instance over the admin API, chunking large inputs into one import job per 5,000 rows and polling each to completion. `hogsend import csv --file <path> [--suppressions]` for generic header CSVs; `hogsend import loops --csv <audience.csv> [--api-key] [--check-suppressions]` for the Loops dashboard export (typed custom properties via the Loops API; per-contact suppression lookups at 10 req/s, imported as reason `bounced` since Loops merges bounces + complaints); `hogsend import customerio --app-key <key> [--region us|eu] [--segment <id>] [--esp-suppressions]` drives the Customer.io App API async people export end-to-end and optionally imports the ESP bounce/spam-report lists. Source-platform requests are rate-limited (10 req/s) with retry-on-429 backoff. Job polling aborts with an error (naming the job id) after 10 minutes without progress instead of hanging forever; the Loops suppression check aborts on auth/terminal errors rather than silently importing zero suppressions; the Customer.io export download inflates gzipped files.

  Other engine-line packages ride along to keep the version line uniform.

### Patch Changes

- 27ca9ea: Consent-gated storage seam: `@hogsend/js` now exports its storage adapters
  (`createMemoryStorage`, `createLocalStorage`) and `HogsendProvider` accepts a
  `storage` prop forwarded to `createHogsend` — so a host app can keep the SDK
  from persisting `hs_anon_id` until the visitor grants cookie/storage consent
  (pass a memory or consent-gated adapter), matching the cookieless-until-consent
  pattern already used for PostHog. Other engine-line packages ride along to
  keep the version line uniform.

## 0.37.3

### Patch Changes

- a1faed0: Keep the engine version line uniform: bump every engine-line package (and the `create-hogsend` scaffolder) alongside the `@hogsend/react` feed-archive fix, so all `@hogsend/*` packages publish on one version and the scaffold's `^{{ENGINE_VERSION}}` caret pins stay aligned.

## 0.37.2

### Patch Changes

- 19ba821: `@hogsend/react`: clean feed-notification truncation + a reveal animation. Long titles and bodies now clamp to a token-driven N-line ellipsis (`--hs-feed-item-title-lines` / `--hs-feed-item-body-lines`, default 2) instead of being ragged-clipped mid-line with shaved descenders; the inline survey block is left untouched. New feed items also fade + lift in as they mount (`--hs-feed-item-enter-ms`), gated behind `prefers-reduced-motion` and kept clear of the swipe-to-archive exit animation.

## 0.37.1

### Patch Changes

- a9b12de: `@hogsend/react`: responsive in-app feed + survey card. The feed now sets its own type baseline so notification items don't balloon to a large host font-size, bodies are sized and muted for readability, and the `scale`/`nps` survey scale flows as a single shrink-to-fit row instead of wrapping into a ragged grid in narrow feeds (including the 380px bell popover).

## 0.37.0

### Minor Changes

- f21fb2b: In-app component kit — survey/rating primitive, preference center, swipe-to-archive, BYO toast, and a notification-badge fix.
  - **Survey / rating primitive** — a surface-neutral `<Survey>` email component and an in-app survey feed block (`SurveyBlockView`) plus `sendSurvey()`. Answers ride the existing event spine (no new write path) and are readable from journeys via `ctx.waitForEvent`. New read-only `GET /v1/admin/reporting/breakdown` aggregates any event by a property value (count, average, optional NPS).
  - **`<PreferenceCenter>`** — per-category × per-channel notification preferences over `usePreferences`, bundleable into `<FeedPopover>` as a tab. New read-only `GET /v1/lists` catalog.
  - **Swipe-to-archive** — brought into `@hogsend/react` as a first-class affordance (pointer/touch swipe + an accessible archive button, wired to the existing `markAsArchived`).
  - **Toast** — polished default skin and first-class custom rendering (`renderToast`).
  - **Notification bell badge** — fixed `box-sizing` so the unread count renders as a solid, pinned circle under any host CSS reset.

## 0.36.1

### Patch Changes

- 3853800: fix(engine): provenance-pin engine-internal re-ingests so a contact's own canonical key never mints a phantom identified twin

  A server-side re-ingest keyed by `userId = <a contact's canonical key>` (which for an anonymous — or email+anon — contact IS its `anonymous_id`) was resolved through the value path, which only matches `external_id`, so it minted a second "identified" contact `{ external_id: <anonId> }`. That phantom twin then tripped the in-app feed's `collidesWithIdentified` guard, 403-ing the visitor out of their OWN feed (`anonymousId is not addressable`). The most direct trigger was the feed's own mark-read / mark-all re-ingests.

  Fix: engine-internal re-emit sites now carry the subject's unforgeable contact row id (`contactId`) and the resolver pins to that exact row (`resolveByContactId`, `FOR UPDATE`, follows merge-aliases to the survivor) — never value-resolving, never minting. The public `/v1/events`/`/v1/feed` routes cannot supply `contactId` (schemas omit it, handlers build the resolve literally, and it's mutually exclusive with the publishable clamp), so the anti-impersonation boundary is unchanged and `collidesWithIdentified` stays strict. Threaded through `ingestEvent` + the feed mark/clear re-ingests; genuine external identities (no `contactId`) take the unchanged value path.

## 0.36.0

### Minor Changes

- 02dab59: Client-side layer: `@hogsend/js` (zero-dependency browser core — identity, capture, preferences, in-app feed, banners, toasts, reactive store) and `@hogsend/react` (provider, hooks, and the `NotificationBell`/`FeedPopover`/`NotificationFeed`/`Banner`/`Toast` components with a `--hs-*` themed override surface), plus the engine pieces that power them:
  - Publishable-key (`pk_`) browser-ingest auth (`requirePublishableOrIngest`, per-key origin allowlist, `allowed_origins` migration, reflective CORS, `GET /v1/lists/preferences`).
  - The in-app feed backend: `feed_items` table, `sendFeedItem()` + `send-feed` workflow, recipient-scoped `/v1/feed/*` routes with SSE fan-out.
  - `sendBanner()` on the feed primitive, and the server-side `generateUserToken` mint helper for identified browser sessions.

  Every client interaction is a first-party `inapp.*`/`banner.*` event through the ingest spine, so it can trigger a journey and fan to PostHog. `@hogsend/js` and `@hogsend/react` ride the engine version line but are opt-in (not `create-hogsend` scaffold defaults).
