# PRD 10 — `posthog-distribution`

**Depends on:** 02 and 04 shipped and demonstrably stable. **Status:** `[~]` DEFERRED HARD.

Scoped, not fully specified. Outward-facing: **requires explicit approval before any
submission.**

## Goal

Put Hogsend where PostHog's users already are: a listing in PostHog's destinations/CDP
catalog, and a community-authored tutorial in PostHog's docs.

## Why this matters more than its position suggests

Every technical gap in this stack is worth approximately nothing until this one closes.
Discovering Hogsend currently requires already knowing Hogsend exists. PostHog's docs carry
high domain authority and accept community-authored tutorials, and their catalog is browsed
by exactly the audience this whole initiative targets.

It is sequenced last not because it is unimportant, but because it is a **public commitment
to stability**.

## Why it is deferred hard

The worst failure mode in this stack — the slow property-writeback oscillation PRD 03
guards against — is slow, hard to detect, and would surface as a mystery drip of unwanted
sends over days. Submitting to a public catalog before that guard is *proven in the field*
means inheriting a public support surface for it.

Dogfood first. Months, not weeks.

## Gating conditions (all must hold before this is popped)

1. PRD 03's loop guard has run in production against a real PostHog project without a
   single unexplained cohort-sourced join.
2. PRD 02's abort-on-partial-read invariant has survived at least one real upstream
   incident, or has been deliberately fault-injected against a real project.
3. Doug has explicitly approved the submission. It is outward-facing and irreversible in
   reputation terms.

## Scope when popped

- Catalog listing: the artifact PostHog's destinations catalog actually requires, which
  needs research at the time — their submission process changes.
- A community tutorial, in Doug's voice, subject to the copy register: every line a fact,
  deletion test, no marketing padding, "source-available (ELv2)" never "open source".
- Comparison content that ranks, targeting the search behaviour of someone who has PostHog
  and needs to send an email.

## Implementation Notes
