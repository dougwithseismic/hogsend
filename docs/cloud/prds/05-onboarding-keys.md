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

EARS to be written when popped. Key invariants: never render a full key after save; a
failed validation stores nothing; env sync is audit-logged; test environments always get
`HOGSEND_TEST_MODE=true` regardless of keys.

_Boundary:_ `apps/cloud`. _Depends:_ PRD 03, PRD 04.

## Implementation Notes
