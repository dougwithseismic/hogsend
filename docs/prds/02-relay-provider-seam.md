# PRD 02 — RelayProvider seam for the SES email relay (BUILD — trimmed send+events scope)

> **Status: promoted to a build wave (2026-08-16), TRIMMED scope.** Decision #4 was resolved by the
> user: **send + events surface only.** No second relay is on the roadmap, so this does NOT chase full
> neutrality of domains/inbound/reputation — those stay the SES impl's private business. The win here
> is Interface Segregation + a named boundary + testability for the two verbs the relay actually uses,
> NOT a full strangler. Behavior-preserving, zero regression.

## What the scout found (the build rests on this)

- **The send path already injects its client** (`RelayDeps.ses?: SesClient`, falling back to
  `getSesClient(caller.region)`) and uses only **2 of SesClient's 20 verbs** — `sendEmail`,
  `sendBatch`. Depending on the full 20-verb client to call 2 is the segregation smell this seam fixes.
- **The send message is already near-neutral** — `SesMessage`/`SesAttachment` (`ses/types.ts:132`) are
  explicitly "portable shapes mirrored from `@hogsend/core`." Only the RESULT is SES-shaped
  (`{ messageId }` vs the neutral `{ id }`).
- **The events side is ALREADY provider-neutral in shape.** `normalizeSesNotification`
  (`lib/ses-events.ts:191`) turns SES's SNS notification into `HogsendRelayEmailEvent`
  (`packages/plugin-hogsend/src/webhook.ts`), and the final neutral `BounceClass` classification
  happens engine-side, not here. So events need FORMALIZING behind the provider, not rebuilding.
- **Load-bearing send ordering** (`email-relay.ts:52`) — auth → pause → rate-limit → validate →
  attachments → tier-cap → allowance → idempotency-claim → **ses.send** → commit → meter — and the
  `SesError`→`sendFailureResponse` mapping (`:813`) MUST be untouched. The adapter narrows the
  dependency; it does not move a single step of this pipeline.

## The seam

```
handleRelaySend / handleRelaySendBatch  ──►  RelayProvider (send, sendBatch)   ──►  SesRelayProvider  ──►  SesClient.sendEmail/sendBatch
handleSesEventNotification              ──►  RelayProvider.normalizeEvent      ──►  SesRelayProvider  ──►  normalizeSesNotification
```

`RelayProvider` exposes ONLY the relay's real needs; `SesRelayProvider` wraps the existing 20-verb
`SesClient` + `normalizeSesNotification`. Nothing below `SesClient` changes.

## Goal

Give `apps/cloud`'s email relay the same provider seam the engine already has for outbound email
(`EmailProvider`: Resend/Postmark), so "the cloud app *is* an SES app" becomes "the cloud app *hosts*
a relay; SES is one implementation." This is the extensibility unlock for the ~40% of the app that is
email/SES.

## The critical finding: a seam already exists, at the wrong altitude

`src/ses/contract.ts` already defines `SesClient` — *"The frozen SES seam: TWENTY verbs, two
implementations (`FakeSesClient`, `AwsSesClient`)."* This is genuinely good and stays.

But it is **SES-shaped**, not relay-shaped. Its verbs are AWS SES vocabulary — `createTenant`,
`createConfigurationSet`, `putEventDestination`, `putSuppressionScope`, `setMailFrom`,
`setReputationPolicy`, `listRecommendations`, reputation entities. A different relay (Postmark, a
self-hosted MTA, another cloud) has no "configuration sets" or "SES tenants." So `SesClient` is
"talk to AWS SES," not "be the fleet's relay."

**Therefore the work is NOT to replace `SesClient` — it is to introduce a HIGHER seam above it:**

```
callers (services/, lib/, routes/)  ──►  RelayProvider (provider-neutral)  ──►  SES impl  ──►  SesClient (existing 20-verb seam)  ──►  AwsSesClient | FakeSesClient
```

`RelayProvider` is provider-neutral; the SES implementation wraps the existing `SesClient`. Nothing
below `SesClient` changes.

## Capability surface (to be finalized during this PRD's build wave)

The neutral contract should expose only what a relay MUST do, named in provider-neutral vocabulary
(mirror the engine's `EmailProvider` naming discipline — SQL/HTTP register, no AWS jargon):

- **Send** — `send` / `sendBatch` (HTML in, `{ id }` out). Likely already close to neutral.
- **Sending identity / domains** — prove and manage a customer's sending domain (DKIM, MAIL FROM,
  verification status). SES calls these "identities"; neutral name TBD.
- **Inbound spool** — receive replies, hand back raw MIME + parsed events. SES-specific today
  (S3 bucket + v1 receipt rules + SNS). **Open question:** is inbound part of the neutral contract or
  a capability flag (`capabilities.inbound`) like the engine's `scheduledSend`/`signedWebhooks`?
- **Deliverability events** — delivered/bounced/complained + reputation signals. SES delivers these
  via TWO paths (SNS event destinations AND EventBridge reputation rules); a neutral contract
  normalizes both into one event shape (cf. engine's `EmailEvent`).
- **Reputation / enforcement** — sending pause, suppression, trust tiers. Heavily SES-coupled today
  (`setReputationPolicy`, reputation entities); decide what is neutral vs SES-only.

Each provider declares `capabilities` so callers degrade gracefully (engine precedent).

## What is genuinely SES-coupled and STAYS behind the SES impl (not neutral)

Enumerate honestly so the neutral contract doesn't leak AWS:
- v1 receipt rules for inbound (README: *"`ses:*ReceiptRule*` has no v2 equivalent"*).
- The S3 inbound bucket + `inbound/` prefix + 7-day lifecycle retention.
- SNS topic-per-region + EventBridge connection/API-destination/rule wiring.
- The single-AWS-account fleet model + `hogsend-cloud-relay` IAM identity.
- `docs/ses-production-access-request.md` IAM policy coupling.

These are not failures to abstract; they are the SES impl's private business.

## Build decisions (locked for this trimmed wave)

- **Location: `apps/cloud/src/relay/` (co-located, no package).** Same lesson as PRD 01 — do not
  create a package boundary before the logical seam is proven across more than send+events. Extraction
  to `packages/cloud-relay*` is explicitly OUT of this wave.
- **Reuse existing neutral shapes; invent the minimum.** `RelayEvent` = the existing
  `NormalizedSesEvent` (already neutral: `{ event: HogsendRelayEmailEvent, tenantName,
  configurationSetName, dedupeKey }`) — do NOT redeclare it. Send input reuses the already-portable
  `SesMessage` + routing (`tenantName`, `configurationSetName`); the ONLY new neutral type is the
  send RESULT: `RelaySendResult = { id: string }` (renaming SES's `{ messageId }`) and the batch
  equivalent. `tenantName`/`configurationSetName` are accepted as the SES impl's routing inputs — the
  trimmed scope does NOT abstract routing (that would chase the full-neutrality rabbit hole #4 closed).
- **`RelayProvider` contract** (`src/relay/contract.ts`): `{ meta: { id, region }, send(input) →
  RelaySendResult, sendBatch(input) → RelayBatchResult, normalizeEvent(payload) → RelayEvent | null }`.
  Only the relay's real needs — 2 send verbs + event normalization — never SES's other 18.
- **`SesRelayProvider`** (`src/relay/ses/ses-relay-provider.ts`): wraps a `SesClient`; `send` calls
  `ses.sendEmail` and maps `{ messageId } → { id }`; `sendBatch` maps the per-entry results;
  `normalizeEvent` DELEGATES to `normalizeSesNotification` (no reimplementation). **It NEVER catches or
  wraps errors** — a `SesError` from the underlying client propagates verbatim so
  `sendFailureResponse` still classifies it (paused→403, retryable→503, invalid→400, else 502).
- **`getRelay(region)`** (`src/relay/index.ts`): `new SesRelayProvider(getSesClient(region))`, cached
  per region mirroring `getSesClient`; plus test helpers `getFakeRelay(region)` / `resetRelays()` that
  reuse `getFakeSesClient` — no separate fake relay is authored (the Fake comes free from wrapping
  `FakeSesClient`).
- **Dependency narrowing, not pipeline change.** `handleRelaySend`/`handleRelaySendBatch` take the
  relay via `RelayDeps` (`relay?: RelayProvider`, falling back to `getRelay(caller.region)`) and call
  `relay.send`/`relay.sendBatch` at the exact point they call `ses.sendEmail`/`sendBatch` today. Every
  surrounding step (idempotency, pause, tier-cap, allowance, rate-limit, attachments, metering) and
  the response mapping stay byte-identical. `email-event-ingress` routes normalization through
  `relay.normalizeEvent` (or a `getRelay(region).normalizeEvent`), producing the same
  `NormalizedSesEvent` fed to `ingestSesEvent`.
- **Test seam migration.** The send/batch tests currently inject `deps.ses` (a fake SesClient). They
  move to inject `deps.relay` (a fake relay via `getFakeRelay`, or a hand-built RelayProvider), OR
  `RelayDeps` keeps `ses` working by deriving the relay from it. Preserve every existing assertion.

## What stays SES-private (NOT abstracted this wave)

Per the trimmed scope: sending domains/identities, inbound spool (S3 + v1 receipt rules + SNS),
reputation/enforcement (EventBridge + reputation entities), the single-AWS-account fleet model. These
keep reaching into `ses/`/services directly. Only send + deliverability-events go through the seam.

## EARS acceptance criteria

- WHEN `handleRelaySend` / `handleRelaySendBatch` process any request the existing suite sends, the
  system SHALL return byte-identical responses (same status codes, same `{ id }` / `results[]`, same
  error mapping) as before — proven by `email-relay-send`, `email-relay-batch`,
  `email-relay-attachments` passing unchanged in assertion.
- WHEN the send handler needs a relay, the system SHALL depend on `RelayProvider` (2 verbs), NOT the
  20-verb `SesClient`, and a `SesError` from the underlying client SHALL propagate through the adapter
  unchanged so `sendFailureResponse` classifies it identically.
- WHEN `SesRelayProvider.send` succeeds, the system SHALL return `{ id }` equal to the underlying
  `sendEmail`'s `messageId`.
- WHEN `handleSesEventNotification` normalizes an SNS notification through the relay, the system SHALL
  produce a `NormalizedSesEvent` identical to today's `normalizeSesNotification` output (same event,
  tenantName, configurationSetName, dedupeKey) — proven by `ses-event-normalize` +
  `email-event-ingress` passing unchanged.
- WHEN `getRelay(region)` is called for an unmapped region, the system SHALL throw exactly as
  `getSesClient` does today (no silent fake mint).
- WHEN `pnpm --filter @hogsend/cloud check-types` / `test` / `build` run, the system SHALL pass.

## Task breakdown

- **T1 — Introduce the `RelayProvider` contract + `SesRelayProvider` + `getRelay`.** New
  `src/relay/{contract.ts,ses/ses-relay-provider.ts,index.ts}`. Reuse `NormalizedSesEvent` and
  `SesMessage`; add only `RelaySendResult`/`RelayBatchResult`. Adapter wraps `SesClient` + delegates
  to `normalizeSesNotification`, errors propagate verbatim. Add a `relay-provider.test.ts` proving the
  adapter's send maps `messageId→id`, sendBatch maps per-entry, normalizeEvent equals the free
  function, and a `SesError` propagates. _Boundary:_ `apps/cloud`. _Depends:_ none.
- **T2 — Route the send handlers through the seam.** `handleRelaySend`/`handleRelaySendBatch` depend
  on `RelayDeps.relay ?? getRelay(caller.region)`; migrate the send/batch/attachment tests' injection.
  Preserve ordering, response shapes, and `SesError` mapping. _Boundary:_ `apps/cloud`. _Depends:_ T1.
  _Guard:_ `email-relay-send`, `email-relay-batch`, `email-relay-attachments` green with assertions
  intact.
- **T3 — Route event normalization through the seam.** `email-event-ingress` normalizes via the relay.
  Keep `normalizeSesNotification` as the SES impl's delegate (do NOT delete it — the provider calls
  it). _Boundary:_ `apps/cloud`. _Depends:_ T1. _Guard:_ `ses-event-normalize`, `email-event-ingress`
  green.

## Done when

All EARS criteria pass; full app gates green; the existing send + events suites pass with assertions
intact; `## Implementation Notes` filled; one commit per task. Package extraction remains OUT.

## Implementation Notes

**SHIPPED — trimmed further to SEND on evidence.** Two commits, all gates green, zero regression on
real deploys.

- **T1 (`f070d571`) — the seam, additive.** New `apps/cloud/src/relay/`: `RelayProvider` contract +
  `SesRelayProvider` adapter over the frozen `SesClient` + `getRelay(region)`. `send` renames
  `{ messageId } → { id }`; `sendBatch` passes the `{ results }` shape through verbatim; errors
  propagate (no catch) so `SesError` classification is untouched. `getRelay` holds **no cache of its
  own** — a reviewer simplification over the first cut, which had a second per-region cache that could
  drift from `getSesClient`; the stateless wrapper delegates all caching + region-resolution +
  cred-gating one layer down. New `relay-provider.test.ts` (5 tests) pins the `messageId→id` rename,
  batch pass-through, `SesError` propagation, and the unmapped-region throw. No existing file changed.
- **T2 (`f1545560`) — route the send path.** `handleRelaySend`/`handleRelaySendBatch` depend on
  `RelayProvider` (2 verbs) via `resolveRelay(deps, region)` — precedence: injected `relay`, else a
  `SesRelayProvider` wrapping an injected `ses` (so the ~40 existing tests that inject `{ ses: fake }`
  and inspect the fake's recorded calls need ZERO changes), else `getRelay(region)`. The load-bearing
  ordering (auth→pause→rate-limit→validate→attachments→tier-cap→allowance→idempotency→send→commit→
  meter) and the `SesError → sendFailureResponse` mapping are byte-identical. The 123-test send+events
  suite passes with assertions intact.

- **EVENTS — investigated, then LEFT as the pure function it already is (T3 reverted).** The first cut
  routed `email-event-ingress` through `getRelay(region).normalizeEvent`. Adversarial verify caught
  that this **constructs a SES client on the events path**, which previously ran client-free
  (normalization is a pure SNS-JSON transform) — introducing a throw in the exactly-one-credential
  misconfig where the path had none. Since the events side was ALREADY provider-neutral at the
  `normalizeSesNotification → HogsendRelayEmailEvent` boundary (the neutral `BounceClass`
  classification happens engine-side, not here), wrapping it in a client-holding provider added
  coupling + a failure mode for zero neutrality gain. So `normalizeEvent` was dropped from the
  contract and the ingress kept calling the pure `normalizeSesNotification` directly — **zero
  regression on the events path.** The RelayProvider seam is therefore cleanly the SEND wire (the
  operation genuinely over-coupled to the 20-verb client); deliverability-event neutrality remains
  where it already lived.

- **Out of scope, unchanged (as planned):** sending domains/identities, inbound spool, reputation/
  enforcement, the single-AWS-account fleet model, and any `packages/cloud-relay*` extraction.

**Follow-up available (not built):** if a second relay is ever added, `RelayProvider` is the place its
send verbs plug in; event normalization would become a per-provider concern at THAT point (a non-SES
provider's raw webhook differs), and could re-join the contract then — with the client-construction
smell designed out (e.g. a pure/static normalizer), rather than speculatively now.
