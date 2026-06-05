import { user } from "@hogsend/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { ErrorHandler, MiddlewareHandler } from "hono/types";
import type { HogsendClient } from "./container.js";
import { API_VERSION } from "./env.js";
import type { Auth } from "./lib/auth.js";
import { mountStudio } from "./lib/studio.js";
import type { ApiKeyContext } from "./middleware/api-key.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requestLogger } from "./middleware/request-logger.js";
import { registerRoutes } from "./routes/index.js";
import type { DefinedWebhookSource } from "./webhook-sources/define-webhook-source.js";

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

export interface CreateAppOptions {
  /** Mount custom routers after the built-in routes. */
  routes?: (app: OpenAPIHono<AppEnv>) => void;
  /** Extra middleware applied after the built-in stack. */
  middleware?: MiddlewareHandler[];
  /** Webhook sources served at `/v1/webhooks/:sourceId`. */
  webhookSources?: DefinedWebhookSource[];
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

  // Closed signup: the first user may register (first-load "create admin");
  // once any user exists, sign-up is blocked. This is the security control that
  // lets `requireAdmin` trust any authenticated session in a single-tenant app.
  app.use("/api/auth/sign-up/*", async (c, next) => {
    if (c.req.method === "POST") {
      const { db } = c.get("container");
      const existing = await db.select({ id: user.id }).from(user).limit(1);
      if (existing.length > 0) {
        return c.json(
          { error: "Sign-ups are closed. An admin already exists." },
          403,
        );
      }
    }
    return next();
  });

  app.on(["POST", "GET"], "/api/auth/*", (c) => {
    const { auth } = c.get("container");
    return auth.handler(c.req.raw);
  });

  // Public bootstrap probe: tells the Studio whether to show the first-run
  // "create admin" screen (no users yet) instead of the login screen.
  app.get("/v1/auth/status", async (c) => {
    const { db } = c.get("container");
    const existing = await db.select({ id: user.id }).from(user).limit(1);
    return c.json({ needsSetup: existing.length === 0 });
  });

  registerRoutes(app, { webhookSources: opts.webhookSources ?? [] });

  // Serve the Studio SPA at /studio/* (static layer, no auth — the SPA gates
  // itself via /v1/auth/status + login; data endpoints stay behind requireAdmin).
  // No-op when no built dist is present, so an unbuilt studio never crashes boot.
  const studio = mountStudio(app);
  if (studio.mounted) {
    container.logger.debug(
      `Studio mounted at /studio (dist: ${studio.distPath})`,
    );
  }

  opts.routes?.(app);

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
