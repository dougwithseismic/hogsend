# PRD 06 — SES tenant provisioning

**Status:** `[ ]` · **Depends:** 02 · **Boundary:** `apps/cloud`

## Goal

When a Cloud environment is provisioned, it gets an SES tenant, a configuration set, tenant-level
suppression, a starting reputation policy, and a relay token injected into its stack. When it is torn
down, all of that goes away.

This is where the instance-per-tenant model and SES Tenants line up one-to-one.

## Locked decisions

- **One SES tenant per `environment`, named `env-<environmentId>`.** DECISIONS §3.2. Opaque and
  stable; no customer-controlled string in an AWS resource name.
- **Region derives from `SubstrateRegion`** (DECISIONS §3.3) and is pinned for the environment's
  life. Recorded on the environment row so nothing has to re-derive it later.
- **`SuppressionScope: TENANT`**, tracking both bounces and complaints. Without this, tenants share
  the account suppression list, which means one tenant's bounce silently suppresses that address for
  every other tenant. That is both a deliverability bug and a cross-tenant information leak, and it
  is the single most important line in this PRD.
- **New tenants start on reputation policy `None`.** This is AWS's own onboarding advice: observe
  before enforcing. Findings are still recorded and still visible, they just do not auto-pause.
  Promotion to `Standard` is PRD 08's job, not a provisioning-time decision.
- **Provisioning is idempotent and resumable.** The existing pipeline can retry; every SES call here
  must tolerate "already exists" and converge. PRD 02's `createTenant` already specifies this.
- **Teardown is real.** Delete the tenant resource associations, the tenant, the configuration set,
  and the relay token. A leaked SES tenant is not free and, worse, a leaked configuration set keeps
  publishing events for an environment that no longer exists.
- **The relay token is minted here and injected as an env var into the stack.** Plaintext exists
  exactly once, at mint time, long enough to inject. Only the hash is stored.

## Acceptance criteria (EARS)

- WHEN an environment is provisioned, the system SHALL create an SES tenant named
  `env-<environmentId>` in the region derived from the stack's `SubstrateRegion`.
- WHEN the SES tenant is created, the system SHALL create a configuration set, associate it with the
  tenant, set `SuppressionScope: TENANT` for both bounces and complaints, and set the reputation
  policy to `None`.
- WHEN provisioning is retried after a partial failure, the system SHALL converge to the same end
  state without error and SHALL NOT create duplicate resources.
- WHEN provisioning completes, the system SHALL mint a relay token, store only its hash, and inject
  the plaintext into the stack's environment alongside the relay URL and webhook secret.
- WHEN an environment is torn down, the system SHALL remove its tenant resource associations,
  tenant, configuration set and relay token, and SHALL tolerate any of them already being absent.
- WHEN AWS credentials are not configured, the system SHALL provision against the Fake and the
  environment SHALL still complete provisioning successfully, with Hogsend Email marked unavailable
  rather than the provision failing.
- WHEN a tenant's environment record is read, the system SHALL expose its SES tenant name, region,
  configuration set name and current reputation policy.

## Tasks

1. **Schema.** Add the SES fields to the environment (or a dedicated `ses_tenants` table, decided in
   build): tenant name, region, configuration set name, reputation policy, provisioned-at. Migration
   via the existing cloud migration track.
   _Boundary:_ `apps/cloud` · _Depends:_ none

2. **`provisionSesTenant(environmentId)`** — the idempotent converge routine: create tenant, create
   configuration set, associate, set suppression scope, set reputation policy `None`. Every step
   tolerant of already-exists.
   _Boundary:_ `apps/cloud` · _Depends:_ task 1

3. **`deprovisionSesTenant(environmentId)`** — teardown, tolerant of already-absent, in dependency
   order (associations before tenant, per the SES rule that an associated resource cannot be
   deleted).
   _Boundary:_ `apps/cloud` · _Depends:_ task 2

4. **Relay token mint and injection.** Hash-at-rest, plaintext injected into the stack env once.
   Reuse the existing encryption helper under `CLOUD_ENCRYPTION_SECRET`.
   _Boundary:_ `apps/cloud` · _Depends:_ task 1

5. **Hook into `pipeline/provision.ts` and the teardown path**, at the right stage relative to the
   existing stack creation, so a failed SES step does not orphan a Railway stack or vice versa.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 2, 3, 4

6. **Tests against the Fake.** Full provision converges; a retry after each individual step fails
   still converges (drive this by making the Fake throw at step N, for every N); teardown is
   idempotent; suppression scope is asserted to be `TENANT`, because that line silently doing nothing
   is exactly the kind of bug that stays invisible until it leaks.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 2, 3, 4, 5

## Seams

- Provisioning against a real AWS account cannot be verified until PRD 01 grants access. The in-repo
  path ships complete against the Fake. Mark `[~]` and enumerate: "provision one real environment
  against the live account and confirm the tenant, configuration set and suppression scope exist."

## Done when

Provision and teardown converge idempotently against the Fake under injected failure at every step,
the relay token round-trips, `SuppressionScope: TENANT` is asserted, and gates are green.

## Implementation Notes
</content>
