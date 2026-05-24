import { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { Container } from "./container.js";
import { API_VERSION } from "./env.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requestLogger } from "./middleware/request-logger.js";
import { registerRoutes } from "./routes/index.js";

export type AppEnv = {
  Variables: {
    container: Container;
    requestId: string;
  };
};

export function createApp(container: Container) {
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

  app.onError(errorHandler);

  app.notFound((c) => {
    return c.json({ error: "Not Found" }, 404);
  });

  registerRoutes(app);

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "GrowthHog API",
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

  return app;
}
