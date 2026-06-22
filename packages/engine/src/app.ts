import { user } from "@hogsend/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { ErrorHandler, MiddlewareHandler } from "hono/types";
import { connectorsFromEnv } from "./connectors/presets/index.js";
import type { HogsendClient } from "./container.js";
import { API_VERSION } from "./env.js";
import type { Auth } from "./lib/auth.js";
import { mountStudio } from "./lib/studio.js";
import type { ApiKeyContext } from "./middleware/api-key.js";
import { errorHandler } from "./middleware/error-handler.js";
import { clientIpKey, createRateLimit } from "./middleware/rate-limit.js";
import { requestLogger } from "./middleware/request-logger.js";
import { registerRoutes } from "./routes/index.js";
import {
  type DefinedWebhookSource,
  webhookSourceToConnector,
} from "./webhook-sources/define-webhook-source.js";

type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;

export type AppEnv = {
  Variables: {
    container: HogsendClient;
    requestId: string;
    user: NonNullable<AuthSession>["user"] | null;
    session: NonNullable<AuthSession>["session"] | null;
    apiKey: ApiKeyContext | undefined;
  };
};

/** A function that mounts custom routers onto the app after the built-in routes. */
export type RoutesFn = (app: OpenAPIHono<AppEnv>) => void;

export interface CreateAppOptions {
  /**
   * Mount custom routers after the built-in routes. Accepts a single function or
   * an array — each is applied in order, so a consumer can compose its own
   * routes with e.g. `cc.routes` without clobbering: `routes: [existing,
   * cc.routes]`.
   */
  routes?: RoutesFn | RoutesFn[];
  /** Extra middleware applied after the built-in stack. */
  middleware?: MiddlewareHandler[];
  /** Webhook sources served at `/v1/webhooks/:sourceId`. */
  webhookSources?: DefinedWebhookSource[];
  /**
   * Auto-enable the shipped integration presets (Clerk, Supabase, Stripe,
   * Segment) for every preset whose env secret is configured (gated further by
   * `ENABLED_WEBHOOK_PRESETS`). Consumer-supplied `webhookSources` always win on
   * an id collision. Set `false` to opt out entirely. Default `true`.
   *
   * @deprecated prefer `createHogsendClient({ enablePresets })` — preset
   * resolution now lives in the container's connector registry. This flag is
   * STILL HONORED end-to-end: when `false`, `createApp` strips the env-preset
   * ids back out of the already-built registry, so the opt-out is NOT a silent
   * no-op.
   */
  enablePresets?: boolean;
  /** Override the default error handler. */
  onError?: ErrorHandler<AppEnv>;
}

export function createApp(
  container: HogsendClient,
  opts: CreateAppOptions = {},
) {
  const app = new OpenAPIHono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("container", container);
    await next();
  });

  app.use("*", secureHeaders());
  app.use("*", cors());
  app.use("*", compress());
  app.use("*", requestId());
  app.use("*", requestLogger);

  for (const mw of opts.middleware ?? []) {
    app.use("*", mw);
  }

  app.onError(opts.onError ?? errorHandler);

  app.notFound((c) => {
    return c.json({ error: "Not Found" }, 404);
  });

  // Belt-and-suspenders throttle on the sign-up path. Public sign-up is now
  // CLOSED at the better-auth layer (`disableSignUp: true` in lib/auth.ts ⇒ the
  // now-ungated POST /api/auth/sign-up/email returns 400
  // EMAIL_PASSWORD_SIGN_UP_DISABLED), so there is no token to brute-force here.
  // We KEEP this IP-keyed sliding window anyway: it cheaply drops a flood at the
  // edge before it reaches better-auth's handler (defence in depth, and it caps
  // any future credential-probing on this path). Keyed by client IP because
  // sign-up is unauthenticated — every request would otherwise collapse onto one
  // "anonymous" bucket. `disableInTest: false` so the suite can still assert the
  // 429. Distinct prefix → isolated budget.
  const signUpRateLimit = createRateLimit({
    prefix: "ratelimit:signup",
    windowMs: 60_000,
    max: 10,
    keyFn: clientIpKey,
    disableInTest: false,
  });
  app.use("/api/auth/sign-up/*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return signUpRateLimit(c, next);
  });

  app.on(["POST", "GET"], "/api/auth/*", (c) => {
    const { auth } = c.get("container");
    return auth.handler(c.req.raw);
  });

  // Public bootstrap probe: tells the Studio whether to show the first-run
  // "no admin yet" INFO screen (no users yet) instead of the login screen.
  // Returns ONLY `{ needsSetup }`. Since public sign-up is closed, the Studio's
  // zero-user state offers NO network path to create a user — the info screen
  // points the operator at the CLI / env bootstrap instead.
  app.get("/v1/auth/status", async (c) => {
    const container = c.get("container");
    const { db } = container;
    const existing = await db.select({ id: user.id }).from(user).limit(1);
    const needsSetup = existing.length === 0;
    return c.json({ needsSetup });
  });

  // The container is the single merge point for inbound connectors (env presets
  // + `connectors` + the deprecated `webhookSources` passed to the client).
  // Any `webhookSources` passed HERE (the createApp path) are appended into the
  // installed registry as transport:"webhook" connectors — last-writer-wins,
  // idempotent.
  for (const source of opts.webhookSources ?? []) {
    container.connectorRegistry.register(webhookSourceToConnector(source));
  }

  // Back-compat: the deprecated `enablePresets: false` STILL suppresses env
  // presets end-to-end. The container builds presets unconditionally when the
  // client wasn't told otherwise, so when this flag is explicitly false we strip
  // the env-preset ids back out of the registry here — but never one a consumer
  // `webhookSources` override re-registered above (those are kept).
  if (opts.enablePresets === false) {
    const overriddenIds = new Set(
      (opts.webhookSources ?? []).map((s) => s.meta.id),
    );
    for (const preset of connectorsFromEnv(container.env)) {
      if (!overriddenIds.has(preset.meta.id)) {
        container.connectorRegistry.unregister(preset.meta.id);
      }
    }
  }

  registerRoutes(app, { container });

  // Serve the Studio SPA at /studio/* (static layer, no auth — the SPA gates
  // itself via /v1/auth/status + login; data endpoints stay behind requireAdmin).
  // No-op when no built dist is present, so an unbuilt studio never crashes boot.
  const studio = mountStudio(app);
  if (studio.mounted) {
    container.logger.debug(
      `Studio mounted at /studio (dist: ${studio.distPath})`,
    );
  }

  for (const routeFn of Array.isArray(opts.routes)
    ? opts.routes
    : opts.routes
      ? [opts.routes]
      : []) {
    routeFn(app);
  }

  if (container.env.NODE_ENV !== "production") {
    app.doc("/openapi.json", {
      openapi: "3.1.0",
      info: {
        title: "Hogsend API",
        version: API_VERSION,
        description: "Journey orchestration API",
      },
      servers: [
        {
          url: `http://localhost:${container.env.PORT}`,
          description: "Local development",
        },
      ],
    });

    app.get(
      "/docs",
      apiReference({
        spec: { url: "/openapi.json" },
        theme: "kepler",
      }),
    );
  }

  return app;
}
