import {
  getVoiceAgentDefinition,
  getVoiceAgentNames,
  renderVoiceAgent,
  type VoiceAgentName,
  type VoiceAgentRegistry,
} from "@hogsend/voice";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { errorSchema } from "../../lib/schemas.js";

// The Studio "preview" for a voice agent is the SYNTHESIZED agent config — there
// is no audio to render here (media lives in the provider cloud). Previewing an
// agent shows exactly what the engine would hand the provider on a real call:
// the interpolated system prompt + first message, the voice/model selection, the
// tool wire-specs, and the data-collection schema. Mirrors the email/SMS
// template preview route.

function decodeProps(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  const json = Buffer.from(raw, "base64").toString("utf8");
  const parsed = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("props must decode to a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function decodeVariables(
  raw?: string,
): Record<string, string | number | boolean> {
  const obj = decodeProps(raw);
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    )
      out[k] = v;
  }
  return out;
}

function agentExists(registry: VoiceAgentRegistry, key: string): boolean {
  return getVoiceAgentNames(registry).includes(key as VoiceAgentName);
}

const agentConfigSchema = z.object({
  systemPrompt: z.string(),
  firstMessage: z.string().optional(),
  voice: z.record(z.string(), z.unknown()).optional(),
  model: z.record(z.string(), z.unknown()).optional(),
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
  dataSchema: z.record(z.string(), z.unknown()).optional(),
  endCallPhrases: z.array(z.string()).optional(),
  maxDurationSec: z.number().optional(),
});

const catalogRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Voice agents"],
  summary: "List all registered voice agents",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            agents: z.array(
              z.object({
                key: z.string(),
                category: z.string().nullable(),
                description: z.string().nullable(),
                sourcePath: z.string().nullable(),
              }),
            ),
          }),
        },
      },
      description: "Voice agent catalog",
    },
  },
});

const previewRoute = createRoute({
  method: "get",
  path: "/{key}/preview",
  tags: ["Admin — Voice agents"],
  summary:
    "Render a voice agent's synthesized config (prompt + tools + schema)",
  request: {
    params: z.object({ key: z.string() }),
    query: z.object({
      props: z.string().optional(),
      variables: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            key: z.string(),
            category: z.string().nullable(),
            config: agentConfigSchema,
          }),
        },
      },
      description: "Rendered agent config",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid props/variables payload",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Agent not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Agent failed to render",
    },
  },
});

export const voiceAgentsRouter = new OpenAPIHono<AppEnv>()
  .openapi(catalogRoute, (c) => {
    const { voiceAgents } = c.get("container");
    const catalog = getVoiceAgentNames(voiceAgents).map((key) => {
      const def = getVoiceAgentDefinition({
        key: key as VoiceAgentName,
        registry: voiceAgents,
      });
      return {
        key: key as string,
        category: def.category ?? null,
        description: def.description ?? null,
        sourcePath: def.sourcePath ?? null,
      };
    });
    return c.json({ agents: catalog }, 200);
  })
  .openapi(previewRoute, (c) => {
    const { voiceAgents } = c.get("container");
    const { key } = c.req.valid("param");
    const { props: encodedProps, variables: encodedVars } =
      c.req.valid("query");

    if (!agentExists(voiceAgents, key)) {
      return c.json({ error: "Agent not found" }, 404);
    }

    let props: Record<string, unknown>;
    let variables: Record<string, string | number | boolean>;
    try {
      props = decodeProps(encodedProps);
      variables = decodeVariables(encodedVars);
    } catch {
      return c.json(
        { error: "Invalid props/variables: expected base64 JSON object" },
        400,
      );
    }

    const definition = getVoiceAgentDefinition({
      key: key as VoiceAgentName,
      registry: voiceAgents,
    });
    // Template examples < caller-supplied props (mirrors template preview).
    const mergedProps = { ...(definition.examples ?? {}), ...props } as never;

    try {
      const { config, category } = renderVoiceAgent({
        key: key as VoiceAgentName,
        props: mergedProps,
        registry: voiceAgents,
        variables,
      });
      return c.json({ key, category: category ?? null, config }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Render failed";
      return c.json({ error: `Failed to render agent: ${message}` }, 500);
    }
  });
