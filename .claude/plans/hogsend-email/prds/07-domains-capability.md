# PRD 07 — Domains capability

**Status:** `[ ]` · **Depends:** 02, 06 · **Boundary:** `apps/cloud`, `packages/plugin-hogsend`

## Goal

Let a tenant verify their sending domain with **one DNS record**, and beat Resend's onboarding while
doing it.

The headline: `DomainsCapability` already exists in `packages/core/src/providers/domains.ts`, and the
CLI's `dns-apply` already writes records through the Cloudflare and Vercel APIs. Implementing the
capability lights up the admin routes, the `hogsend domain` CLI, Studio Setup, and one-click DNS
write **with no new UI**. This PRD is an interface implementation, not a wizard build.

## Locked decisions

- **BYODKIM with a 2048-bit RSA keypair.** AWS supports 1024 to 2048; Resend ships 1024. We generate
  2048. Verified on 2026-08-10: `resend._domainkey` on resend.com, cal.com and hogsend.com are all
  1024-bit.
- **Default flow is ONE TXT record.** BYODKIM verifies the identity by itself, no custom MAIL FROM.
  The return path stays a subdomain of `amazonses.com`, SPF passes natively for SES, and DMARC passes
  on DKIM alignment. This is the whole competitive point: Resend asks for three records because they
  default everyone to a custom return path.
- **The branded return path is an ADVANCED TOGGLE, off by default.** Enabling it calls
  `PutEmailIdentityMailFromAttributes` for `send.<domain>` and adds the MX and SPF records. Per
  DECISIONS §2, the MAIL FROM subdomain must sit under the verified identity's parent domain, so a
  Hogsend-owned bounce domain is not available and this is the only shape on offer.
- **`MailFromDomainNotVerified` behaviour is `USE_DEFAULT_MAIL_FROM`**, not `REJECT_MESSAGE`. If a
  customer's MX record breaks six months later, their mail must keep flowing on the default return
  path rather than hard-failing. Choosing reject here would convert a DNS mistake into an outage.
- **The DKIM private key is stored encrypted in `provider_keys`** under the existing AES-256-GCM
  helper with `CLOUD_ENCRYPTION_SECRET`. Do not invent a second secret store, do not put a private
  key in an env var, and never log it.
- **Selector is `hogsend`.** So the record is `hogsend._domainkey.<domain>`, which is legible to the
  customer and unambiguous against any other provider they may also have configured.
- **Key rotation is designed for but not shipped.** The schema carries a selector column so a future
  rotation can publish a second selector before retiring the first. Rotating in this wave is out of
  scope.

## Acceptance criteria (EARS)

- WHEN `create(domain)` is called for a domain not yet known, the system SHALL generate a 2048-bit
  RSA keypair, store the private key encrypted, call `CreateEmailIdentity` with the BYODKIM signing
  attributes and the `hogsend` selector, and return a `DomainStatus` whose `records` contain exactly
  ONE record: a TXT at `hogsend._domainkey` with the `p=` public key.
- WHEN `create(domain)` is called for a domain that already exists, the system SHALL fall through to
  a lookup and return the existing status rather than throwing, and SHALL NOT generate a new keypair.
- WHEN `get(domain)` is called for a domain SES does not know, the system SHALL return `null`.
- WHEN the DKIM record has propagated and SES reports `DkimAttributes.Status: SUCCESS` with
  `SigningAttributesOrigin: EXTERNAL` and `SigningEnabled: true`, the system SHALL report
  `state: "verified"`.
- WHEN the branded return path is enabled for a verified domain, the system SHALL call
  `PutEmailIdentityMailFromAttributes` with `send.<domain>` and `USE_DEFAULT_MAIL_FROM` behaviour,
  and SHALL add exactly two records to `records`: an MX at `send.<domain>` pointing at
  `feedback-smtp.<region>.amazonses.com` with priority 10, and a TXT at `send.<domain>` with
  `v=spf1 include:amazonses.com ~all`.
- WHEN the branded return path is disabled again, the system SHALL revert the identity to the default
  MAIL FROM and SHALL mark the MX and SPF records as no longer required.
- WHEN a returned `DnsRecord` is rendered, the system SHALL populate `purpose` correctly per record
  (`dkim`, `mx`, `spf`) so the existing CLI `dns-apply` can write it without special-casing.
- WHEN the domain has not been created, the system SHALL report `state: "not_found"` rather than
  throwing.
- WHEN any operation runs, the system SHALL NOT log the private key, and the private key SHALL NOT
  appear in any API response.

## Tasks

1. ~~**Implement the identity verbs.**~~ **ALREADY DONE — do not rebuild.** PRD 02 shipped all four
   (`createIdentity` with BYODKIM signing attributes, `getIdentity`, `setMailFrom`, `deleteIdentity`)
   in both the AWS client and the Fake, and the Fake already models a verification state a test
   advances explicitly via `__verifyIdentity`. **`apps/cloud/src/ses/**` is settled and out of
   bounds.**

   What remains of this task is only to CONFIRM the existing verbs carry what this PRD needs (the
   BYODKIM `SigningAttributes`, the `hogsend` selector, `DkimAttributes.Status` /
   `SigningAttributesOrigin` / `SigningEnabled` on read, and the `USE_DEFAULT_MAIL_FROM` behaviour on
   `setMailFrom`). If something genuinely is missing, STOP and report it rather than editing the
   seam, since a twentieth verb is a decision that belongs in PRD 02.
   _Boundary:_ none (verification only) · _Depends:_ none

2. **Keypair generation and encrypted storage.** 2048-bit RSA via `node:crypto`, PEM-stripped and
   newline-stripped to the exact format SES requires for both the private key and the published
   public key. Store encrypted in `provider_keys`; store the selector alongside.
   _Boundary:_ `apps/cloud` · _Depends:_ none

3. **`createHogsendDomains()` implementing `DomainsCapability`** — `create`, `get`, `records`,
   `verify`. Normalize into `DnsRecord` / `DomainStatus` with correct `purpose` and `status` values.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 1, 2

4. **Control-plane domain endpoints** so a tenant instance can reach the capability through the
   relay (the instance has no AWS access). Same bearer-token auth as PRD 03.
   _Boundary:_ `apps/cloud` · _Depends:_ task 3

5. **Attach `domains` to the provider in `packages/plugin-hogsend`** — a thin HTTP client over task
   4's endpoints. Presence is the gate, so this is what makes admin routes and Studio Setup light up.
   _Boundary:_ `packages/plugin-hogsend` · _Depends:_ task 4

6. **Branded-return-path toggle, control-plane side** — enable and disable, with the record set
   changing in both directions.
   _Boundary:_ `apps/cloud` · _Depends:_ task 3

7. **Branded-return-path toggle, plugin side** — the client call and its typed result.
   _Boundary:_ `packages/plugin-hogsend` · _Depends:_ tasks 5, 6

8. **Control-plane tests.** Assert the default flow returns **exactly one** record, because
   "we accidentally shipped three records like Resend" is the specific regression that would erase
   the entire competitive point of this PRD. Assert the key is 2048-bit. Assert no code path logs or
   returns the private key, and mutation-check that assertion.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 3, 6

9. **Plugin tests.** Capability presence, the four `DomainsCapability` methods over the HTTP client,
   and correct `purpose` on every returned record so CLI `dns-apply` needs no special-casing.
   _Boundary:_ `packages/plugin-hogsend` · _Depends:_ tasks 5, 7

## Seams

- The CLI `dns-apply` path should be exercised against a real Cloudflare zone once, manually, to
  confirm the record shapes are accepted. Enumerate as a launch check rather than a build blocker.

## Done when

The default flow yields exactly one TXT record, the branded toggle yields exactly two more, both
directions are tested against the Fake, the private key never escapes, and gates are green.

## Implementation Notes
</content>
