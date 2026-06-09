import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { errorSchema } from "../../lib/schemas.js";

/**
 * Admin sending-domain routes. The provider's optional `domains` capability is
 * the gate: when the active provider has none, the POSTs return 501
 * `{ error: "provider_unsupported" }` and the GET reports `supported: false`.
 * Provider API keys never leave the server — the CLI (`hogsend domain`) and
 * Studio's Setup view only ever talk to these routes.
 */

// Mirrors the pinned `DnsRecord` shape (@hogsend/core providers/domains.ts).
const DnsRecordSchema = z.object({
  type: z.enum(["TXT", "CNAME", "MX"]),
  name: z.string(),
  value: z.string(),
  ttl: z.number().optional(),
  priority: z.number().optional(),
  purpose: z.enum([
    "verification",
    "spf",
    "dkim",
    "return_path",
    "tracking",
    "mx",
    "other",
  ]),
  status: z.enum(["pending", "verified", "failed", "unknown"]),
});

// Mirrors the pinned `DomainStatus` shape.
const DomainStatusSchema = z.object({
  domain: z.string(),
  state: z.enum(["not_found", "pending", "verified", "failed"]),
  records: z.array(DnsRecordSchema),
  providerId: z.string(),
  checkedAt: z.string(),
  raw: z.unknown().optional(),
});

// Mirrors the pinned `TestModeState` shape (stubbed inactive until F3).
const TestModeStateSchema = z.object({
  active: z.boolean(),
  reason: z.enum(["env_flag", "domain_unverified"]).nullable(),
  redirectTo: z.string().nullable(),
  fromOverride: z.string().nullable(),
});

// Mirrors the pinned `EngineDomainStatus` shape.
const EngineDomainStatusSchema = z.object({
  domain: z.string().nullable(),
  providerId: z.string(),
  supported: z.boolean(),
  status: DomainStatusSchema.nullable(),
  testMode: TestModeStateSchema,
});

/** Pinned domain validation regex (PROJECT_SPEC §e). */
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

const getDomainRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Domain"],
  summary: "Sending-domain status (records, verification state, test mode)",
  request: {
    query: z.object({
      refresh: z.coerce.boolean().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: EngineDomainStatusSchema },
      },
      description:
        "Cached domain status for the active email provider; ?refresh=true forces a provider round-trip",
    },
  },
});

const addDomainRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Domain"],
  summary: "Register the sending domain with the active email provider",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            domain: z.string().regex(DOMAIN_RE, "invalid domain"),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: EngineDomainStatusSchema },
      },
      description: "Domain registered (idempotent) — fresh status",
    },
    501: {
      content: { "application/json": { schema: errorSchema } },
      description: "The active provider has no domains capability",
    },
  },
});

const verifyDomainRoute = createRoute({
  method: "post",
  path: "/verify",
  tags: ["Admin — Domain"],
  summary: "Trigger a provider-side verification pass for the sending domain",
  responses: {
    200: {
      content: {
        "application/json": { schema: EngineDomainStatusSchema },
      },
      description: "Verification pass triggered — fresh status",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "No sending domain configured (EMAIL_DOMAIN / EMAIL_FROM)",
    },
    501: {
      content: { "application/json": { schema: errorSchema } },
      description: "The active provider has no domains capability",
    },
  },
});

export const domainRouter = new OpenAPIHono<AppEnv>()
  .openapi(getDomainRoute, async (c) => {
    const { domainStatus } = c.get("container");
    const { refresh } = c.req.valid("query");
    const status = await domainStatus.getStatus({ refresh });
    return c.json(status, 200);
  })
  .openapi(addDomainRoute, async (c) => {
    const { domainStatus, emailProvider } = c.get("container");
    const { domain } = c.req.valid("json");

    if (!emailProvider.domains) {
      return c.json({ error: "provider_unsupported" }, 501);
    }

    // Idempotent at the provider (an existing domain falls through to lookup).
    await emailProvider.domains.create(domain);

    // Bust + refresh the cached snapshot so the response reflects the create.
    const status = await domainStatus.getStatus({ refresh: true });
    return c.json(status, 200);
  })
  .openapi(verifyDomainRoute, async (c) => {
    const { domainStatus, emailProvider } = c.get("container");

    if (!emailProvider.domains) {
      return c.json({ error: "provider_unsupported" }, 501);
    }

    const current = await domainStatus.getStatus();
    if (!current.domain) {
      return c.json({ error: "no_domain_configured" }, 400);
    }

    // Prefer the provider's explicit verification pass; fall back to a plain
    // status fetch for providers without one.
    const capability = emailProvider.domains;
    if (capability.verify) {
      await capability.verify(current.domain);
    } else {
      await capability.get(current.domain);
    }

    const status = await domainStatus.getStatus({ refresh: true });
    return c.json(status, 200);
  });
