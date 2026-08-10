# PRD 02 — SES client seam

**Status:** `[ ]` · **Depends:** none · **Boundary:** `apps/cloud`

## Goal

One typed interface for every SES operation this stack needs, one AWS implementation behind it, and
one deterministic Fake. This is the spine: it is the ONLY place in the codebase that talks to AWS,
which is what makes PRDs 03–10 testable without a network.

Mirrors the house idiom already used by `apps/cloud/src/substrate/` (`contract.ts` + `fake.ts`),
`apps/cloud/src/images/` (`exec.ts` + `fake-exec.ts`), and `apps/cloud/src/billing/`
(`types.ts` + `stripe.ts` + `fake.ts`). Follow it exactly rather than inventing a fourth shape.

## Locked decisions

- **`@aws-sdk/client-sesv2`, installed with `pnpm add @aws-sdk/client-sesv2@latest`.** v2 only. The
  v1 `client-ses` API has no tenant support at all, so reaching for it is a dead end.
- **The contract is narrow and named for our verbs, not AWS's.** Nineteen verbs, all declared here,
  each mapped to an AWS operation name **verified verbatim against the SESv2 API reference on
  2026-08-10** (never inferred from an SDK method name — a guessed action name surfaces as
  `AccessDenied` during a customer's provisioning run, which is the worst place to find it):

  | Group | Verb | AWS operation | First consumer |
  | --- | --- | --- | --- |
  | Send | `sendEmail` | `SendEmail` | PRD 03 |
  | Send | `sendBatch` | `SendBulkEmail` | PRD 03 |
  | Tenant | `createTenant` | `CreateTenant` | PRD 06 |
  | Tenant | `getTenant` | `GetTenant` | PRD 06 |
  | Tenant | `deleteTenant` | `DeleteTenant` | PRD 06 |
  | Tenant | `associateResource` | `CreateTenantResourceAssociation` | PRD 06 |
  | Tenant | `disassociateResource` | `DeleteTenantResourceAssociation` | PRD 06 |
  | Tenant | `putSuppressionScope` | `PutTenantSuppressionAttributes` | PRD 06 |
  | Config set | `createConfigurationSet` | `CreateConfigurationSet` | PRD 06 |
  | Config set | `deleteConfigurationSet` | `DeleteConfigurationSet` | PRD 06 |
  | Config set | `putEventDestination` | `Create…`/`UpdateConfigurationSetEventDestination` | PRD 05 |
  | Identity | `createIdentity` | `CreateEmailIdentity` | PRD 07 |
  | Identity | `getIdentity` | `GetEmailIdentity` | PRD 07 |
  | Identity | `setMailFrom` | `PutEmailIdentityMailFromAttributes` | PRD 07 |
  | Identity | `deleteIdentity` | `DeleteEmailIdentity` | PRD 07 |
  | Reputation | `setReputationPolicy` | `UpdateReputationEntityPolicy` | PRD 08 |
  | Reputation | `setTenantSendingStatus` | `UpdateReputationEntityCustomerManagedStatus` | PRD 08 |
  | Reputation | `getReputationEntity` | `GetReputationEntity` | PRD 08 |
  | Reputation | `listRecommendations` | `ListRecommendations` | PRD 08 |

  The delete verbs exist because PRD 06's teardown is real, and `putEventDestination` because PRD 05
  needs the configuration set to publish to SNS. Declaring them here rather than letting each PRD
  bolt one on is the point of having a seam. If a later PRD needs a twentieth, it adds it HERE
  first, in both the AWS client and the Fake.

  Three corrections applied 2026-08-10 after verification against AWS, recorded because each was a
  real defect rather than a wording change:

  1. **`putSuppressionScope` is a TENANT operation, not a configuration-set one.** It was grouped
     under Config set. `PutTenantSuppressionAttributes` takes `{ TenantName (required),
     SuppressionScope: ACCOUNT|TENANT, SuppressedReasons: (BOUNCE|COMPLAINT)[] }` and has no
     configuration-set parameter. The similarly-named `PutConfigurationSetSuppressionOptions` is a
     different operation that **cannot set tenant scope**. Wiring the config-set one would have left
     `SuppressionScope: TENANT` silently doing nothing, which is precisely the cross-tenant
     suppression leak PRD 06 calls its most important line.
  2. **`getTenant` was missing and is load-bearing.** `CreateTenant` returns the tenant ARN only on
     the call that creates it, so this PRD's own idempotency criterion is unimplementable without a
     read-back, and both reputation writes address the tenant by ARN.
  3. **`getReputationEntity` was missing.** Without it there is no reconciliation path for a missed
     EventBridge event, and since the relay reads our mirrored status, that failure mode is
     fail-OPEN.

  **`putEventDestination` has no AWS `Put` counterpart.** SESv2 offers only `Create…` and
  `Update…ConfigurationSetEventDestination`. Implement it as create-then-update-on-already-exists so
  a provisioning re-drive converges. Comment the asymmetry in the code; the next reader will go
  looking for a `Put` that does not exist.

  Both reputation writes take `ReputationEntityType: "RESOURCE"` and a `ReputationEntityReference`
  that is the tenant **ARN**, with the policy itself an AWS-owned ARN
  (`arn:aws:ses:<region>:aws:reputation-policy/<standard|strict|none>`).
- **The Fake is deterministic and stateful in memory.** Same input, same output, no clock, no RNG.
  It models tenant existence, identity verification state, and paused status, so downstream PRDs can
  drive real state transitions in tests rather than stubbing return values.
- **Errors are classified, not raw.** AWS throws a wide error surface; the contract narrows it to a
  `SesError` with a `kind` of `not_found | already_exists | throttled | account_paused |
  tenant_paused | invalid | transient | unknown`. Callers branch on `kind`, never on a message
  string. **Never retry a 4xx and never discard a response body** — both have burned us before.
- **Region is a constructor argument**, and one client instance exists per region. Tenants are
  region-scoped and do not replicate, so a client that could silently target the wrong region is a
  correctness bug waiting to happen.

## Acceptance criteria (EARS)

- WHEN a caller invokes any contract method against the Fake, the system SHALL return without any
  network access, and no test in the repository SHALL reach AWS.
- WHEN the AWS implementation receives a 4xx from SES, the system SHALL classify it into a
  `SesError.kind`, preserve the response body on the error, and SHALL NOT retry it.
- WHEN the AWS implementation receives a throttling or 5xx response, the system SHALL retry with
  bounded exponential backoff and SHALL surface `kind: "transient"` when retries are exhausted.
- WHEN `createTenant` is called for a tenant name that already exists, the system SHALL return the
  existing tenant rather than throwing, so provisioning is idempotent and resumable.
- WHEN a client is constructed, the system SHALL require an explicit region and SHALL reject any
  region outside the `SubstrateRegion` mapping in DECISIONS §3.3.
- WHEN AWS credentials are absent, the system SHALL construct the Fake instead of the AWS client and
  log one line naming which is active.

## Tasks

1. **Write `apps/cloud/src/ses/types.ts`** — `SesRegion`, `SesError` with its `kind` union, and the
   argument/result types for all nineteen verbs. Types only, no behaviour.
   _Boundary:_ `apps/cloud` · _Depends:_ none

2. **Write `apps/cloud/src/ses/contract.ts`** — the `SesClient` interface, plus the region resolver
   that maps `SubstrateRegion` → SES region and throws on anything else.
   _Boundary:_ `apps/cloud` · _Depends:_ task 1

3. **Write `apps/cloud/src/ses/fake.ts`** — in-memory, deterministic, stateful. Models tenants,
   identities (with a verification state you can advance explicitly), configuration sets, suppression
   scope, reputation policy, and sending status. Exposes test-only helpers to advance state
   (`__verifyIdentity`, `__pauseTenant`) so downstream tests drive transitions rather than mocking.
   _Boundary:_ `apps/cloud` · _Depends:_ task 2

4. **Write `apps/cloud/src/ses/aws.ts`** — the real implementation over `@aws-sdk/client-sesv2`,
   including the error classifier and the bounded-backoff retry that never retries a 4xx.
   _Boundary:_ `apps/cloud` · _Depends:_ task 2

5. **Write `apps/cloud/src/ses/index.ts`** — the factory that picks AWS or Fake from env, one client
   per region, and the boot log line.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 3, 4

6. **Tests.** Fake determinism; the classifier over a table of real SES error shapes; no-retry-on-4xx
   proved by a call counter; idempotent `createTenant`; region rejection. Mutation-check the
   no-retry guard: break it, watch the test fail, restore.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 3, 4, 5

## Seams

None. This PRD ships complete against the Fake and needs no external access. The AWS implementation
is exercised for real the first time PRD 06 provisions against a live account, which is why its
error classification is specified here rather than discovered there.

## Done when

All nineteen verbs exist on the contract, the Fake implements them deterministically, the AWS client
compiles against `sesv2`, the error classifier is table-tested, and gates are green.

## Implementation Notes
</content>
