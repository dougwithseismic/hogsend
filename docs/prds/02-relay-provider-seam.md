# PRD 02 — RelayProvider seam for the SES email relay (PLAN ONLY — no code this run)

> **Status: design/scoping only.** The deliverable of this PRD *is this document*. No relay code
> moves until this is approved and promoted to its own build wave.

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

## Migration strategy (strangler, when built — NOT this run)

1. Define `RelayProvider` + `RelayEvent` types (new `src/relay/contract.ts`, or a package — TBD).
2. Implement `SesRelayProvider` wrapping existing `ses/` + `lib/email-relay.ts` machinery. No caller
   changes yet — pure adapter over what exists.
3. Route ONE caller cluster at a time (send → domains → events → inbound → reputation) through
   `RelayProvider` instead of reaching into `ses/`/`lib/email-relay` directly. Each cluster is its own
   PRD/task with its own gates. The `FakeSesClient` already gives deterministic tests at every step.
4. Only once every caller goes through the seam, consider physically extracting to
   `packages/cloud-relay` + `packages/cloud-relay-ses`. Package extraction is the LAST step, not the
   first — same lesson as PRD 01 (don't create a package boundary before the logical seam is proven).

## Decisions needed before a build wave (for the user / plan review)

1. **Inbound: neutral verb or capability flag?** (Leaning: capability flag — inbound is optional and
   deeply SES-shaped.)
2. **Reputation/enforcement: how much is neutral?** (Leaning: minimal neutral surface —
   `pauseSending`/`suppress` only; SES reputation entities stay private.)
3. **Package now or logical-seam-first?** (Strong recommendation: logical seam first, package last —
   PRD 01's evidence shows premature packaging adds machinery.)
4. **Is a second provider actually on the roadmap?** If no concrete second relay is planned, the seam
   is still worth it for *testability + boundary clarity*, but its scope should be trimmed to the
   send + events surface and NOT chase full neutrality of inbound/reputation. (Lean-first check.)

## EARS acceptance criteria (for THIS plan-only PRD)

- WHEN this PRD is reviewed, the system (doc) SHALL enumerate the neutral capability surface, the
  SES-coupled residue, the strangler migration order, and the open decisions above.
- WHEN approved, the system SHALL NOT contain any relay code changes attributable to this PRD (plan
  only); a follow-up wave carries the build.

## Task breakdown

- **T1 — (this run) Author + review this design.** Produce this doc; run it through the 0d plan-review
  panel; fold confirmed findings. _Boundary:_ `docs/`. _Depends:_ none.
- **T2..Tn — (future wave, NOT this run)** the strangler steps above, one caller-cluster per PRD.

## Done when

This document is reviewed and approved; the four decisions are surfaced to the user. No code.

## Implementation Notes

_(filled if/when promoted to a build wave)_
