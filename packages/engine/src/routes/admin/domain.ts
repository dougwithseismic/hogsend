import { normalizeReturnPathLabel } from "@hogsend/core";
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

// Mirrors the pinned `SendingDomainGuidance` shape (lib/sending-domain-guidance.ts).
// `.readonly()` matches the interface's frozen `readonly string[]` labels.
const SendingDomainGuidanceSchema = z.object({
  title: z.string(),
  body: z.string(),
  note: z.string(),
  recommendedLabels: z.array(z.string()).readonly(),
});

// Mirrors the pinned `EngineDomainStatus` shape. `returnPathSupported` is
// optional there for wire skew only — this engine always sends it.
const EngineDomainStatusSchema = z.object({
  domain: z.string().nullable(),
  providerId: z.string(),
  supported: z.boolean(),
  returnPathSupported: z.boolean().optional(),
  status: DomainStatusSchema.nullable(),
  testMode: TestModeStateSchema,
  guidance: SendingDomainGuidanceSchema,
});

/** Pinned domain validation regex (PROJECT_SPEC §e). */
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Provider domains calls can fail for configuration reasons the operator must
 * act on (e.g. a send-only restricted Resend key cannot read the domains API).
 * Surface those as 502 with the provider's message — `hogsend domain` and
 * Studio render this string directly — instead of an opaque 500.
 */
const providerErrorBody = (providerId: string, err: unknown) => ({
  error: `domains request to provider "${providerId}" failed: ${
    err instanceof Error ? err.message : String(err)
  }`,
});

const providerErrorResponse = {
  content: { "application/json": { schema: errorSchema } },
  description: "The provider rejected or failed the domains request",
} as const;

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
    502: providerErrorResponse,
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
    502: providerErrorResponse,
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
    502: providerErrorResponse,
  },
});

/**
 * The branded return path, both directions (PRD 20). It carries BOUNCE
 * traffic: on routes bounces via `<label>.<domain>` (two extra DNS records,
 * MX + SPF) so mailbox UIs stop showing "via <provider>" and SPF aligns with
 * the customer's own domain; off reverts to the provider default and the
 * domain stays fully verified on its base records. It changes nothing about
 * where a customer's incoming mail lands. Off is the default — nothing here
 * may switch it on implicitly.
 */
const setReturnPathRoute = createRoute({
  method: "post",
  path: "/return-path",
  tags: ["Admin — Domain"],
  summary: "Switch the branded return path (custom MAIL FROM) on or off",
  description:
    "The return path carries bounce traffic. On adds two DNS records (MX + " +
    'SPF) at `<label>.<domain>` so mailbox UIs stop showing "via ' +
    '<provider>"; off reverts to the provider default and the domain stays ' +
    "fully verified on its base records. Off is the default.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            enabled: z.boolean(),
            // Single DNS label (`notifications` → `notifications.<domain>`).
            // Validated in the handler with the core rule so the rejection
            // can NAME the offending label, not cite a pattern.
            label: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            // What the provider now holds — read back after the write, never
            // an echo of the request.
            returnPath: z.object({
              enabled: z.boolean(),
              mailFromDomain: z.string().nullable(),
            }),
            status: EngineDomainStatusSchema,
          }),
        },
      },
      description:
        "Return path switched — read-back state plus fresh domain status " +
        "(the MX + SPF records report as pending when switched on)",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid return-path label, or no sending domain configured",
    },
    501: {
      content: { "application/json": { schema: errorSchema } },
      description:
        "The active provider has no domains capability, or its domains " +
        "capability cannot manage the return path",
    },
    502: providerErrorResponse,
  },
});

export const domainRouter = new OpenAPIHono<AppEnv>()
  .openapi(getDomainRoute, async (c) => {
    const { domainStatus, emailProvider } = c.get("container");
    const { refresh } = c.req.valid("query");
    try {
      const status = await domainStatus.getStatus({ refresh });
      return c.json(status, 200);
    } catch (err) {
      return c.json(
        providerErrorBody(emailProvider.meta?.id ?? "email", err),
        502,
      );
    }
  })
  .openapi(addDomainRoute, async (c) => {
    const { domainStatus, emailProvider } = c.get("container");
    const { domain } = c.req.valid("json");

    if (!emailProvider.domains) {
      return c.json({ error: "provider_unsupported" }, 501);
    }

    try {
      // Idempotent at the provider (an existing domain falls through to lookup).
      await emailProvider.domains.create(domain);

      // Bust + refresh the cached snapshot so the response reflects the create.
      const status = await domainStatus.getStatus({ refresh: true });
      return c.json(status, 200);
    } catch (err) {
      return c.json(
        providerErrorBody(emailProvider.meta?.id ?? "email", err),
        502,
      );
    }
  })
  .openapi(verifyDomainRoute, async (c) => {
    const { domainStatus, emailProvider } = c.get("container");

    if (!emailProvider.domains) {
      return c.json({ error: "provider_unsupported" }, 501);
    }

    try {
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
    } catch (err) {
      return c.json(
        providerErrorBody(emailProvider.meta?.id ?? "email", err),
        502,
      );
    }
  })
  .openapi(setReturnPathRoute, async (c) => {
    const { domainStatus, emailProvider } = c.get("container");
    const { enabled, label } = c.req.valid("json");

    // TWO different unsupported cases, one deliberate answer each: no
    // `domains` capability at all, and a `domains` capability without
    // `setReturnPath`. Both are capability gaps, not engine errors — a throw
    // on the second would read as a bug in a deploy that simply cannot do
    // this. Same idiom as the other POSTs, no second one invented.
    if (!emailProvider.domains) {
      return c.json({ error: "provider_unsupported" }, 501);
    }
    const capability = emailProvider.domains;
    if (!capability.setReturnPath) {
      return c.json({ error: "provider_unsupported" }, 501);
    }

    // PRD 15's label rule, reused from core — rejected BEFORE any provider
    // traffic, and the rejection names the offending label.
    let normalizedLabel: string | undefined;
    if (label !== undefined) {
      const normalized = normalizeReturnPathLabel(label);
      if (normalized === null) {
        return c.json(
          {
            error:
              `"${label}" is not a valid subdomain label. Use one DNS ` +
              "label: lowercase letters, digits and hyphens, starting and " +
              "ending alphanumeric, 63 characters or fewer, no dots.",
          },
          400,
        );
      }
      normalizedLabel = normalized;
    }

    try {
      const current = await domainStatus.getStatus();
      if (!current.domain) {
        return c.json({ error: "no_domain_configured" }, 400);
      }

      const returnPath = await capability.setReturnPath({
        domain: current.domain,
        enabled,
        ...(normalizedLabel === undefined ? {} : { label: normalizedLabel }),
      });

      // Bust + refresh so this answer AND every subsequent GET reflect the
      // switch rather than a pre-toggle cache entry.
      const status = await domainStatus.getStatus({ refresh: true });
      return c.json(
        {
          returnPath: {
            enabled: returnPath.enabled,
            mailFromDomain: returnPath.mailFromDomain,
          },
          status,
        },
        200,
      );
    } catch (err) {
      return c.json(
        providerErrorBody(emailProvider.meta?.id ?? "email", err),
        502,
      );
    }
  });
