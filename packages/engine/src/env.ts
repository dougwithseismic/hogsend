import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { addrSpecOf } from "./lib/from-address.js";

// A from address may be bare ("doug@hogsend.com") or carry a display name
// ("Doug at Hogsend <doug@hogsend.com>") — both are valid provider wire
// formats. Domain derivation (lib/from-address.ts) parses either form.
const fromAddress = z.string().refine((value) => addrSpecOf(value) !== null, {
  message: 'Must be an email address or "Display Name <email>"',
});

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
    // --- First-admin bootstrap (replaces the web setup-token land-grab) ---
    // Public sign-up is DISABLED (lib/auth.ts `disableSignUp`), so admins are
    // created ONLY by the CLI (`hogsend studio admin create`) or this boot-time
    // bootstrap. When STUDIO_ADMIN_EMAIL is set AND the user table is empty, the
    // API process mints this admin on boot (idempotent — only on 0 users).
    STUDIO_ADMIN_EMAIL: z.string().email().optional(),
    // Optional password for the bootstrap admin. When set, it is used verbatim
    // and NEVER logged. When omitted (but STUDIO_ADMIN_EMAIL is set), the engine
    // auto-generates a strong password and prints it ONCE to the server log
    // (the single intended secret-logging exception) — rotate it immediately via
    // the Studio forgot/reset flow. Min length matches better-auth's policy.
    STUDIO_ADMIN_PASSWORD: z.string().min(8).optional(),
    // --- First-boot data-plane key bootstrap (lib/boot-api-key.ts) ---
    // When the api_keys table is COMPLETELY empty on API boot (a template
    // deploy that never ran the local `pnpm bootstrap`), the engine mints one
    // ingest-scoped key ("bootstrap-ingest") and prints the FULL key ONCE to
    // the server log — the data-plane sibling of the first-admin password
    // above. Set "false" to opt out. A string enum (not z.coerce.boolean) so
    // an explicit "false" actually disables it.
    HOGSEND_BOOTSTRAP_API_KEY: z.enum(["true", "false"]).default("true"),
    // Extra origins allowed to call the auth endpoints (beyond BETTER_AUTH_URL),
    // comma-separated. Needed when the Studio is served from a different origin
    // than the API — e.g. the `hogsend studio` CLI pointing at a remote instance.
    BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
    // Cookie NAMESPACE for the engine's own Better Auth (the Studio/dogfood at
    // e.g. t.hogsend.com). Better Auth derives the session cookie name as
    // `<__Secure->?<prefix>.session_token`; with Better Auth's default
    // "better-auth" prefix the engine cookie shares a NAME with any sibling web
    // app that sets a cross-subdomain cookie on the shared parent (e.g.
    // course/docs on `.hogsend.com`), which the browser also delivers to the
    // Studio host — same name, DIFFERENT database → null session → Studio login
    // loop. Defaulting to "hogsend" gives the engine its own namespace
    // (__Secure-hogsend.session_token) so that sibling cookie is simply ignored
    // here. MUST stay optional-with-default — a required value would fail env
    // validation on every deploy that doesn't set it. Prefix affects the cookie
    // NAME only; it is orthogonal to crossSubDomainCookies (the Domain attr),
    // which the engine never sets (host-only).
    AUTH_COOKIE_PREFIX: z.string().min(1).default("hogsend"),
    // Optional: a deploy may run a non-Resend provider (Postmark, SES…) and set
    // no Resend key at all. Read directly ONLY in the lazy-resend default branch
    // (container.ts) and the future `emailProvidersFromEnv` preset. With this
    // optional, a Postmark-only deploy boots without a Resend key.
    RESEND_API_KEY: z.string().min(1).optional(),
    RESEND_FROM_EMAIL: fromAddress.default("noreply@hogsend.com"),
    // --- Provider-neutral email config (BYO email provider) ---
    // The active email provider id the container resolves from the
    // EmailProviderRegistry. Absent → "resend" (today's byte-for-byte default).
    EMAIL_PROVIDER: z.string().optional(),
    // Neutral default-from address. The mailer's `defaultFrom` is
    // `EMAIL_FROM ?? RESEND_FROM_EMAIL`, so an unset EMAIL_FROM keeps today's
    // Resend-named default.
    EMAIL_FROM: fromAddress.optional(),
    // The sending domain the domain-status service reports on. OVERRIDES the
    // default derivation (host part of EMAIL_FROM, falling back to the host of
    // RESEND_FROM_EMAIL) — set it when you send from a subaddress domain that
    // differs from the one registered at the provider.
    EMAIL_DOMAIN: z.string().optional(),
    // --- Test mode (provider-neutral send redirect) ---
    // Controls whether the engine redirects every send to a safe inbox while the
    // sending domain isn't verified yet:
    //   auto  (default) — test mode iff the active provider supports domains AND
    //                      an EMAIL_DOMAIN is configured AND it is UNVERIFIED per
    //                      the cached DomainStatusService. Fail-OPEN: a cache miss
    //                      or provider outage resolves to LIVE (never silently
    //                      redirects prod mail). With no domains capability or no
    //                      EMAIL_DOMAIN, `auto` stays LIVE — existing deploys are
    //                      unaffected.
    //   true            — always redirect (reason: "env_flag").
    //   false           — never redirect, even with an unverified domain.
    HOGSEND_TEST_MODE: z.enum(["auto", "true", "false"]).default("auto"),
    // The safe inbox every redirected send is delivered to in test mode. Falls
    // back to STUDIO_ADMIN_EMAIL when unset; when NEITHER resolves while test
    // mode is active, the send is BLOCKED (recorded, never delivered to the real
    // recipient) with a loud, actionable log.
    HOGSEND_TEST_EMAIL: z.string().email().optional(),
    // --- Postmark (opt-in BYO provider) ---
    // Postmark stays OPT-IN: a preset is built only when POSTMARK_SERVER_TOKEN
    // is present, and it NEVER changes the default active provider — set
    // EMAIL_PROVIDER=postmark to activate it. Postmark has no HMAC, so webhook
    // authenticity is HTTP Basic creds in the webhook URL — fail-closed when
    // unset (status updates rejected).
    POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
    // Postmark ACCOUNT token (X-Postmark-Account-Token) — unlocks the Domains
    // API capability on the Postmark provider. Optional: without it the
    // provider still sends, it just can't manage sending domains
    // (`supported: false` on /v1/admin/domain).
    POSTMARK_ACCOUNT_TOKEN: z.string().min(1).optional(),
    POSTMARK_MESSAGE_STREAM: z.string().min(1).optional(),
    POSTMARK_WEBHOOK_USER: z.string().min(1).optional(),
    POSTMARK_WEBHOOK_PASS: z.string().min(1).optional(),
    // --- SMS channel (provider-neutral, BYO SMS provider) ---
    // The active SMS provider id the container resolves from the
    // SmsProviderRegistry. Absent → "twilio" when a provider is registered;
    // with no provider configured the SMS service is an inert throwing stub.
    SMS_PROVIDER: z.string().optional(),
    // Neutral E.164 default-from number the tracked SMS sender uses when a send
    // omits `from` and no messaging-service is pinned.
    SMS_FROM: z.string().optional(),
    // The safe phone every redirected SMS is delivered to under
    // HOGSEND_TEST_MODE=true. When unset while test mode is active, the send is
    // BLOCKED (recorded, never delivered to the real recipient).
    HOGSEND_TEST_PHONE: z.string().optional(),
    // SMS link shortening/tracking is ON by default when SMS is configured.
    // An enum, NOT z.coerce.boolean — an explicit "false" must actually
    // disable (coerce treats the string "false" as true; HOGSEND_TEST_MODE
    // precedent).
    SMS_LINK_TRACKING: z.enum(["true", "false"]).default("true"),
    // Full origin short links are minted under (e.g. https://hs.example.com —
    // a branded short domain routed to this app). Falls back to
    // API_PUBLIC_URL; the /s/:code route serves either way.
    SMS_LINK_HOST: z.string().url().optional(),
    // --- Twilio (default SMS provider, opt-in) ---
    // A preset provider is built only when BOTH SID + token are present (the
    // guarded dynamic import in sms-providers-from-env.ts). One of SMS_FROM /
    // TWILIO_MESSAGING_SERVICE_SID must also be set for sends to succeed.
    TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
    TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
    TWILIO_MESSAGING_SERVICE_SID: z.string().min(1).optional(),
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
    // Personal API key (scoped `person:read`, optionally `person:write`) for
    // person-property READS on the private API. The phc_ project key cannot
    // read — it is public + write-only by PostHog's design. Without this,
    // person reads soft-fail and timezone resolution falls back to contact
    // properties. See the "Analytics access" docs page.
    POSTHOG_PERSONAL_API_KEY: z.string().min(1).optional(),
    // PostHog project id for environment-scoped private endpoints. Discovered
    // automatically via GET /api/projects/@current/ when unset.
    POSTHOG_PROJECT_ID: z.string().min(1).optional(),
    // Private (app) API host override. Defaults to POSTHOG_HOST with the
    // `.i.` ingestion label stripped (eu.i.posthog.com → eu.posthog.com).
    POSTHOG_PRIVATE_HOST: z.string().url().optional(),
    // Selects the ACTIVE analytics provider id out of the registry (env
    // presets + consumer-registered providers). Mirrors EMAIL_PROVIDER.
    ANALYTICS_PROVIDER: z.string().min(1).default("posthog"),
    // Override for the ingest→analytics event mirror (capture every ingested
    // event into the active analytics provider, keyed to the resolved contact).
    // The code option `analytics.eventMirror.enabled` is the default; this env,
    // when set, OVERRIDES it in both directions. Enum (not z.coerce.boolean) so
    // an explicit "false" actually disables (coerce.boolean treats "false" as
    // true). Unset ⇒ the code option wins. Allow/deny lists stay code-only.
    ANALYTICS_EVENT_MIRROR: z.enum(["true", "false"]).optional(),
    POSTHOG_WEBHOOK_SECRET: z.string().min(1).optional(),
    // When true AND POSTHOG_API_KEY is set, the engine idempotently auto-seeds
    // ONE kind="posthog" webhook endpoint subscribed to the email funnel so the
    // full email lifecycle fans out to PostHog DURABLY (on the delivery spine).
    // Default OFF to avoid a surprise double-emit alongside the existing
    // fire-and-forget PostHog capture path.
    ENABLE_POSTHOG_DESTINATION: z.coerce.boolean().default(false),
    /**
     * Append a short-lived signed identity token (`hs_t`) to tracked-link
     * redirect destinations, so the landing site can stitch the email click
     * to its web session (`POST /v1/t/identify` + posthog.identify). Opt-in:
     * it changes outbound URLs, which can break pre-signed destinations.
     */
    TRACKING_IDENTITY_TOKEN: z.coerce.boolean().default(false),
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
    // Shared internal secret authenticating the gateway-worker → connector
    // ingress hop (`POST /v1/connectors/:id/ingress`). Fail-CLOSED when unset
    // (the route 401s), so a gateway worker cannot relay without it. MUST be
    // high-entropy — generate with `openssl rand -base64 32`.
    CONNECTOR_INGRESS_SECRET: z.string().min(32).optional(),
    // --- Connector runtimes (inline gateway sockets) ---
    // The long-lived inbound socket for gateway-transport connectors (Discord)
    // runs INLINE inside the host process below, gated by a Redis leader lease so
    // exactly ONE replica holds it. Auto-on: a registered gateway connector +
    // its bot token present is enough. Enum (not z.coerce.boolean) so an explicit
    // "false" actually disables it (z.coerce.boolean treats "false" as true).
    ENABLE_CONNECTOR_RUNTIMES: z.enum(["true", "false"]).default("true"),
    // Which already-deployed process hosts the inline runtime. "worker" (default)
    // is the committed home; "standalone" defers to the advanced discord-worker
    // entry; "api" is reserved (host it yourself via startConnectorRuntimes).
    CONNECTOR_RUNTIME_HOST: z
      .enum(["worker", "api", "standalone"])
      .default("worker"),
    // --- Outbound destination presets (Phase 3) ---
    // Which `defineDestination()` PRESETS are registered into the process
    // destination registry the delivery task resolves by `endpoint.kind`. csv of
    // ids (e.g. "segment,slack"), `"*"` (all presets), or `"none"`. Absent → the
    // DEFAULT set (webhook + posthog). The `webhook` and `posthog` presets are
    // ALWAYS registered regardless of this value, so the no-regression delivery
    // path can never be turned off by misconfiguration. Set this to add the
    // segment/slack presets (credentials still live per-endpoint in `config`).
    ENABLED_DESTINATION_PRESETS: z.string().optional(),
    // --- Studio co-working agent (GLM-5.2 via OpenRouter) ---
    // The agent route (`/v1/admin/agent/*`) is FAIL-CLOSED on this key: with no
    // OPENROUTER_API_KEY the `/config` probe reports `enabled:false` and `/chat`
    // 503s, so the Studio panel renders a calm "agent not configured" state and
    // never ships the key to the browser. Get one at openrouter.ai/keys.
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    // The OpenRouter model id the agent runs on. Default is GLM-5.2 (z-ai), a
    // 1M-context agentic-coding model well-suited to tool use; swap freely
    // (e.g. z-ai/glm-4.6 as a battle-tested fallback) without code changes.
    AGENT_MODEL: z.string().min(1).default("z-ai/glm-5.2"),
    // Master switch. Enum (not z.coerce.boolean) so an explicit "false" disables.
    // EFFECTIVE-enabled also requires OPENROUTER_API_KEY, so this defaults "true"
    // yet stays zero-cost-off until a key is set.
    AGENT_ENABLED: z.enum(["true", "false"]).default("true"),
    // Hard cap on the agent's tool-use loop per chat turn (GLM-5.2 handles long
    // multi-step loops; this bounds runaway cost). Read in routes/admin/agent.ts.
    AGENT_MAX_STEPS: z.coerce.number().int().positive().default(24),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
