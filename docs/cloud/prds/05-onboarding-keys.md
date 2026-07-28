# PRD 05 — Provider-key onboarding (scoped; flesh out when popped)

## Scope
The "paste your keys" flow: guided onboarding after org creation and an ongoing
Settings → Providers surface. Collect Resend OR Postmark (required to activate email),
PostHog (optional: phc_ key, personal API key, host), Twilio (optional). Validate each key
live against the provider API before accepting (Resend: domains list; Postmark: server
check; PostHog: capability probe; Twilio: account fetch); store via PRD 02
`ProviderKeyService`; sync to the stack env via `SubstrateProvider.setEnv` + redeploy.
Also collect the **sender identity**: a from-address validated against the provider's
verified domains (the Resend domains-list call above), synced as `EMAIL_FROM` +
`EMAIL_DOMAIN` alongside the key — never let a tenant send from the engine's
`noreply@hogsend.com` default through their own provider account.
Show verification status + last4 only. Key rotation = same flow, replace + resync.
Removal warns about which engine features go inert.

## EARS acceptance criteria
- WHEN a Resend key is submitted, the system SHALL validate it live (domains list),
  store it encrypted with the verified domains recorded, and reject invalid keys
  storing NOTHING.
- WHEN a from-address is submitted, the system SHALL accept it only when its domain is
  among the provider's verified domains, and sync `EMAIL_FROM`+`EMAIL_DOMAIN` with the
  key.
- WHEN a stored key exists, the UI SHALL render only provider, last4, verified state,
  and timestamps — never the payload, on any surface or error path.
- WHEN keys are saved for an environment with a `running` stack, the system SHALL sync
  them to the stack env via `SubstrateProvider.setEnv` + redeploy, audit-logged; for a
  not-yet-running stack the pipeline's set-env step SHALL pick them up (already built).
- WHEN a key is removed, the system SHALL warn which engine features go inert, unset the
  env vars on sync, and audit.
- WHEN a test-kind environment syncs, `HOGSEND_TEST_MODE=true` SHALL persist regardless.

## Tasks
1. **Validators + key-sync service** — `src/services/key-validation.ts` (live probes:
   Resend domains, Postmark server, PostHog capability, Twilio account — each behind an
   injectable fetch for tests) + `src/services/key-sync.ts` (assemble provider env map +
   setEnv/redeploy on running stacks; shared with pipeline's mapping — extract, don't
   duplicate). _Boundary:_ apps/cloud. _Depends:_ PRD 04.
2. **Settings → Providers UI + onboarding step** — settings section (add/rotate/remove
   per provider, from-address field, verification status) + a post-create-org guided
   step (skippable; instance runs with email inert until keys arrive — say so
   factually). _Boundary:_ apps/cloud. _Depends:_ 1.

_Boundary:_ `apps/cloud`. _Depends:_ PRD 03, PRD 04.

## Implementation Notes
Shipped in 2 commits; 389 tests on close. Notables: PostHog phc_ key is SHAPE-validated
only (a live probe would persist an event; the key is write-only by design) — UI says
"stored, unverified" honestly; personal key live-probed. From-address = pseudo-provider
row `sender-identity` (zero migrations); domain-verification enforced only where the
provider exposes a verified list (Resend). Sync recomputes the FULL provider env with
null-unsets on every write; HOGSEND_TEST_MODE re-asserted for non-prod envs. Pipeline
and sync share `provider-env.ts` — extraction proven by untouched pipeline tests.
Deferred nits: Postmark sender verification via GET /senders; removing an email
provider keeps the sender-identity row.
