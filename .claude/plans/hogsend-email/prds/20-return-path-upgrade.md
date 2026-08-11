# PRD 20 — The branded return path, as a one-click upgrade

**Status:** `[ ]` · **Depends:** 07, 15 · **Boundary:** `packages/core`, `packages/engine`, `packages/studio`, `packages/cli`

## Goal

Let a customer switch on the branded return path from Setup, and tell them what it buys.

## The decision this implements (Doug, 2026-08-11)

PRD 15 left one open question: should the branded return path be ON by default? **Answer: no. Keep it
off, and surface it in Setup as a labelled upgrade.**

The reasoning, recorded so nobody reopens it:

- **One DNS record is the wedge.** Resend makes everyone publish three. Our default is one TXT and the
  domain sends. That is the single concrete thing we can point at, and turning this on by default
  would erase it.
- **It is reversible with no downtime.** `BehaviorOnMxFailure: USE_DEFAULT_VALUE` (DECISIONS §2) means
  switching it on later cannot break a customer's mail, so there is no cost to deferring the choice.
- **Every extra DNS record loses people in setup.** Three records is three chances to give up.

And the original reason for wanting it on by default does not hold. **The branded return path does not
deliver replies.** Replies route on the `From`/`Reply-To` domain and land in the customer's ordinary
mailbox; they work today with nothing configured. The return path carries BOUNCES, which SES already
collects for us. Inbound is PRD 16 and is a different feature entirely.

What it actually buys, and therefore what the UI must say:

- Gmail stops showing **"via amazonses.com"** under the sender name.
- SPF aligns with the customer's own domain, so DMARC passes on SPF as well as DKIM.

## The gap

`apps/cloud` already implements it — `setReturnPath` on the domains service, `POST
/api/email/domains/return-path`, MX + SPF record derivation, and a chooseable label (PRD 15). And
`packages/plugin-hogsend` exposes `setReturnPath` on its own `HogsendDomainsCapability`.

**Nothing above that can reach it.** `DomainsCapability` in `@hogsend/core` has four methods and none
of them is this one, the engine's admin domain router has no return-path endpoint, and Studio has no
UI. The capability exists and is unreachable from the product.

## Locked decisions

- **`setReturnPath` goes on the core `DomainsCapability` as OPTIONAL**, not as a Hogsend-specific
  extra. A custom MAIL FROM is a standard ESP concept, not something we invented. Optional means a
  provider that cannot do it omits the method, and the engine answers 501 exactly as it already does
  when `provider.domains` is absent — the pattern is already in `routes/admin/domain.ts`, follow it
  rather than inventing a second one.
- **Off stays the default, in code and in UI.** The toggle starts off. No pre-checked box, no
  "recommended" styling that reads as a warning for not doing it.
- **The UI states the benefit in the customer's terms, not ours.** "Removes 'via amazonses.com' in
  Gmail" beats "aligns the MAIL FROM domain". The mechanism goes in a second line for the people who
  want it.
- **The UI states the cost in the same breath.** Two more DNS records. A customer who clicks and then
  discovers more DNS work has been mis-sold.
- **It must NOT claim to enable replies.** That is the exact misunderstanding this PRD exists to
  correct. If any copy anywhere implies replies, it is a bug.
- **Turning it OFF must be as reachable as turning it on.** A one-way door in a DNS-affecting setting
  is how customers end up stuck.
- **The label is choosable but not prominent.** PRD 15 shipped `notifications`/`mail`/`updates`
  validation. Default `send`, with the label behind a disclosure rather than in the main flow.

## Acceptance criteria (EARS)

- WHEN the active provider's domains capability has no `setReturnPath`, the system SHALL report the
  upgrade as unavailable and SHALL NOT render a dead control.
- WHEN a customer switches the branded return path on, the system SHALL return the two new records
  (MX + SPF) as `pending` and SHALL display them alongside the existing DKIM record.
- WHEN a customer switches it off, the system SHALL revert to SES's default return path and SHALL stop
  reporting the MX and SPF records.
- WHEN the return path is off, the domain SHALL still report as fully verified on its one TXT record.
  Not having the upgrade is not a warning state.
- WHEN the UI describes the upgrade, it SHALL state both the benefit and the two-extra-records cost,
  and SHALL NOT mention replies.
- WHEN a customer supplies a return-path label, the system SHALL validate it with the rule PRD 15
  already ships and SHALL surface a rejection naming the offending label.

## Tasks

1. **`setReturnPath?` on `DomainsCapability`** in `@hogsend/core`, with the neutral result shape.
   _Boundary:_ `packages/core` · _Depends:_ none
2. **`plugin-hogsend` implements the core method**, replacing (or delegating from) its bespoke one so
   there is one surface rather than two.
   _Boundary:_ `packages/plugin-hogsend` · _Depends:_ task 1
3. **Engine admin route** `POST /v1/admin/domain/return-path`, 501 when unsupported, following the
   existing router's error idiom exactly.
   _Boundary:_ `packages/engine` · _Depends:_ task 1
4. **Studio Setup UI** — the toggle, the benefit/cost copy, the two records rendered on enable, the
   label behind a disclosure. Type the wire field OPTIONAL (PRD 15's skew lesson: Studio ships in the
   CLI tarball and talks to a separately-upgraded engine).
   _Boundary:_ `packages/studio` · _Depends:_ task 3
5. **`hogsend domain return-path on|off [--label]`** so the CLI is not a second-class surface.
   _Boundary:_ `packages/cli` · _Depends:_ task 3
6. **Tests**, including the 501 path, the off-is-not-a-warning assertion, and a copy assertion that
   the word "repl" appears nowhere in the upgrade text.
   _Boundary:_ all touched · _Depends:_ tasks 1-5

## Seams

- None. Everything underneath exists and is tested against the Fake.

## Done when

A customer can turn the branded return path on and off from Setup and from the CLI, sees the two
records when it is on, is told what it buys and what it costs, is never told it enables replies, and
gates are green.

## Implementation Notes
