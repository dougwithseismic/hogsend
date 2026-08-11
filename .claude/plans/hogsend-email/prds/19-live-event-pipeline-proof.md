# PRD 19 — Prove the delivery path against real AWS

**Status:** `[ ]` · **Depends:** 11, 14, 18 · **Boundary:** `apps/cloud`

## Goal

Send a real message through real SES and watch a real bounce come back through the whole pipeline.

PRD 11 proved 17 of 19 verbs against AWS. The two it could not prove are `sendEmail` and `sendBatch`
— **the only two that actually deliver mail** — plus `putEventDestination`, which is what carries the
answer back. So today: everything around delivery is verified, and delivery is an assumption.

## The unlock: SES's mailbox simulator

This was previously thought to need a human clicking a verification link. It does not. From AWS's
*Sending test emails in Amazon SES with the simulator*:

> "You can use the mailbox simulator **even if your account is in the Amazon SES sandbox**."

> "Emails that you send to the mailbox simulator … don't affect your daily sending quota" and "don't
> impact your email deliverability or reputation metrics."

| Scenario | Address |
| --- | --- |
| Delivery | `success@simulator.amazonses.com` |
| Bounce (hard, NOT added to the suppression list) | `bounce@simulator.amazonses.com` |
| Complaint | `complaint@simulator.amazonses.com` |
| Auto-response / OOTO | `ooto@simulator.amazonses.com` |
| Suppression-list hard bounce | `suppressionlist@simulator.amazonses.com` |

Two details that make this genuinely good rather than merely possible:

- **Labelling works** — `bounce+<sendId>@simulator.amazonses.com`. So a specific send can be
  correlated to the specific event it produced, which is exactly what the ingress path claims to do
  and has never been tested doing.
- **Reputation is untouched**, so this can be run repeatedly without the cost that normally makes
  live bounce testing unwise.

**Reject has no simulator address.** AWS's documented method is an EICAR antivirus test file
(`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`) attached to a message sent
to a verified address. That makes **PRD 17 (attachments) a hard prerequisite for proving PRD 18
(Reject) live** — there is no way to attach the file without it. Note also that rejected messages DO
count against the quota and ARE billed, unlike simulator sends.

## What still needs solving, and it is the real work

**SNS must reach the control plane, which means a public HTTPS endpoint.** That is the actual blocker
and the reason this is its own PRD rather than a flag on PRD 11:

- A local run has no public URL. `scripts/discord-tunnel.sh` already exists in this repo and is
  precedent for a tunnel-based local path — read it before inventing another.
- The alternative is a deployed control plane, which reintroduces the Railway gate that is
  deliberately closed until the Fake is trusted and production access lands.

Decide which, and record why. Do not build both.

## Locked decisions

- **Simulator addresses only. Never a real human's inbox.** A test that emails a person is a test
  nobody runs twice.
- **This is a script in the same family as the walkthrough**, not a CI job and not a vitest file. Same
  refusal posture: explicit flag, both credentials, no accidental runs.
- **Run it sparingly.** PRD 11's operational warning applies with full force — repeated bursts of
  send activity from a young account is precisely the shape that already drew an AWS account-review
  case (`178644276900210`). This is a proof, not a loop.
- **Assert the WHOLE path, not the send call.** Message accepted → SES event → SNS → control plane →
  signed hop → instance webhook → normalized `EmailEvent` → `email_sends` terminal status. A test
  that only asserts "sendEmail returned an id" proves the least interesting link.
- **The bounce must NOT suppress**, because the simulator's bounce address is documented as not being
  added to the suppression list. If our pipeline suppresses it anyway, that is a real finding about
  our own suppression logic.

## Acceptance criteria (EARS)

- WHEN the proof script runs without explicit credentials and confirmation, it SHALL refuse, exactly
  as the walkthrough does.
- WHEN it sends to `success@simulator.amazonses.com`, the system SHALL receive a `Delivery` event and
  the corresponding `email_sends` row SHALL reach a delivered terminal status.
- WHEN it sends to `bounce@simulator.amazonses.com`, the system SHALL receive a `Bounce` event,
  classify it `permanent`, and reach a bounced terminal status.
- WHEN it sends to `complaint@simulator.amazonses.com`, the system SHALL receive a `Complaint` event
  and reach a complained terminal status.
- WHEN a labelled address is used, the system SHALL correlate the event to the originating send.
- WHEN the run completes, it SHALL report which links of the chain were exercised and which were not,
  rather than a bare pass.

## Tasks

1. **Decide the public-endpoint approach** (tunnel vs deployed) and record the reasoning.
   _Boundary:_ none · _Depends:_ none
2. **A verified sending identity on a domain we control.** `hogsend.com` is on Cloudflare and
   reachable through its API, so publishing the BYODKIM TXT record is self-serviceable.
   _Boundary:_ `apps/cloud` · _Depends:_ none
3. **SNS topic + subscription + `putEventDestination`** — the verb PRD 11 skipped. The relay policy
   grants no `sns:` actions; that is an external ask.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 1, 2
4. **The proof script**: send to each simulator address, wait for the event, assert the chain.
   _Boundary:_ `apps/cloud` · _Depends:_ task 3
5. **EICAR/Reject leg** — only after PRD 17 ships attachments.
   _Boundary:_ `apps/cloud` · _Depends:_ PRD 17

## Seams

- `sns:` actions on the relay IAM policy, plus a topic. Both need the account owner.
- Production access is NOT required for any of this. Sandbox is enough, which is the whole point.

## Done when

A real bounce from the SES simulator travels the entire path into a terminal `email_sends` status,
and the report names every link it exercised.

## Implementation Notes
