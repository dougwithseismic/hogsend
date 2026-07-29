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
    // OPTIONAL. Absent → OTP codes go to the server log (`logSender`). Present
    // → they are emailed through Resend. Tests never set it, so no test can
    // reach the network.
    CLOUD_RESEND_API_KEY: z.string().min(1).optional(),
    // From-address for the Resend transport. Only read when a key is set.
    CLOUD_RESEND_FROM: z
      .string()
      .min(1)
      .default("Hogsend <no-reply@hogsend.com>"),
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
    // The stock scaffold image tag a freshly provisioned stack boots on
    // (`hogsend-default:<engine-version>`, PRD 04 "Initial deploy source").
    // Recorded on the stack row at provision time, so a later bump does not
    // rewrite what an existing stack is actually running.
    CLOUD_DEFAULT_ENGINE_VERSION: z.string().min(1).default("0.56.0"),
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
