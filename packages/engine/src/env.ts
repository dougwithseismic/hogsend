import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const API_VERSION = "0.0.1";

export const env = createEnv({
  server: {
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    PORT: z.coerce.number().default(3002),
    LOG_LEVEL: z
      .enum(["error", "warn", "info", "http", "debug"])
      .default("info"),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
    BETTER_AUTH_SECRET: z.string().min(1),
    BETTER_AUTH_URL: z.string().url().default("http://localhost:3002"),
    // Extra origins allowed to call the auth endpoints (beyond BETTER_AUTH_URL),
    // comma-separated. Needed when the Studio is served from a different origin
    // than the API — e.g. the `hogsend studio` CLI pointing at a remote instance.
    BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
    RESEND_API_KEY: z.string().min(1),
    RESEND_FROM_EMAIL: z.string().email().default("noreply@hogsend.com"),
    // Hatchet connection contract. The @hatchet-dev SDK also reads these straight
    // from process.env via its own config-loader, so this schema is a presence /
    // shape check that keeps the contract in one place — the values still flow to
    // the SDK independently. We pass token/host_port/tls/namespace explicitly into
    // HatchetClient.init() (see lib/hatchet.ts) so env.ts is the source of truth.
    //
    // Step 1 of onboarding is "acquire a Hatchet": grab HATCHET_CLIENT_TOKEN from
    // Hatchet Cloud or the local hatchet-lite dashboard (:8888 → Settings → API
    // Tokens) and set it yourself. This is the bring-your-own-token contract; there
    // is no auto-mint.
    HATCHET_CLIENT_TOKEN: z.string().min(1),
    HATCHET_CLIENT_HOST_PORT: z.string().min(1).default("localhost:7077"),
    // Secure by default: `tls` matches the SDK and Hatchet Cloud. The local
    // insecure hatchet-lite path explicitly overrides to `none` in compose/.env —
    // we never default to plaintext gRPC.
    HATCHET_CLIENT_TLS_STRATEGY: z.enum(["none", "tls", "mtls"]).default("tls"),
    // Future per-tenant isolation knob (one shared Hatchet engine, namespaced
    // tasks). Default-empty today; documented so it stays part of the contract.
    HATCHET_CLIENT_NAMESPACE: z.string().optional(),
    // Emergency boot-guard bypass, read raw in apps/api/src/index.ts. Declared
    // here so it is part of the validated env contract (single source of truth).
    SKIP_SCHEMA_CHECK: z.coerce.boolean().default(false),
    // Client-migration track folder, read raw in @hogsend/db migrate-client.ts
    // (the db package can't depend on engine). Declared here for contract parity.
    CLIENT_MIGRATIONS_FOLDER: z.string().min(1).optional(),
    POSTHOG_API_KEY: z.string().min(1).optional(),
    POSTHOG_HOST: z.string().url().optional(),
    POSTHOG_WEBHOOK_SECRET: z.string().min(1).optional(),
    RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
    ADMIN_API_KEY: z.string().min(1).optional(),
    API_PUBLIC_URL: z.string().url().default("http://localhost:3002"),
    ENABLED_JOURNEYS: z.string().default("*"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
