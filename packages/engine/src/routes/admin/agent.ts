import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import type { AppEnv } from "../../app.js";
import { agentConfig } from "../../lib/agent/config.js";
import { getAgentModel } from "../../lib/agent/provider.js";
import { buildAgentSystemPrompt } from "../../lib/agent/system-prompt.js";
import { buildAgentTools } from "../../lib/agent/tools.js";

const configRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Admin — Agent"],
  summary: "Studio co-working agent availability + active model",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            enabled: z
              .boolean()
              .describe(
                "true only when AGENT_ENABLED and an OpenRouter key are set",
              ),
            model: z
              .string()
              .describe("the OpenRouter model id the agent runs on"),
          }),
        },
      },
      description: "Whether the agent is configured, and which model it uses",
    },
  },
});

export const agentRouter = new OpenAPIHono<AppEnv>();

agentRouter.openapi(configRoute, (c) => {
  const { env } = c.get("container");
  const cfg = agentConfig(env);
  return c.json({ enabled: cfg.enabled, model: cfg.model }, 200);
});

/**
 * Streaming chat. NOT an `.openapi()` route — `@hono/zod-openapi` can't model a
 * non-JSON UI-message stream body — so it's a plain POST that returns the AI
 * SDK's stream Response directly. Mounted under `adminRouter`, so it already
 * inherits requireAdmin + rateLimit + auditMiddleware. The browser sends the
 * Better Auth session cookie; the OpenRouter key never leaves the server.
 */
agentRouter.post("/chat", async (c) => {
  const container = c.get("container");
  const cfg = agentConfig(container.env);
  if (!cfg.enabled) {
    return c.json({ error: "agent_unconfigured" }, 503);
  }

  const body = await c.req.json<{ messages?: UIMessage[] }>();
  const messages = body.messages ?? [];

  const result = streamText({
    model: getAgentModel(container.env),
    system: await buildAgentSystemPrompt(container),
    messages: await convertToModelMessages(messages),
    tools: buildAgentTools({ container }),
    stopWhen: stepCountIs(container.env.AGENT_MAX_STEPS),
  });

  return result.toUIMessageStreamResponse();
});
