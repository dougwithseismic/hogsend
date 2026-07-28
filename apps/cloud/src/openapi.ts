/**
 * The control plane's OpenAPI 3.1 description.
 *
 * Hand-written on purpose: the cloud app has exactly one endpoint today and
 * Next's App Router has no route-schema layer to generate from. The drift risk
 * that buys is paid for by a test (`src/__tests__/api-docs.test.ts`) that calls
 * the real handler and asserts the documented keys and enums match the body it
 * returns — so this file cannot silently rot.
 */

export interface OpenApiPropertySchema {
  type: "string";
  enum: readonly string[];
  description: string;
}

export interface OpenApiObjectSchema {
  type: "object";
  required: readonly string[];
  additionalProperties: false;
  properties: Record<string, OpenApiPropertySchema>;
}

export interface OpenApiResponse {
  description: string;
  content: { "application/json": { schema: OpenApiObjectSchema } };
}

export interface OpenApiOperation {
  summary: string;
  description: string;
  operationId: string;
  tags: readonly string[];
  responses: { "200": OpenApiResponse };
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: readonly { url: string; description: string }[];
  paths: { "/api/health": { get: OpenApiOperation } };
}

export const openApiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Hogsend Cloud control plane",
    version: "0.0.0",
    description:
      "The control plane that provisions and meters Hogsend environments. One endpoint exists today; this document grows with the API.",
  },
  servers: [{ url: "http://localhost:3004", description: "Local development" }],
  paths: {
    "/api/health": {
      get: {
        summary: "Liveness and schema readiness",
        operationId: "getHealth",
        tags: ["System"],
        description:
          "Always answers 200 — the body carries the verdict. An unreachable database reports `degraded` rather than failing the request, so an orchestrator does not restart-loop the app over a database a restart cannot fix.",
        responses: {
          "200": {
            description: "The current health verdict.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status", "db", "migrations"],
                  additionalProperties: false,
                  properties: {
                    status: {
                      type: "string",
                      enum: ["ok", "degraded"],
                      description:
                        "Rolled-up verdict: `ok` only when the database answers and every bundled migration is applied.",
                    },
                    db: {
                      type: "string",
                      enum: ["ok", "error"],
                      description:
                        "Whether a `SELECT 1` succeeded on a fresh short-lived connection.",
                    },
                    migrations: {
                      type: "string",
                      enum: ["in_sync", "pending"],
                      description:
                        "`in_sync` when the applied-migration count is at least the number bundled with this build.",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

/**
 * The docs are a development affordance, not a product surface: publishing an
 * API map from the production control plane hands an attacker a free index.
 */
export function apiDocsEnabled(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}
