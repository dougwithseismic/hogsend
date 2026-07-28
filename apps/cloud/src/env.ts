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
