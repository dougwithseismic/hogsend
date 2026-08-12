# PRD 10 — Env preset and consumer wiring

**Status:** `[ ]` · **Depends:** 04, 06 · **Boundary:** `packages/engine`, `packages/create-hogsend`, `apps/docs`

## Goal

The last mile. A freshly provisioned Cloud instance boots, finds its Hogsend Email credentials in
the environment, registers the provider, and sends. No `RESEND_API_KEY`, no manual wiring, no
consumer code change.

## Locked decisions

- **`@hogsend/plugin-hogsend` is an OPT-IN package**, loaded exactly like `plugin-postmark`: an
  engine `optionalDependency` behind a guarded dynamic import with a **runtime-assembled specifier**.
  The specifier must not be a string literal. A literal makes `tsc` resolve the module's types and
  fail with TS2307 for every consumer that does not have the package installed, including a fresh
  `create-hogsend` app. This is documented at length in `email-providers-from-env.ts` and the reason
  is easy to forget.
- **Gated on `HOGSEND_EMAIL_TOKEN`.** Present means build the preset. Absent means the package is
  never imported, so a self-hosted deploy that will never use it never touches it.
- **The preset does not change the active provider by itself.** `EMAIL_PROVIDER=hogsend` selects it,
  exactly as Postmark works. The Cloud provisioner sets both, so Cloud gets it by default while
  self-hosted defaults are untouched.
- **Load failure warns, it does not silently fall back.** The bare `catch {}` that swallowed a
  Postmark load failure was a real bug: the container still threw its "not registered" error, with
  nothing in the logs explaining why. `loadOptionalPlugin` already handles this; use it.
- **Any runtime dependency the plugin adds must be mirrored into the `create-hogsend` template
  `_package.json`**, or a fresh scaffold breaks at boot. This has bitten the repo before.
- **Docs describe it as a Cloud feature.** No pricing page, no public signup, no "email API" framing.
  DECISIONS §1.
- **The engine MUST thread its replay-stable idempotency key to the provider**, as an
  `Idempotency-Key` entry in `SendEmailOptions.headers`. Added 2026-08-10 after PRD 04's review, and
  it is load-bearing rather than a nicety.

  The engine's tracked mailer already computes a replay-stable key (run id + nearest wait label +
  template key). If it does not hand that key to the provider, the provider falls back to hashing
  the message bytes, and that fallback **cannot do the job**: `prepareTrackedHtml` mints fresh
  `tracked_links` ids and an open pixel carrying the send id on every attempt, so a crash re-drive of
  the SAME logical send produces different HTML, a different hash, and no replay protection at all.
  A journey replayed after a worker crash would send twice.

  The relay's guard is only as good as the key it is given, so this wiring is what makes PRD 03's
  exactly-once real for engine sends. Add a test that asserts the key reaches the provider; without
  one, this regresses invisibly.

## Acceptance criteria (EARS)

- WHEN `HOGSEND_EMAIL_TOKEN` is set and the package resolves, the system SHALL register a provider
  with id `hogsend` in the container's `EmailProviderRegistry`.
- WHEN `HOGSEND_EMAIL_TOKEN` is unset, the system SHALL NOT import `@hogsend/plugin-hogsend` at all.
- WHEN `HOGSEND_EMAIL_TOKEN` is set but the package fails to resolve, the system SHALL warn with a
  message naming the package and the enabling variable, and SHALL NOT silently continue as if
  nothing happened.
- WHEN `EMAIL_PROVIDER=hogsend` and the provider is registered, the system SHALL resolve it as the
  active provider and the tracked mailer SHALL send through it.
- WHEN `EMAIL_PROVIDER=hogsend` and the provider is NOT registered, the system SHALL throw at boot
  with the existing unresolvable-provider error, matching current behaviour for any other id.
- WHEN a consumer without the package type-checks, the system SHALL type-check clean, with no TS2307.
- WHEN a Cloud environment is provisioned, the system SHALL inject `HOGSEND_EMAIL_TOKEN`,
  `HOGSEND_EMAIL_RELAY_URL`, `HOGSEND_EMAIL_WEBHOOK_SECRET` and `EMAIL_PROVIDER=hogsend` into the
  stack, and the instance SHALL send successfully with no `RESEND_API_KEY` present.
- WHEN a self-hosted deploy upgrades the engine without setting any of these variables, the system
  SHALL behave exactly as before.

## Tasks

1. **Add the env vars to `packages/engine/src/env.ts`** as optional, mirroring the Postmark block's
   comments so the next reader understands the opt-in posture.
   _Boundary:_ `packages/engine` · _Depends:_ none

2. **Add the preset to `email-providers-from-env.ts`** using the guarded dynamic import and
   `loadOptionalPlugin`. Copy the Postmark idiom precisely, including the runtime-assembled
   specifier.
   _Boundary:_ `packages/engine` · _Depends:_ task 1

3. **Add `@hogsend/plugin-hogsend` as an engine `optionalDependency`** and mirror any runtime
   dependency into the `create-hogsend` template `_package.json`.
   _Boundary:_ `packages/engine`, `packages/create-hogsend` · _Depends:_ task 2

4. **Provisioner env injection** — the four variables, from PRD 06's mint.
   _Boundary:_ `apps/cloud` · _Depends:_ task 2

4b. **Thread the mailer's replay-stable idempotency key into `SendEmailOptions.headers` as
   `Idempotency-Key`**, per the locked decision above, with a test asserting it arrives at the
   provider. Without this the relay's exactly-once guard does nothing for a crash replay, which is
   the single case it exists for.
   _Boundary:_ `packages/engine` · _Depends:_ task 2

5. **Docs.** A Cloud-framed page: what Hogsend Email is, the one-record domain setup, the branded
   return path toggle, what happens when a tenant is paused, and that BYO Resend/Postmark remain
   fully supported. No pricing, no signup, no ESP framing.
   _Boundary:_ `apps/docs` · _Depends:_ tasks 2, 4

6. **Tests.** Preset built only when the variable is present; no import when absent; warn (not
   silence) on resolve failure; unresolvable-`EMAIL_PROVIDER` still throws. Add a type-check case
   proving a consumer without the package compiles clean, because that regression is invisible in
   this repo and only shows up in a fresh scaffold.
   _Boundary:_ `packages/engine` · _Depends:_ tasks 2, 3

## Seams

- End-to-end confirmation ("provision a real environment, verify a real domain, receive a real
  email") needs PRD 01's AWS access. This is the launch smoke test for the whole stack, not just
  this PRD. Note that test mode only redirects: a real key means a real delivery.

## Done when

A container with the variables set registers and resolves the provider, a container without them is
byte-for-byte unchanged in behaviour, a package-less consumer type-checks clean, the docs page
exists, and gates are green.

## Implementation Notes

Engine side shipped 2026-08-10 (`a135f7ae`), with a blocking fix in `575d4f14`. Engine suite
117 → 119 tests. Task 4 (the `EMAIL_PROVIDER=hogsend` flip in the provisioner) is still open.

**The bug worth remembering.** The first cut threaded `Idempotency-Key` into
`SendEmailOptions.headers` for EVERY provider. `plugin-resend` forwards `headers` verbatim
(`src/send.ts:130`) and `plugin-postmark` maps them onto message `Headers`, so **both deliver them to
the recipient as SMTP headers**. An existing self-hosted Resend deploy that set none of these
variables would, on upgrading the engine, stamp an internal Hatchet run id on every journey send, and
a campaign send would carry the recipient's own address — visible in "show original". That is a
silent behaviour change for every existing deploy, against this PRD's own acceptance criterion.

The threading is now gated on a provider that declares it consumes the key. Only `plugin-hogsend`
lifts the header back off before the wire.

The general shape, which is the third instance of it in this stack: **a provider-neutral contract
does not make a change neutral.** `headers` looked like an inert carrier and is a delivered artifact
for two of the three providers.

### Follow-ups, deliberately not done here

1. **Retire the `meta.id === "hogsend"` hardcode.** The gate reads
   `capabilities.consumesIdempotencyKey === true` first and falls back to the id. Declaring
   `consumesIdempotencyKey` on `EmailProviderCapabilities` in `@hogsend/core` and setting it in
   `plugin-hogsend` lets the id check go. The gate already reads the capability defensively, so this
   needs no engine change when it lands.
2. **Docs sequencing.** `apps/docs/content/docs/cloud/email.mdx` describes the domain setup (PRD 07),
   the pause notice and Studio history (PRD 08), and delivery/bounce webhooks (PRD 05). All are
   correct about the intended system and none is fully shipped yet. Docs deploy from `main`, so the
   page must not reach `main` ahead of those PRDs, or it documents surfaces a customer cannot use.
</content>
