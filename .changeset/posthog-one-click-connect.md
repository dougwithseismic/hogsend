---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

feat(connect): one-click PostHog connect — derive key, mint secret, keyless start

`hogsend connect posthog` becomes the single front door. It runs the OAuth
handshake first (region via prompt or `--posthog-host`, no `phc_` paste needed),
mints + persists the webhook secret server-side, creates the PostHog→Hogsend
webhook destination, and grabs the project's public key on the way through. The
inbound webhook source resolves the minted secret from the credential store at
request time, so the loop verifies without a redeploy.

The OAuth scope set is front-loaded (4 → 13) so future features land without
forcing a reconnect; `connect-info` surfaces a `scopeGap` to nudge
already-connected users to re-consent. The `create-hogsend` scaffold makes the
`phc_` paste optional, pointing at `hogsend connect posthog` instead.

Engine additions (additive): `getDerivedCredential`/`saveDerivedCredential` +
`DerivedCredentialPayload`, the `"derived"` `CredentialKind`, and
`EXPECTED_POSTHOG_SCOPES`.

Note (deploy ordering): the hosted CIMD document must serve the 13-scope set
before the new CLI requests it, or PostHog rejects the broader consent.
