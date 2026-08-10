# PRD 01 — SES access and abuse policy

**Status:** `[ ]` · **Depends:** none · **Boundary:** `docs/`, `apps/cloud/src/env.ts`, no product code

## Goal

Get the AWS side legally and operationally ready to send on behalf of customers, and write the
policy that lets us cut a bad tenant off without argument. This is the long pole: it is calendar
time at AWS and judgment time with the user, not engineering time. **Start it on day one and let it
run in the background while 02–10 are built.**

Nothing downstream is blocked by this PRD. Everything downstream is blocked by it at LAUNCH.

## Locked decisions

- **One AWS account, SES Tenants for isolation.** Not account-per-tenant. Account-per-tenant means a
  separate production-access support ticket per customer, which does not scale and which AWS will
  reasonably question. SES Tenants exists precisely to make one account safe for this, and it
  handles Trust & Safety enforcement per tenant.
- **Two regions from the start:** `us-east-1` and `eu-west-1`, matching `SubstrateRegion`. Production
  access is per-region, so both requests go in together. Requesting only one and adding the other
  later means a second wait at exactly the wrong moment.
- **The AUP is enforceable, not decorative.** Every clause must map to something we can actually
  detect or a specific reason we can point at when disabling a tenant. A rule we cannot observe is
  noise that weakens the ones we can.
- **We ask for a modest initial quota and grow it.** A large opening ask invites scrutiny we do not
  need. The shared-pool reputation argument is stronger with a real ramp story.

## Acceptance criteria (EARS)

- WHEN the production-access request is submitted, the system SHALL have documented, in the request
  itself: the multi-tenant model, that tenants are gated behind a paid product with no public email
  signup, the per-tenant SES Tenants isolation, the reputation policy posture, the bounce/complaint
  circuit breakers from PRD 08, and the double-opt-in/consent posture the engine already enforces.
- WHEN a reader opens the Acceptable Use Policy, the system SHALL state prohibited use, the
  bounce and complaint thresholds at which sending is suspended, that suspension may be automatic,
  the appeals route, and the data-retention position on suppression lists.
- WHEN a tenant is disabled for abuse, the system SHALL be able to cite a specific numbered AUP
  clause as the reason.
- WHEN the ToS is read, the system SHALL make clear that Hogsend Email is a bundled Cloud feature,
  that we may suspend sending to protect aggregate deliverability, and that the customer warrants
  recipient consent.
- WHEN `apps/cloud` boots without AWS credentials configured, the system SHALL start normally with
  Hogsend Email inactive and log one clear line saying so, exactly as the engine does today for a
  missing `RESEND_API_KEY`.

## Tasks

1. **Decide and document the AWS account structure.** Which account, whether it is a dedicated
   member account under an org, the IAM role/policy the control plane assumes, and the minimum
   `sesv2` action set that policy needs. Write it into `DECISIONS.md §7` as resolved.
   _Boundary:_ `.claude/plans/hogsend-email/` · _Depends:_ none

2. **Draft the ESP production-access request.** A single document covering the criteria above,
   ready for the user to submit for both regions. Include the requested initial sending quota and
   the ramp plan.
   _Boundary:_ `docs/` · _Depends:_ task 1

3. **Draft the Acceptable Use Policy.** Numbered clauses, each mapping to a detectable signal or a
   named enforcement action. Cross-reference PRD 08's thresholds so the two never drift.
   _Boundary:_ `docs/` · _Depends:_ none

4. **Draft the ToS clause and the customer-facing suspension notice copy.** Plain, factual, no
   hedging. The suspension email a customer receives is part of this deliverable, not PRD 08's.
   _Boundary:_ `docs/` · _Depends:_ task 3

5. **Add the AWS env vars to `apps/cloud/src/env.ts` as optional**, with the inactive-when-absent
   posture and the single boot log line. This is the only code in this PRD.
   _Boundary:_ `apps/cloud` · _Depends:_ task 1

## Seams

- **AWS account creation and the production-access submission are the user's to perform.** We
  produce the exact request text; a human sends it and reports the outcome.
- **AUP and ToS copy require the user's approval** before they go anywhere public. Product and legal
  judgment, explicitly not ours to finalize.

## Done when

The request text and both policies exist and are approved by the user; the AWS account structure is
recorded as resolved in `DECISIONS.md §7`; `apps/cloud` boots cleanly with and without AWS creds and
the gates are green. Mark `[~]` until AWS grants production access, then `[x]`.

## Implementation Notes
</content>
