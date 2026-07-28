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
