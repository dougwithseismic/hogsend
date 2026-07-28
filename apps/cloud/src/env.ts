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
