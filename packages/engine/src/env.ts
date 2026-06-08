import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * The HTTP API contract version — surfaced in the OpenAPI document
 * (`info.version`) and the `GET /v1/health` body. This is the WIRE contract
 * version and is independent of the `@hogsend/engine` npm package version: bump
 * it only on an API-breaking change (a new `/vN` route family), NOT on every
 * package release. The `/v1` route prefix is hardcoded separately.
 */
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
    // Closes the first-run land-grab on the web first-admin create. When set,
    // the Studio "create admin" form must present this exact value (header
    // `x-hogsend-setup-token`) before the first sign-up is allowed; the engine
    // compares it in constant time, server-side. When UNSET and `needsSetup` is
    // true, the engine auto-generates a process-lifetime token and prints it
    // ONCE to the server log (operator-only surface). Never returned over HTTP.
    // Irrelevant once an admin exists (closed-signup 403 takes over).
    STUDIO_SETUP_TOKEN: z.string().optional(),
    // Extra origins allowed to call the auth endpoints (beyond BETTER_AUTH_URL),
    // comma-separated. Needed when the Studio is served from a different origin
    // than the API — e.g. the `hogsend studio` CLI pointing at a remote instance.
    BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
    // Optional: a deploy may run a non-Resend provider (Postmark, SES…) and set
    // no Resend key at all. Read directly ONLY in the lazy-resend default branch
    // (container.ts) and the future `emailProvidersFromEnv` preset. With this
    // optional, a Postmark-only deploy boots without a Resend key.
    RESEND_API_KEY: z.string().min(1).optional(),
    RESEND_FROM_EMAIL: z.string().email().default("noreply@hogsend.com"),
    // --- Provider-neutral email config (BYO email provider) ---
    // The active email provider id the container resolves from the
    // EmailProviderRegistry. Absent → "resend" (today's byte-for-byte default).
    EMAIL_PROVIDER: z.string().optional(),
    // Neutral default-from address. The mailer's `defaultFrom` is
    // `EMAIL_FROM ?? RESEND_FROM_EMAIL`, so an unset EMAIL_FROM keeps today's
    // Resend-named default.
    EMAIL_FROM: z.string().email().optional(),
    // --- Postmark (opt-in BYO provider) ---
    // Postmark stays OPT-IN: a preset is built only when POSTMARK_SERVER_TOKEN
    // is present, and it NEVER changes the default active provider — set
    // EMAIL_PROVIDER=postmark to activate it. Postmark has no HMAC, so webhook
    // authenticity is HTTP Basic creds in the webhook URL — fail-closed when
    // unset (status updates rejected).
    POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
    POSTMARK_MESSAGE_STREAM: z.string().min(1).optional(),
    POSTMARK_WEBHOOK_USER: z.string().min(1).optional(),
    POSTMARK_WEBHOOK_PASS: z.string().min(1).optional(),
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
    // When true AND POSTHOG_API_KEY is set, the engine idempotently auto-seeds
    // ONE kind="posthog" webhook endpoint subscribed to the email funnel so the
    // full email lifecycle fans out to PostHog DURABLY (on the delivery spine).
    // Default OFF to avoid a surprise double-emit alongside the existing
    // fire-and-forget PostHog capture path.
    ENABLE_POSTHOG_DESTINATION: z.coerce.boolean().default(false),
    RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
    ADMIN_API_KEY: z.string().min(1).optional(),
    API_PUBLIC_URL: z.string().url().default("http://localhost:3002"),
    ENABLED_JOURNEYS: z.string().default("*"),
    // Buckets: same `"*"`-or-csv contract as ENABLED_JOURNEYS (Section 9.3).
    // Evaluated at worker boot — a toggle requires a worker restart; only the
    // bucket_configs DB override is hot.
    ENABLED_BUCKETS: z.string().default("*"),
    // Email lists (D3): same `"*"`-or-csv contract as ENABLED_JOURNEYS /
    // ENABLED_BUCKETS. Filters which `defineList()` lists are registered into the
    // process ListRegistry (the suppression-polarity + preference-center source).
    ENABLED_LISTS: z.string().default("*"),
    // Cadence for the engine-owned bucket reconcile cron (time-based leaves).
    BUCKET_RECONCILE_CRON: z.string().default("*/5 * * * *"),
    // --- Outbound webhooks (Section 1.5/1.8) ---
    // Cadence for the engine-owned outbound-delivery reaper cron (the retry
    // scheduler + orphan-`sending` recovery). Declared for parity with
    // BUCKET_RECONCILE_CRON; the delivery task also reads it raw off process.env.
    OUTBOUND_WEBHOOK_REAPER_CRON: z.string().optional(),
    // Delivery tunables — read raw off process.env inside the durable task;
    // declared here so they are part of the validated env contract. All optional
    // with task-internal defaults (MAX_ATTEMPTS 8, TIMEOUT 15s, BASE 5s,
    // MAX_DELAY 6h, STUCK_AFTER 5min).
    OUTBOUND_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().optional(),
    OUTBOUND_WEBHOOK_TIMEOUT_MS: z.coerce.number().optional(),
    OUTBOUND_WEBHOOK_BASE_DELAY_MS: z.coerce.number().optional(),
    OUTBOUND_WEBHOOK_MAX_DELAY_MS: z.coerce.number().optional(),
    OUTBOUND_WEBHOOK_STUCK_AFTER_MS: z.coerce.number().optional(),
    // --- Integration presets (Section 2.2) ---
    // Signature-source secrets. The webhook route resolves a preset's secret via
    // env[source.auth.envKey]; a signature source FAILS CLOSED when its secret is
    // unset. Setting one auto-enables that preset at POST /v1/webhooks/<id>.
    CLERK_WEBHOOK_SECRET: z.string().min(1).optional(),
    SUPABASE_WEBHOOK_SECRET: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    SEGMENT_WEBHOOK_SECRET: z.string().min(1).optional(),
    // Preset enablement override: csv of preset ids, `"*"` (all with a secret),
    // or `"none"`. Absent → auto-enable any preset whose secret is set.
    ENABLED_WEBHOOK_PRESETS: z.string().optional(),
    // --- Outbound destination presets (Phase 3) ---
    // Which `defineDestination()` PRESETS are registered into the process
    // destination registry the delivery task resolves by `endpoint.kind`. csv of
    // ids (e.g. "segment,slack"), `"*"` (all presets), or `"none"`. Absent → the
    // DEFAULT set (webhook + posthog). The `webhook` and `posthog` presets are
    // ALWAYS registered regardless of this value, so the no-regression delivery
    // path can never be turned off by misconfiguration. Set this to add the
    // segment/slack presets (credentials still live per-endpoint in `config`).
    ENABLED_DESTINATION_PRESETS: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
