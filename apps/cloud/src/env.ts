import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const isDevOrTest =
  process.env.NODE_ENV === undefined ||
  process.env.NODE_ENV === "development" ||
  process.env.NODE_ENV === "test";

/**
 * The local docker-compose TimescaleDB (`docker-compose.yml`, service
 * `postgres`) — user/password `growthhog`, host port 5434. The DATABASE is
 * `hogsend_cloud`, NOT the engine's `growthhog`: the cloud control plane owns
 * its own database and never shares a schema with the engine.
 */
const LOCAL_CLOUD_DATABASE_URL =
  "postgres://growthhog:growthhog@localhost:5434/hogsend_cloud";

/**
 * DEV/TEST ONLY — a fixed, publicly-known string so a fresh clone can encrypt
 * provider keys without any setup. It is deliberately self-describing: anything
 * encrypted under it is worthless, and production never sees it (the schema
 * below withholds the default when NODE_ENV=production, so a missing
 * CLOUD_ENCRYPTION_SECRET fails the boot).
 */
const DEV_CLOUD_ENCRYPTION_SECRET =
  "dev-only-insecure-cloud-encryption-secret-change-me";

/**
 * DEV/TEST ONLY — the Better Auth signing secret, same posture as
 * `DEV_CLOUD_ENCRYPTION_SECRET`: a fresh clone can sign sessions with no setup,
 * and production withholds the default so a missing `CLOUD_AUTH_SECRET` fails
 * the boot rather than shipping a publicly-known signing key.
 */
export const DEV_CLOUD_AUTH_SECRET =
  "dev-only-insecure-cloud-auth-secret-change-me";

/**
 * DEV/TEST ONLY — the credentials the repo's docker-compose `hatchet-lite`
 * seeds (`docker-compose.yml`). They exist so a fresh clone can mint a tenant
 * Hatchet token against local infrastructure with no setup; production
 * withholds them (see the schema below) so a deploy must supply the real cell
 * admin account.
 */
const DEV_HATCHET_ADMIN_EMAIL = "admin@example.com";
const DEV_HATCHET_ADMIN_PASSWORD = "Admin123!!";

/**
 * The billing modes, in one place so the dev and production schemas below can
 * differ in what they ACCEPT without differing in what they mean.
 */
export const BILLING_MODES = ["fake", "stripe", "disabled"] as const;

/** The dev origin the Next app listens on (`next dev -p 3004`). */
export const DEFAULT_CLOUD_PUBLIC_URL = "http://localhost:3004";

export const env = createEnv({
  server: {
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    // Required everywhere. In dev/test it falls back to the compose database so
    // a fresh clone is one command; in production the default is withheld so a
    // missing value fails the boot instead of silently pointing at localhost.
    CLOUD_DATABASE_URL: isDevOrTest
      ? z.string().min(1).default(LOCAL_CLOUD_DATABASE_URL)
      : z.string().min(1),
    // The AES-256-GCM key material for `lib/crypto.ts` (provider keys, cell
    // DSNs). 32 chars is the floor everywhere — the key itself is a sha256 of
    // this value, so a short secret would silently weaken every ciphertext.
    CLOUD_ENCRYPTION_SECRET: isDevOrTest
      ? z.string().min(32).default(DEV_CLOUD_ENCRYPTION_SECRET)
      : z.string().min(32),
    // Better Auth's signing secret (`src/lib/auth.ts`). Distinct from
    // CLOUD_ENCRYPTION_SECRET on purpose: rotating the session signing key must
    // not make every stored provider-key ciphertext undecryptable.
    CLOUD_AUTH_SECRET: isDevOrTest
      ? z.string().min(32).default(DEV_CLOUD_AUTH_SECRET)
      : z.string().min(32),
    // The origin Better Auth signs callbacks/cookies against. Defaults to the
    // dev port everywhere — a production deploy behind the wrong origin fails
    // loudly at request time (origin mismatch), not silently at boot.
    CLOUD_PUBLIC_URL: z.url().default(DEFAULT_CLOUD_PUBLIC_URL),
    // How many proxies sit in front of this app, for reading `x-forwarded-for`
    // (`lib/rate-limit.ts`). The header is append-only and client-writable, so
    // the address a rate limit may key on is counted from the RIGHT: with N
    // trusted hops it is the Nth entry from the end. Getting this wrong is
    // deliberately asymmetric — too LOW buckets many callers under one proxy
    // address (a tighter limit, visible as refusals), too HIGH keys on an entry
    // the caller wrote (no limit at all) — so the default is the safe one and a
    // deploy behind Cloudflare *and* Railway raises it to 2.
    CLOUD_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(8).default(1),
    // OPTIONAL. Absent → OTP codes go to the server log (`logSender`). Present
    // → they are emailed through Resend. Tests never set it, so no test can
    // reach the network.
    CLOUD_RESEND_API_KEY: z.string().min(1).optional(),
    // From-address for the Resend transport. Only read when a key is set.
    CLOUD_RESEND_FROM: z
      .string()
      .min(1)
      .default("Hogsend <no-reply@hogsend.com>"),
    // OPTIONAL. Where the stack alert sweep sends its notices. Absent → the
    // notice goes to the server log through the same `logSender` the signup OTP
    // falls back to, so a local run needs no configuration and cannot page a
    // real human by accident. A deploy that wants to be told sets it.
    CLOUD_OPERATOR_EMAIL: z.string().min(1).optional(),
    // OPTIONAL. Bearer token for the operator stats endpoint
    // (`GET /api/ops/stats`). Absent → the route answers 404 and exposes
    // nothing, so a deploy that never configured it has no ops surface at all.
    // 32+ chars because it is a raw shared secret, not a hashed credential.
    CLOUD_OPS_TOKEN: z.string().min(32).optional(),
    // How long a stack may sit in any non-`running` status before the operator
    // is told. Thirty minutes because a legitimate provision — including the
    // pipeline's ten-minute health wait and up to a few sweep re-drives — fits
    // comfortably inside it, so a stack that crosses it is no longer "slow",
    // it is stuck.
    CLOUD_ALERT_NON_RUNNING_AFTER_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .default(30),
    // How long the same unchanged condition stays quiet before it is repeated.
    // A day, because the alert's job is to tell an operator something they do
    // not already know: a stack still stuck tomorrow is worth one more line,
    // and a stack still stuck in five minutes is not.
    CLOUD_ALERT_COOLDOWN_HOURS: z.coerce.number().int().min(1).default(24),
    // WHEN a tenant's substrate is actually built (PRD 15).
    //
    //  - `first-publish` (the default): org creation mints the trio with the
    //    stack in `deferred` and enqueues NOTHING. The publish intake promotes
    //    it to `requested` and enqueues on the first upload. A Railway stack per
    //    verified email is real money per signup, and most drive-by signups
    //    never publish;
    //  - `signup`: today's behaviour — enqueue the moment the org exists.
    //
    // ONE policy, read by BOTH the browser create-org path and the CLI signup:
    // two front doors that provisioned differently would be a difference nobody
    // could reason about from a stack row.
    CLOUD_PROVISION_ON: z
      .enum(["signup", "first-publish"])
      .default("first-publish"),
    // Which `SubstrateProvider` backs every infrastructure operation. Dev/test
    // default to the in-memory fake so a fresh clone can walk a whole
    // provision → running → destroy with no cloud account. Production
    // WITHHOLDS the default: a deploy that forgot to choose must fail the boot
    // rather than quietly running a control plane that provisions nothing.
    CLOUD_SUBSTRATE: isDevOrTest
      ? z.enum(["fake", "railway"]).default("fake")
      : z.enum(["fake", "railway"]),
    // The Railway workspace token. OPTIONAL here (a fake-substrate deploy
    // needs none) and enforced at the point of use: `getSubstrate()` refuses
    // to build a Railway substrate without it (PRD 04 EARS — never silently
    // fake).
    CLOUD_RAILWAY_TOKEN: z.string().min(1).optional(),
    // OPTIONAL workspace/team the org projects are created inside. Absent →
    // Railway places new projects in the token's default workspace, which is
    // correct for a single-workspace account; a multi-workspace account must
    // name one or the projects land somewhere nobody is watching.
    CLOUD_RAILWAY_WORKSPACE_ID: z.string().min(1).optional(),
    // Which `DnsProvider` writes the hostname records.
    //
    // Defaults to the in-memory fake EVERYWHERE, unlike `CLOUD_SUBSTRATE`,
    // and only until provisioning depends on it. Nothing calls this seam yet,
    // so withholding the production default today would fail the boot of a
    // running control plane over a feature that does no work. When the
    // `ensure-hostname` step lands, production must withhold the default the
    // same way the substrate does — a control plane that silently minted
    // hostnames into an in-memory zone would report addresses that resolve
    // nowhere.
    CLOUD_DNS: z.enum(["fake", "cloudflare"]).default("fake"),
    // The zone-scoped Cloudflare API token (DNS edit on ONE zone — never an
    // account-wide token). OPTIONAL here and enforced at the point of use:
    // `getDns()` refuses to build a Cloudflare provider without the trio.
    CLOUD_CLOUDFLARE_TOKEN: z.string().min(1).optional(),
    CLOUD_CLOUDFLARE_ZONE_ID: z.string().min(1).optional(),
    // The zone's own name, e.g. `hogsend.app`. Held separately from the id
    // because the provider refuses a hostname outside it, and comparing names
    // is the only way to check that locally.
    CLOUD_CLOUDFLARE_ZONE_NAME: z.string().min(1).optional(),
    // The registrable domain tenant instances are named under, e.g.
    // `hogsend.app`. Deliberately its own variable rather than reusing the
    // Cloudflare zone name: they are the same string today, but they answer
    // different questions ("which zone may we write to" vs "what are customers
    // called"), and conflating them is how a tenant ends up named inside a zone
    // that serves our own cookied sites.
    //
    // MUST NOT be a subdomain of, or equal to, the domain the SSO cookie is
    // scoped to — see `refuseTenantZone`. Absent → no managed hostnames, and
    // instances keep the substrate's own URL.
    CLOUD_TENANT_ZONE: z.string().min(1).optional(),
    // The domain the shared docs/course SSO cookie is set on, e.g.
    // `.hogsend.com`. The control plane never SETS this cookie — it is declared
    // here so the tenant-zone guard can refuse to name instances anywhere the
    // browser would send it.
    CLOUD_SSO_COOKIE_DOMAIN: z.string().min(1).optional(),
    // The account the provisioner logs into on a CELL's Hatchet to mint each
    // tenant's token (`services/hatchet-tenant.ts`). Dev/test default to
    // hatchet-lite's seeded admin so a fresh clone provisions with no setup;
    // production WITHHOLDS the default and leaves the pair OPTIONAL, because a
    // control plane may run with no cell Hatchet at all — `mintToken` is the
    // one that fails closed, at the point of use, with a message naming these
    // vars.
    CLOUD_HATCHET_ADMIN_EMAIL: isDevOrTest
      ? z.string().min(1).default(DEV_HATCHET_ADMIN_EMAIL)
      : z.string().min(1).optional(),
    CLOUD_HATCHET_ADMIN_PASSWORD: isDevOrTest
      ? z.string().min(1).default(DEV_HATCHET_ADMIN_PASSWORD)
      : z.string().min(1).optional(),
    // The CONTROL PLANE's own Hatchet client (namespace `cloud`), distinct from
    // both the tenant tokens this app mints and the engine's
    // HATCHET_CLIENT_*. OPTIONAL here, enforced at the point of use: the
    // provisioning queue falls back to an in-process runner ONLY under the fake
    // substrate (`pipeline/enqueue.ts`), and the worker refuses to boot without
    // a token when the substrate is real — a control plane that silently ran
    // provisioning inside a web request would lose every in-flight stack on the
    // next deploy.
    CLOUD_HATCHET_CLIENT_TOKEN: z.string().min(1).optional(),
    CLOUD_HATCHET_CLIENT_HOST_PORT: z.string().min(1).default("localhost:7077"),
    CLOUD_HATCHET_CLIENT_TLS_STRATEGY: z
      .enum(["none", "tls", "mtls"])
      .default("none"),
    // Which `BillingProvider` backs checkout, the portal and webhook
    // verification. Same posture as `CLOUD_SUBSTRATE`, for a sharper reason:
    // `FakeBilling` verifies webhooks with a constant committed to this
    // repository, and `/api/billing/webhook` is a public, session-exempt URL. A
    // production deploy that fell back to the fake would therefore be publishing
    // an UNAUTHENTICATED plan-change and suspend API — a failure that is open,
    // not closed. So dev/test default to the fake (a fresh clone needs no Stripe
    // account) and production both WITHHOLDS the default and refuses the fake
    // outright.
    //
    // `disabled` is the legal way to run a control plane with no billing wired:
    // `getBilling()` refuses, and the webhook route answers 503. The other
    // fail-closed rule stands — `stripe` with no secret key throws in
    // `getBilling()` rather than quietly degrading.
    CLOUD_BILLING: isDevOrTest
      ? z.enum(BILLING_MODES).default("fake")
      : z.enum(BILLING_MODES).refine((mode) => mode !== "fake", {
          message:
            'CLOUD_BILLING="fake" is dev/test only — its webhook secret is a public constant. Use "stripe", or "disabled" to run with no billing.',
        }),
    // `sk_...` — Stripe test-mode key first (DECISIONS §8). OPTIONAL here,
    // enforced at the point of use. NEVER logged.
    CLOUD_STRIPE_SECRET_KEY: z.string().min(1).optional(),
    // `whsec_...` for the webhook route's signature check. OPTIONAL here;
    // `StripeBilling.parseWebhook` refuses outright without it rather than
    // accepting an unverifiable payload.
    CLOUD_STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    // The recurring price each paid tier checks out against (DECISIONS §2:
    // self-serve $49/mo, dedicated $149/mo). OPTIONAL: a deploy selling only
    // one tier configures only that one, and `createCheckout` fails closed for
    // the other.
    CLOUD_STRIPE_PRICE_SELF_SERVE: z.string().min(1).optional(),
    CLOUD_STRIPE_PRICE_DEDICATED: z.string().min(1).optional(),
    // The Stripe METER event name Hogsend Email overage is reported under
    // (PRD 09). OPTIONAL here and enforced at the point of use: a deploy that
    // does not sell metered email never sets it, and `reportUsage` fails closed
    // rather than sending events into a meter that does not exist.
    CLOUD_STRIPE_METER_EMAIL_OVERAGE: z.string().min(1).optional(),
    // The stock scaffold image tag a freshly provisioned stack boots on
    // (`hogsend-default:<engine-version>`, PRD 04 "Initial deploy source").
    // Recorded on the stack row at provision time, so a later bump does not
    // rewrite what an existing stack is actually running.
    CLOUD_DEFAULT_ENGINE_VERSION: z.string().min(1).default("0.57.0"),
    // The local SCRATCH directory: the root of the `LocalDiskArtifactStore`
    // (the dev/CI store) AND the build pipeline's `workRoot`, where a tarball
    // is unpacked before the image build. Once a bucket is configured (below)
    // this is NO LONGER artifact storage — artifacts live in the bucket and
    // this directory holds only per-build working copies. Defaulted everywhere
    // rather than withheld in production: a scratch path is not a secret, and
    // the storage question is guarded separately (the bucket boot guard
    // below). Relative values resolve against the process's working directory.
    CLOUD_ARTIFACTS_DIR: z.string().min(1).default("./artifacts"),
    // The S3-compatible bucket artifacts live in (PRD 14): a Railway Bucket,
    // wired by variable reference to its own BUCKET_ENDPOINT / BUCKET_NAME /
    // BUCKET_ACCESS_KEY_ID / BUCKET_SECRET_ACCESS_KEY. All four OPTIONAL here
    // because dev and CI run the local-disk store with no bucket at all — but
    // NOT independently optional: the boot guard below refuses a partial set
    // in every environment, and refuses "none" in production, where the
    // upload lands on cloud-app and the build runs on cloud-worker (separate
    // ephemeral filesystems, no shared volume) so local disk cannot work.
    CLOUD_ARTIFACT_BUCKET_ENDPOINT: z.string().min(1).optional(),
    CLOUD_ARTIFACT_BUCKET_NAME: z.string().min(1).optional(),
    CLOUD_ARTIFACT_BUCKET_ACCESS_KEY_ID: z.string().min(1).optional(),
    CLOUD_ARTIFACT_BUCKET_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    // The SDK insists on a region even against endpoints that ignore one
    // (Railway Buckets do). Defaulted so a Railway deploy sets only the four
    // vars above.
    CLOUD_ARTIFACT_BUCKET_REGION: z.string().min(1).default("us-east-1"),
    // The registry namespace built images are pushed to, e.g.
    // `ghcr.io/withseismic`. OPTIONAL, and its absence is a MODE rather than a
    // misconfiguration: with no registry the build pipeline keeps images local
    // and skips the push with a logged notice, which is exactly right on a dev
    // machine driving the fake substrate. A real deploy sets it, and every
    // reference — including the stock scaffold image provisioning boots on —
    // becomes registry-qualified. Credentials are docker's (`docker login` on
    // the build host), never this app's: a registry password in the control
    // plane's env would be one more secret to rotate for no gain.
    CLOUD_IMAGE_REGISTRY: z.string().min(1).optional(),
    // PULL credentials for that registry, handed to Railway
    // (`registryCredentials` on service create/update) so a tenant service can
    // pull a PRIVATE image. Distinct from the build host's own `docker login`
    // (push side, above): Railway pulls from its side and knows nothing of the
    // build host. Optional as a PAIR — a public registry needs neither, and
    // `getSubstrate` refuses a half-configured pair rather than shipping
    // services that fail their first pull. NEVER logged, never audited.
    CLOUD_REGISTRY_USERNAME: z.string().min(1).optional(),
    CLOUD_REGISTRY_PASSWORD: z.string().min(1).optional(),
    // Which host runs the build pipeline's commands (PRD 14 task 3).
    // `local` — the default everywhere — is the existing `spawnExec` path:
    // docker on THIS machine, which is right for dev and CI and for any
    // deploy whose worker carries a daemon. `sandbox` runs every command in
    // a per-build Railway Sandbox (create → exec → destroy), the only host
    // in the deployed control plane that has Docker at all. Selection is
    // explicit rather than inferred: silently picking a host is how a build
    // ends up running tenant code somewhere nobody chose.
    CLOUD_BUILD_HOST: z.enum(["local", "sandbox"]).default("local"),
    // The Railway environment sandboxes are created in. OPTIONAL here;
    // `sandbox` mode without it is refused by the boot guard below — a
    // partial sandbox configuration is an error, never a fallback.
    CLOUD_BUILD_SANDBOX_ENVIRONMENT_ID: z.string().min(1).optional(),
    // OPTIONAL region pin for the sandbox. Absent → Railway's default.
    CLOUD_BUILD_SANDBOX_REGION: z.string().min(1).optional(),
    // The leak backstop: if this process dies between creating a sandbox and
    // destroying it, Railway reaps the idle VM after this long. An hour
    // comfortably exceeds the longest legal build (the 60m task ceiling)
    // without letting an orphan run all night.
    CLOUD_BUILD_SANDBOX_IDLE_TIMEOUT_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .default(60),
    // Where `packages/create-hogsend/template/` lives, for the two files the
    // build pipeline falls back to (the generic `Dockerfile` and the
    // parameterized `scripts/preflight.sh`). Defaults to the monorepo path
    // resolved from this module, which is correct for a worker running from
    // the repo; a containerised cloud-worker that carries the template
    // elsewhere sets this.
    CLOUD_SCAFFOLD_TEMPLATE_DIR: z.string().min(1).optional(),
    // The control-plane IAM user (`hogsend-cloud-relay`, DECISIONS §7.1) every
    // SES call in `src/ses/` authenticates as. Railway is not AWS compute, so
    // there is no instance role to assume and no OIDC federation — a static,
    // narrowly-scoped key is the honest answer.
    //
    // OPTIONAL, and their absence is a MODE rather than a misconfiguration:
    // with NEITHER set the control plane boots exactly as it does today and
    // the SES factory yields the deterministic Fake. That is the supported
    // default — Hogsend Email is optional — and it mirrors what the engine
    // already does for a missing `RESEND_API_KEY`.
    //
    // Optional as a PAIR, though: exactly one set is a misconfiguration, never
    // a mode. The refusal lives at the point of use in `src/ses/index.ts`
    // (`readCredentials` — both present ⇒ AWS, neither ⇒ Fake, one ⇒ throw),
    // the same posture `CLOUD_RAILWAY_TOKEN` and the registry credential pair
    // already take in this file. NEVER logged: the factory logs which client
    // is live, never the key it holds.
    CLOUD_AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    CLOUD_AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    // The SNS topic each region's SES configuration sets publish delivery,
    // bounce, complaint and delay events to (PRD 05). One per region, because
    // SES tenants are region-scoped and do not replicate; the tenant is
    // identified by the event's own tag, not by the topic.
    //
    // OPTIONAL, and absence is a MODE: with no topic the provisioner skips the
    // event destination and the control plane behaves exactly as it does
    // today. It is NOT a permissive default — the ingress endpoint refuses
    // EVERY message when its region has no configured topic, because AWS's own
    // guidance is to reject an unexpected `TopicArn` and with none configured
    // there is no expected one.
    CLOUD_SES_SNS_TOPIC_ARN_US: z.string().min(1).optional(),
    CLOUD_SES_SNS_TOPIC_ARN_EU: z.string().min(1).optional(),
    // The shared secret the EventBridge API destination's connection sends on
    // every SES reputation event (PRD 08). ONE secret, not one per region: a
    // reputation event names its own tenant and the tenant resolves to the
    // region, so there is nothing regional for the credential to separate.
    //
    // OPTIONAL, and absence is NOT a permissive default: the ingress refuses
    // EVERY event when it has no secret to authenticate them against. An
    // endpoint that accepted anything until somebody remembered to configure it
    // would be a stop-any-tenant button on the public internet for exactly as
    // long as that took. NEVER logged.
    CLOUD_SES_EVENTBRIDGE_SECRET: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  // `next build` evaluates every route module to collect page data, with
  // NODE_ENV=production and none of the deploy's runtime secrets present — so a
  // required var would fail the BUILD for a value only the RUNTIME needs. The
  // build script sets this; a real boot never does, so production still fails
  // fast on a missing CLOUD_DATABASE_URL.
  skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
});

/** The four bucket variables that only make sense as a complete set. */
const ARTIFACT_BUCKET_VAR_NAMES = [
  "CLOUD_ARTIFACT_BUCKET_ENDPOINT",
  "CLOUD_ARTIFACT_BUCKET_NAME",
  "CLOUD_ARTIFACT_BUCKET_ACCESS_KEY_ID",
  "CLOUD_ARTIFACT_BUCKET_SECRET_ACCESS_KEY",
] as const;

/** A fully-resolved artifact bucket: everything an S3 client needs. */
export interface ArtifactBucketConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * The bucket configuration, resolved all-or-nothing.
 *
 * Returns the full config when every variable is present, `undefined` when
 * none are, and THROWS on anything in between — a half-configured bucket must
 * never fall back to local disk, because silently falling back is exactly the
 * cross-container failure PRD 14 exists to prevent. The error names the
 * missing variables (names only; values are credentials and are never
 * logged).
 *
 * Pure over its input so the boot guard below and its tests share one
 * implementation; `artifactBucketConfig()` binds it to the validated env.
 */
export function resolveArtifactBucketConfig(vars: {
  CLOUD_ARTIFACT_BUCKET_ENDPOINT?: string;
  CLOUD_ARTIFACT_BUCKET_NAME?: string;
  CLOUD_ARTIFACT_BUCKET_ACCESS_KEY_ID?: string;
  CLOUD_ARTIFACT_BUCKET_SECRET_ACCESS_KEY?: string;
  CLOUD_ARTIFACT_BUCKET_REGION?: string;
}): ArtifactBucketConfig | undefined {
  const missing = ARTIFACT_BUCKET_VAR_NAMES.filter((name) => !vars[name]);
  if (missing.length === ARTIFACT_BUCKET_VAR_NAMES.length) return undefined;
  if (missing.length > 0) {
    throw new Error(
      `artifact bucket configuration is incomplete — missing ${missing.join(
        ", ",
      )}. Set all of ${ARTIFACT_BUCKET_VAR_NAMES.join(
        ", ",
      )} or none: a partial set never falls back to the local-disk store.`,
    );
  }
  return {
    // biome-ignore lint/style/noNonNullAssertion: emptiness checked above
    endpoint: vars.CLOUD_ARTIFACT_BUCKET_ENDPOINT!,
    // biome-ignore lint/style/noNonNullAssertion: emptiness checked above
    bucket: vars.CLOUD_ARTIFACT_BUCKET_NAME!,
    region: vars.CLOUD_ARTIFACT_BUCKET_REGION ?? "us-east-1",
    // biome-ignore lint/style/noNonNullAssertion: emptiness checked above
    accessKeyId: vars.CLOUD_ARTIFACT_BUCKET_ACCESS_KEY_ID!,
    // biome-ignore lint/style/noNonNullAssertion: emptiness checked above
    secretAccessKey: vars.CLOUD_ARTIFACT_BUCKET_SECRET_ACCESS_KEY!,
  };
}

/** The validated env's bucket config — what `getArtifactStore()` selects on. */
export function artifactBucketConfig(): ArtifactBucketConfig | undefined {
  return resolveArtifactBucketConfig(env);
}

// The artifact-store boot guard, in the same place every other production
// misconfiguration fails: at env import, before a single request or task
// runs. Two refusals:
//
//  - a PARTIAL bucket set throws in EVERY environment (inside
//    `resolveArtifactBucketConfig`), because "three of four vars" is always a
//    mistake, never a mode;
//  - NO bucket in production throws, because the local-disk store cannot work
//    there — the upload is received by cloud-app and the build executes on
//    cloud-worker, separate containers with separate ephemeral filesystems
//    and no shared volume, so the builder would never find the artifact.
//
// Dev and test run with no bucket and never reach the second throw; `next
// build` is covered by the same `skipValidation` escape hatch as the schema
// (build-time evaluation carries none of the deploy's runtime secrets).
/** A fully-resolved sandbox build host: everything the session needs. */
export interface SandboxBuildHostConfig {
  /** The Railway workspace token the sandbox mutations authenticate with. */
  token: string;
  /** The Railway environment sandboxes are created in. */
  environmentId: string;
  region?: string;
  idleTimeoutMinutes: number;
}

/**
 * The sandbox build-host configuration, resolved all-or-nothing — the same
 * posture `resolveArtifactBucketConfig` established. Returns `undefined`
 * when `CLOUD_BUILD_HOST` is `local`, the full config when everything the
 * sandbox needs is present, and THROWS on anything in between:
 *
 *  - no `CLOUD_RAILWAY_TOKEN` — the sandbox mutations have nothing to
 *    authenticate with;
 *  - no `CLOUD_BUILD_SANDBOX_ENVIRONMENT_ID` — nowhere to create one;
 *  - no artifact bucket (`hasBucket`) — the artifact enters the sandbox by
 *    PRESIGNED DOWNLOAD, which only the S3 store can mint, so a sandbox
 *    host over the local-disk store would fail on the first build's first
 *    command. A configuration error must be a boot error, not a runtime
 *    surprise.
 *
 * Pure over its inputs so the boot guard and the tests share one
 * implementation; `sandboxBuildHostConfig()` binds it to the validated env.
 */
export function resolveSandboxBuildHostConfig(
  vars: {
    CLOUD_BUILD_HOST: "local" | "sandbox";
    CLOUD_RAILWAY_TOKEN?: string;
    CLOUD_BUILD_SANDBOX_ENVIRONMENT_ID?: string;
    CLOUD_BUILD_SANDBOX_REGION?: string;
    CLOUD_BUILD_SANDBOX_IDLE_TIMEOUT_MINUTES?: number;
  },
  hasBucket: boolean,
): SandboxBuildHostConfig | undefined {
  if (vars.CLOUD_BUILD_HOST !== "sandbox") return undefined;

  const missing = [
    ...(vars.CLOUD_RAILWAY_TOKEN ? [] : ["CLOUD_RAILWAY_TOKEN"]),
    ...(vars.CLOUD_BUILD_SANDBOX_ENVIRONMENT_ID
      ? []
      : ["CLOUD_BUILD_SANDBOX_ENVIRONMENT_ID"]),
    ...(hasBucket
      ? []
      : [`an artifact bucket (${ARTIFACT_BUCKET_VAR_NAMES.join(", ")})`]),
  ];
  if (missing.length > 0) {
    throw new Error(
      `CLOUD_BUILD_HOST=sandbox is missing ${missing.join(
        ", ",
      )}. The sandbox build host needs a Railway token, an environment to ` +
        "create sandboxes in, and an S3 artifact bucket (the sandbox " +
        "downloads the artifact from a presigned URL). Set them all, or " +
        "CLOUD_BUILD_HOST=local — a partial set never falls back silently.",
    );
  }
  return {
    // biome-ignore lint/style/noNonNullAssertion: emptiness checked above
    token: vars.CLOUD_RAILWAY_TOKEN!,
    // biome-ignore lint/style/noNonNullAssertion: emptiness checked above
    environmentId: vars.CLOUD_BUILD_SANDBOX_ENVIRONMENT_ID!,
    ...(vars.CLOUD_BUILD_SANDBOX_REGION
      ? { region: vars.CLOUD_BUILD_SANDBOX_REGION }
      : {}),
    idleTimeoutMinutes: vars.CLOUD_BUILD_SANDBOX_IDLE_TIMEOUT_MINUTES ?? 60,
  };
}

/** The validated env's sandbox build host — what the build runner selects
 * on. `undefined` = the local `spawnExec` path, unchanged. */
export function sandboxBuildHostConfig(): SandboxBuildHostConfig | undefined {
  return resolveSandboxBuildHostConfig(
    env,
    resolveArtifactBucketConfig(env) !== undefined,
  );
}

if (process.env.SKIP_ENV_VALIDATION !== "true") {
  const bucket = resolveArtifactBucketConfig(env);
  // The sandbox build host fails at BOOT on a partial configuration, for the
  // bucket guard's reason: every var here is load-bearing for the first real
  // publish, and discovering the gap then means a customer discovered it.
  resolveSandboxBuildHostConfig(env, bucket !== undefined);
  if (env.NODE_ENV === "production" && !bucket) {
    throw new Error(
      `NODE_ENV=production requires an artifact bucket: set ${ARTIFACT_BUCKET_VAR_NAMES.join(
        ", ",
      )}. The local-disk artifact store cannot work in production — uploads ` +
        "land on cloud-app and builds execute on cloud-worker, separate " +
        "containers with separate ephemeral filesystems and no shared " +
        "volume, so the builder would never find the artifact.",
    );
  }
}
