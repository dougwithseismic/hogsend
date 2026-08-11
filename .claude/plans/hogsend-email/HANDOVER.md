# Hogsend Email — handover

**As of 2026-08-11, end of day.** Branch `feat/hogsend-email`, 105 commits ahead of `main`, nothing
pushed. Read [BACKLOG.md](BACKLOG.md) for the queue and [DECISIONS.md](DECISIONS.md) for the settled
architecture; this file is for picking the work back up.

---

## The one-paragraph version

Hogsend Email works. A real message leaves our relay, goes through real SES, and the delivery,
bounce and complaint events travel all the way back through SNS into a signed webhook hop. That was
proven end to end against AWS today, not asserted. **20 of 23 PRDs are done.** The only thing between
here and a paying customer is **SES production access, which has not been submitted** — until it is,
the account is capped at 200 emails a day to addresses we have verified ourselves, which serves
nobody.

---

## Start here tomorrow

In priority order. The first item is worth more than the rest combined.

1. **Submit SES production access for `us-east-1` AND `eu-west-1`.** Text is ready in
   `docs/ses-production-access-request.md`. ~20 minutes, and it starts a 24–48h clock that nothing
   else can start. It makes representations about the business, so it is Doug's to send.
2. **Decide the inbound S3 bucket's three settings** (below) — blocks PRD 16 task 4 going live.
3. **Resume PRD 16 at task 5** — task 4 (the receive endpoint) LANDED, `76988c7d`. Tasks 5
   (`email.replied` on the engine spine) and 6 (forwarding to the human address) remain, and 6 is
   the one the PRD calls mandatory: intercepting a reply and emitting only an event breaks a
   customer's business to gain a feature.
4. **Approve AUP + ToS copy** and **confirm the trust-tier constants** (PRD 08 §, published in AUP §5,
   so the two move together).

---

## What is PROVEN, and what is merely green

The distinction this whole wave was built on. Do not blur it.

### Proven against real AWS

| Thing | Evidence |
| --- | --- |
| `sendEmail`, `sendBatch`, tenant-scoped sending, attachments | 11/11 steps, zero Fake divergences, clean teardown |
| The full event pipeline | 12 links, 0 failed, 0 findings, 0 resources left behind |
| `putEventDestination` | ran for the first time in the PRD 19 proof |
| The 19-verb SES contract | **22 verbs compared, 0 divergences**, twice-run |
| One-record DKIM (the wedge vs Resend's three) | confirmed on three separate live runs |
| 4 inbound Fake behaviours | probed directly; one was wrong and is fixed |
| 500 recipients per receipt rule | probed; AWS's console docs say 100 and are wrong |

### Green but NOT proven

- **Nothing has run on Railway with real AWS credentials.** The pipeline was proven locally through a
  tunnel. The deployed path is the same code in an unproven environment.
- **The chain was proven up to a real engine, not through one.** The final leg — engine
  `handleWebhook` → `email_sends` terminal status — is honestly reported as `NOT exercised`, because
  the proof's stub verifies the signature with the plugin's own verifier but is not an engine.
- **Bounce classification as `permanent`** is asserted nowhere; it lives in the unexercised leg.
- **Attachment BYTES.** SES accepted an attached file and returned a message id. Acceptance is not
  integrity: already-base64 content encoded a second time delivers a corrupt file and succeeds at
  every layer. Only a human opening one can settle it.
- **The inbound seam** has 2 remaining UNVERIFIED behaviours, both marked in code and in the test
  names.

---

## Runbooks

All of these need `apps/cloud/.env.local` (gitignored, holds the relay credentials and the topic
ARNs). None of them are in CI; all are deliberately human-run.

### Walk the whole SES contract against real AWS

```bash
cd apps/cloud
set -a && . ./.env.local && set +a
pnpm exec tsx scripts/ses-walkthrough.ts --i-know-this-hits-aws \
  --send-from ses-proof@hogsend.com --send-to success@simulator.amazonses.com
```

Last run: 22 verbs, 0 divergences, 0 resources left behind.

**Do not use `pnpm --filter … ses:walkthrough --`** — pnpm forwards the literal `--` into argv and the
parser refuses it. The delivery-proof script fixed this in its own parser; the walkthrough has not
(PRD 21 task 5).

### Prove the delivery pipeline end to end

Three terminals' worth, in order:

```bash
# 1. control plane
pnpm --filter @hogsend/cloud dev            # :3004

# 2. public tunnel — cloudflared is BROKEN for this (see Lessons), use:
ssh -R 80:127.0.0.1:3004 nokey@localhost.run   # prints https://<random>.lhr.life

# 3. the proof
cd apps/cloud && set -a && . ./.env.local && set +a
pnpm exec tsx scripts/ses-delivery-proof.ts --i-know-this-hits-aws \
  --public-url https://<random>.lhr.life --send-from ses-proof@hogsend.com
```

Last run: 12 links exercised, 2 not exercised **by design and named**, 0 failed.

**Close the tunnel afterwards.** It publishes a dev control plane — auth, billing and CLI endpoints,
under the publicly-known dev encryption secret — through a third party.

### The admin AWS step (already run, idempotent)

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
aws configure                                     # ADMIN, not the relay user
DRY_RUN=1 apps/cloud/scripts/aws-bootstrap-events.sh
apps/cloud/scripts/aws-bootstrap-events.sh
```

Creates the SNS topics, their `SourceAccount`-scoped publish policies, and the relay's additive inline
grant (now including the inbound receipt-rule verbs). It refuses if run with the relay credentials.
It deliberately does **not** create the inbound S3 bucket or inbound topic.

### Account state

```bash
aws sesv2 get-account --query \
  '{prod:ProductionAccessEnabled,sending:SendingEnabled,max24h:SendQuota.Max24HourSend}'
```

Currently: `prod=false`, sending enabled, 200/day, 1/sec. **That is the launch gate.**

---

## The inbound S3 bucket — three decisions, not engineering

PRD 16 task 4 cannot run live without it, and SES resolves the bucket at rule-creation time
(`InvalidS3ConfigurationException: No such bucket`), so it must exist before any receipt rule names it.

It holds **customers' inbound mail**, which makes three of its settings product calls:

1. **Retention.** How long do we keep replies? Recommendation: **30 days** — long enough to debug and
   re-drive, short enough not to become a liability. One lifecycle rule.
2. **Encryption.** SSE-S3 by default, or KMS for per-key auditability at a small cost.
3. **Region.** One bucket serves all regions (AWS's documented exception to its same-region rule), so
   EU and US customer mail would share a location. That may matter for a data-residency answer later.

Everything else about it is settled: public access blocked, and an SES-facing policy scoped by BOTH
`AWS:SourceAccount` and the receipt-rule `AWS:SourceArn` — written out verbatim in a comment in
`aws-bootstrap-events.sh`, tighter than the events topic's SourceAccount-only standard.

---

## Lessons that cost real time today

Recorded so they are not re-learned. Every one of these was found by checking a primary source or
running the thing, against a plan that said otherwise.

- **`cloudflared` quick tunnels DO NOT WORK.** 20 consecutive requests, two tunnels, all 404 from
  Cloudflare's edge with no origin headers, while cloudflared's own counter incremented and the origin
  logged nothing. Use `localhost.run` (plain SSH, no account).
- **The docs are not the service.** Five plans were changed by reading AWS's own material, and twice
  the docs were themselves wrong: `AlreadyExistsException` is documented for duplicate tenant-resource
  association and **does not fire** (AWS returns 200); `DeleteReceiptRuleSet` on a missing set is
  documented as if it refuses and **succeeds**; the console walkthrough says 100 recipients per rule
  and the real ceiling is **500**.
- **A divergence report names the two things that disagree, not which is wrong.** PRD 21's first
  diagnosis blamed the Fake for a bug that was in the probe. The correction is in that PRD.
- **A red link is a claim about the observation too.** The delivery proof's first run reported the
  complaint leg failed; the arithmetic in its own report (4 messages sent, 5 signed deliveries
  received) showed the pipeline was right and the observation was wrong.
- **Mutate every assertion.** Before it was fixed, the delivery proof's exit-code mapping — the single
  gate against a false pass — survived being mutated to always return zero, against 36 passing tests.
- **`skipLibCheck` cannot protect a consumer from a package that ships `.ts`.** That is the root of
  issue #657.

---

## Open bugs

- **[#657](https://github.com/dougwithseismic/hogsend/issues/657)** — a fresh
  `pnpm dlx create-hogsend@latest` app fails `pnpm check-types` with 33 errors, all inside
  `@hogsend/engine`. The app builds and runs; only the script fails. **Eight hypotheses falsified and
  listed in the issue — start from that frontier, not the beginning.** A live failing reproduction is
  at `/tmp/hogsend-real-customer.*/customer-app`.
- **Two known flakes.** `publish-cli-auth.test.ts > refuses a REVOKED session` (security reading ruled
  out; cause unknown). `ops-stats.test.ts > readOpsStats` — **mechanism diagnosed**: it asserts GLOBAL
  fleet counts against a database the rest of the suite seeds concurrently. Fix is to scope the
  assertion to rows it owns, not to retry it.

---

## Suite totals

`cloud 1662 · engine 162 · cli 380 · studio 16 · core + plugins green · check-types 53/53 · build green`

## The dependency sweep — `chore/dep-refresh`

A separate branch off `main`, deliberately NOT mixed into the email wave: a breakage there must not be
ambiguous with work proven against real AWS. **12 commits, clean tree, nothing pushed.**

Applied, each its own gated commit: in-range minors/patches · `@types/node` unified on 26.2.0 ·
`jsdom` 26→30 · `lucide-react` 0.474→1.31 · `vite` 6→8 with `@vitejs/plugin-react` 4→6 ·
`motion` 12→13 · `ioredis` 5→6 · **`postmark` 4→5** · `ai` 6→7 · `openai` 6→7 · both deprecated
packages resolved · exact-pinned stragglers.

**TypeScript stayed on 5.9.2** — there is no 5.9.2→7.0.2 commit. That was an authorised outcome
(reverting it with a clear reason beats forcing it green by weakening something), but **the reason is
not yet recorded** — the agent had not reported when the session ended. Get that before anyone retries
it.

Two things to check before trusting this branch:

- **`postmark` 4→5 is a live email provider customers send through.** A behaviour change there is a
  product risk our suite cannot see, since every test runs against a fake. Read the changelog against
  `packages/plugin-postmark` before merging.
- **Independent verification.** Its gate results were self-reported and I did not re-run them. Do that
  before merging, the same way every other claim in this wave was re-checked.

Unrelated but worth knowing: **`packages/brand-media` is already on `typescript@^7.0.2` on `main`**, so
TS 7 is in use in one corner of the repo and works there. That predates the sweep. It also means
#657's "TS 7 changes nothing" result is about the ENGINE's source, not about TS 7 being unusable here.

---

## Doug's list

| | Ask | Why it matters |
| --- | --- | --- |
| 1 | **Submit SES production access, both regions** | The launch gate. Nothing else starts this clock. |
| 2 | Decide the inbound bucket's retention / encryption / region | Blocks inbound going live. NOTE: the control plane now also stores a reply's `subject` and `from_address` as routing metadata — a pointer to S3, never a body — so the retention answer covers two stores, not one. |
| 3 | Approve AUP + ToS copy | Published to customers |
| 4 | Confirm trust-tier + suspension constants | Already in AUP §5; the two move together |
| 5 | Cloudflare API token, hogsend.com zone, `Zone → DNS → Edit` + zone id | Closes PRD 15's DNS half |
| 6 | Yes/no on one attachment test to a real inbox | Only way to prove attachment integrity |
| 7 | Delete `~/Downloads/hogsend-cloud-relay_accessKeys.csv`; MFA the root user | `aws configure` currently holds ROOT credentials |
