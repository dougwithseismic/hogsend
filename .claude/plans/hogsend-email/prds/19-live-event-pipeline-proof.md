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

### Task 1 — the public endpoint is a `cloudflared` quick tunnel (decided 2026-08-11)

**Decided: tunnel, not a deploy.** `cloudflared` is already installed on the build machine and
`scripts/discord-tunnel.sh` is in-repo precedent for exactly this shape — a quick tunnel
(`cloudflared tunnel --url http://localhost:3004`) hands back a public `*.trycloudflare.com` HTTPS URL
with **no Cloudflare account, no token and no DNS record**. SNS will confirm an HTTPS subscription
against it like any other endpoint.

The alternative — deploying the control plane to Railway — was rejected because it reopens a gate this
wave deliberately closed. Promoting `CLOUD_AWS_ACCESS_KEY_ID`/`CLOUD_AWS_SECRET_ACCESS_KEY` to Railway
is the switch that makes the *hosted* control plane create real SES resources for every provisioning
run, and PRD 14's seam register holds that closed until the Fake is trusted. Proving the delivery path
must not require throwing that switch; a tunnel proves the same chain and reverts by pressing Ctrl-C.

Consequence to design around, not around which to design: **a quick-tunnel URL is ephemeral and
differs per run.** So the subscription is created by the proof script at the start of a run and
deleted at the end, rather than being standing infrastructure. That is why the relay grant below asks
for `sns:Subscribe`/`sns:Unsubscribe` rather than a topic Doug subscribes once by hand.

#### Correction: `cloudflared` quick tunnels DO NOT WORK here. Use `localhost.run`.

The decision above (tunnel, not deploy) stands. The specific tunnel does not — measured, not assumed:

- `cloudflared tunnel --url http://127.0.0.1:3004` registers a connection and prints a
  `*.trycloudflare.com` URL, and **every request to it returns 404 from Cloudflare's edge**:
  `server: cloudflare`, no origin headers, and Next never logs the request. 20 consecutive attempts
  over five minutes, across two separate tunnels. cloudflared's own metrics counter incremented with
  each request while the origin saw none, which is what rules out an origin-side cause. Cloudflare has
  been progressively restricting account-less quick tunnels and this is consistent with that.
- **`localhost.run` works, needs no account and no install** — it is plain SSH:

  ```bash
  ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:127.0.0.1:3004 nokey@localhost.run
  ```

  It prints `https://<random>.lhr.life`, TLS terminated. Verified end to end:
  `GET /api/health` → `200 {"status":"ok","db":"ok","migrations":"in_sync"}`, and the request
  appeared in the Next dev log, which is the check that the cloudflared attempt failed.

Operational note kept deliberately: **the tunnel is brought up for a run and closed after it.** It
publishes a dev control plane — auth, billing and CLI endpoints, under the publicly-known dev
encryption secret — through a third party at a guessable-only-by-luck hostname. That is an acceptable
cost for the minutes a proof takes and a silly one to leave running overnight.

`scripts/discord-tunnel.sh` remains the in-repo precedent for the SHAPE, but its `cloudflared`
dependency is now known-broken for this purpose; anything reaching for it should read this first.

### The account probe that reset the task list (2026-08-11)

Read against the real account before planning any of this, because the last four times a plan in this
wave met a primary source, the source won. Findings:

- **The relay credentials are live and the account is clean.** `ListTenants` returns `[]` in both
  `us-east-1` and `eu-west-1` — PRD 11's walkthrough tore down everything it created.
- **`ses:SendEmail` is already granted.** The two verbs that have never run are not blocked by
  permissions. This contradicted the working assumption that production access gated the send proof;
  it does not, and neither does IAM.
- **Nothing is verified in either region.** `GetEmailIdentity` (granted) was probed against eight
  candidate names — `hogsend.com`, `withseismic.com`, `doug@withseismic.com` and five others — and
  every one returned `NotFoundException`. So a live send needs an identity created first; there is no
  pre-existing one to borrow.
- **`ses:GetAccount` and `ses:ListEmailIdentities` are NOT granted**, which is why our own tooling
  cannot read the account's sandbox status or quota. Added to the relay grant below.

### THE SEND VERBS RAN. 2026-08-11, against real SES, first attempt, no divergences.

Doug clicked the verification link for `ses-proof@hogsend.com` and the identity went
`VerifiedForSendingStatus: true`. A send needs no SNS — SNS only carries the answer BACK — so the
biggest unknown in the wave was provable immediately rather than after the admin bootstrap. It was,
through our own `AwsSesClient` rather than the raw SDK, so what passed is our implementation:

| Step | Result |
| --- | --- |
| `createTenant` | `env-ses-walkthrough-probemsouehtq`, `ENABLED` |
| `createConfigurationSet` | ok |
| `associateResource` (config set) | ok |
| `associateResource` (identity) | ok |
| **`sendEmail`** → `success+…@simulator` | `0100019ff189d429-e4511161-032f-4588-82f8-53f2b862e736-000000` |
| **`sendEmail`** → `bounce+…@simulator` | `0100019ff189d551-4389c2fb-ad91-404d-95de-e7f3ddb5898c-000000` |
| **`sendBatch`** (2 messages) | both `sent` |
| **`sendEmail` + attachment** | `0100019ff189d863-b0ad19ed-bc3f-4027-b4ad-4e0621a8a92b-000000` |
| teardown (disassociate, delete ×2) | ok |

11/11. The tenant prefix was the walkthrough's, so a crash would have been sweepable; nothing was
left behind.

Three things this settles and one it does not:

- **`sendEmail` and `sendBatch` work** — PRD 11 could not prove them and the whole wave rested on
  them. Zero divergences from `FakeSesClient` on either, which is the first time a live run in this
  wave found none (PRD 11's found ten).
- **Tenant-scoped sending works end to end** — tenant, configuration set, and both resource
  associations, which is the isolation guarantee DECISIONS §3.2 rests on.
- **SES accepts our attachments** — PRD 17 shipped on the strength of AWS's docs and the SDK types
  and had never put a byte on the wire.
- **It does NOT prove the attachment bytes are CORRECT.** Acceptance is not integrity, and the
  failure mode `ses/types.ts` warns about is precisely one that still sends successfully: content
  that is already base64 gets encoded a second time and delivers a corrupt file with no error at any
  layer. A simulator address cannot answer this. The only test that can is a real inbox, opened by a
  human. **Owed, and not yet done.**

### `scripts/aws-bootstrap-events.sh` — the admin-credentialed step, scripted

The relay user cannot create an SNS topic and cannot widen its own policy. Correct posture, and also
the reason the event pipeline has never run. Rather than a six-journey console runbook, the whole
admin step is one idempotent script: two SNS topics, a `SourceAccount`-scoped publish policy on each,
and one additive inline grant on the relay user.

Two choices inside it worth stating:

- **The topic policy is scoped by `AWS:SourceAccount`.** Unscoped, the policy reads "any SES account
  anywhere may publish here", and anyone who learned the ARN could inject bounce events into a
  pipeline that our ingress trusts to mark sends permanently failed and to suppress recipients.
- **The relay grant is a separately-named INLINE policy, not a new version of `HogsendEmailRelay`.**
  That managed policy is quoted verbatim in `docs/ses-production-access-request.md` as the artefact AWS
  is being asked to review; a script that rewrote it would silently invalidate the document. Additive
  and separately named is reversible with one delete and reads honestly in the console.

It refuses when run with the relay credentials rather than failing three times with an `AccessDenied`
that reads like a script bug — verified by running it that way.

