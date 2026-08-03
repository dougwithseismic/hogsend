/**
 * The control plane's OpenAPI 3.1 description.
 *
 * Hand-written on purpose: Next's App Router has no route-schema layer to
 * generate from. The drift risk that buys is paid for by a test
 * (`src/__tests__/api-docs.test.ts`) that calls the real handler and asserts
 * the documented keys and enums match the body it returns — so this file cannot
 * silently rot.
 *
 * The HTTP surface is exactly two route files: `/api/health` and the Better
 * Auth catch-all. Everything else the dashboard does is a server action or a
 * server component read, which has no URL to document — so this is the whole
 * public surface, not a sample of it.
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

export interface OpenApiExternalDocs {
  description: string;
  url: string;
}

export interface OpenApiPathParameter {
  name: string;
  in: "path";
  required: true;
  description: string;
  schema: { type: "string" };
}

/**
 * An operation this app forwards rather than implements. It has no response
 * schema on purpose: Better Auth owns those shapes, and copying them here
 * would be a second source of truth with nothing keeping it honest.
 */
export interface OpenApiDelegatedOperation {
  summary: string;
  description: string;
  operationId: string;
  tags: readonly string[];
  parameters: readonly OpenApiPathParameter[];
  externalDocs: OpenApiExternalDocs;
  responses: { default: { description: string } };
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: readonly { url: string; description: string }[];
  tags: readonly { name: string; description: string }[];
  paths: {
    "/api/health": { get: OpenApiOperation };
    "/api/auth/{path}": {
      get: OpenApiDelegatedOperation;
      post: OpenApiDelegatedOperation;
    };
  };
}

const BETTER_AUTH_DOCS: OpenApiExternalDocs = {
  description: "Better Auth API reference (email/password, email OTP, org)",
  url: "https://www.better-auth.com/docs/concepts/api",
};

const AUTH_PATH_PARAMETER: OpenApiPathParameter = {
  name: "path",
  in: "path",
  required: true,
  description:
    "The Better Auth route, e.g. `sign-in/email`, `email-otp/send-verification-otp`, `organization/invite-member`.",
  schema: { type: "string" },
};

const AUTH_DESCRIPTION =
  "Handled by Better Auth, not by this app: the route file is a catch-all that hands the request to `auth.handler`. Enabled surfaces are email/password sign-up and sign-in, email-OTP verification, and the organization plugin (members, invitations, active organization). Session state is a cookie prefixed `hscloud`, so calls must be made with credentials. The exact request and response shapes are Better Auth's — see the external documentation rather than a copy of them here.";

export const openApiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Hogsend Cloud control plane",
    version: "0.0.0",
    description:
      "The control plane that provisions and meters Hogsend environments. Its HTTP surface is two route files — the health probe and the Better Auth mount — because the dashboard itself runs on server components and server actions, which have no URLs to document.",
  },
  servers: [{ url: "http://localhost:3004", description: "Local development" }],
  tags: [
    {
      name: "System",
      description: "Probes an orchestrator or a human can call.",
    },
    {
      name: "Auth",
      description:
        "Delegated to Better Auth: accounts, email-OTP verification, organizations, members and invitations.",
    },
  ],
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
    "/api/auth/{path}": {
      get: {
        summary: "Better Auth (read operations)",
        operationId: "authGet",
        tags: ["Auth"],
        description: AUTH_DESCRIPTION,
        parameters: [AUTH_PATH_PARAMETER],
        externalDocs: BETTER_AUTH_DOCS,
        responses: {
          default: {
            description:
              "Whatever Better Auth answers for the route, verbatim. This app neither reshapes the body nor rewrites the status.",
          },
        },
      },
      post: {
        summary: "Better Auth (write operations)",
        operationId: "authPost",
        tags: ["Auth"],
        description: AUTH_DESCRIPTION,
        parameters: [AUTH_PATH_PARAMETER],
        externalDocs: BETTER_AUTH_DOCS,
        responses: {
          default: {
            description:
              "Whatever Better Auth answers for the route, verbatim. Sign-in and OTP verification also set the session cookie.",
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
