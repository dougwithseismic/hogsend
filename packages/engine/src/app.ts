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

  app.on(["POST", "GET"], "/api/auth/*", (c) => {
    const { auth } = c.get("container");
    return auth.handler(c.req.raw);
  });

  registerRoutes(app, { webhookSources: opts.webhookSources ?? [] });

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
