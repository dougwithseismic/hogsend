import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { dispatchProviderWebhook } from "./email-provider.js";

const resendWebhookRoute = createRoute({
  method: "post",
  path: "/resend",
  tags: ["Webhooks"],
  summary:
    "Resend webhook receiver (@deprecated — use /v1/webhooks/email/resend)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean() }),
        },
      },
      description: "Webhook processed",
    },
    401: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Missing or invalid webhook secret",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Resend provider not registered",
    },
  },
});

export const resendWebhookRouter = new OpenAPIHono<AppEnv>().openapi(
  resendWebhookRoute,
  // Thin deprecated alias for `POST /v1/webhooks/email/resend` — identical
  // behavior, just the `resend` provider id wired in.
  (c) => dispatchProviderWebhook(c, "resend"),
);
