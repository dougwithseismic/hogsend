import { getTemplateNames, type TemplateName } from "@hogsend/email";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { resolveRecipient } from "../../lib/contacts.js";
import { hasScope } from "../../middleware/api-key.js";

const errorSchema = z.object({ error: z.string() });

const emailRequestSchema = z.object({
  to: z.string().email().optional(),
  userId: z.string().min(1).optional(),
  template: z.string().min(1),
  props: z.record(z.string(), z.unknown()).optional(),
  from: z.string().optional(),
  subject: z.string().optional(),
  replyTo: z.union([z.string(), z.array(z.string())]).optional(),
  category: z.string().optional(),
  skipPreferenceCheck: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
});

const emailResponseSchema = z.object({
  emailSendId: z.string(),
  status: z.enum(["queued", "sent", "suppressed", "unsubscribed", "skipped"]),
  reason: z.string().optional(),
});

const sendRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Emails"],
  summary: "Send a transactional email",
  description:
    "Resolves a recipient by `to` or `userId`, then sends the named template through the engine-owned tracked mailer (journeyless — link-click + open tracking still applies). `skipPreferenceCheck` requires a full-admin key.",
  request: {
    body: {
      content: {
        "application/json": { schema: emailRequestSchema },
      },
    },
  },
  responses: {
    202: {
      content: {
        "application/json": { schema: emailResponseSchema },
      },
      description: "Email send queued / dispatched",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing recipient or unknown template",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description: "skipPreferenceCheck requires a full-admin key",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "userId has no resolvable email",
    },
  },
});

export const emailsRouter = new OpenAPIHono<AppEnv>().openapi(
  sendRoute,
  async (c) => {
    const { db, emailService, templates } = c.get("container");
    const apiKey = c.get("apiKey");
    const body = c.req.valid("json");

    if (!body.to && !body.userId) {
      return c.json({ error: "to or userId is required" }, 400);
    }

    // `skipPreferenceCheck` is a privileged bypass — gate it on full-admin
    // (§2.5). The sub-app guard already required the `ingest` scope.
    if (body.skipPreferenceCheck) {
      if (!apiKey || !hasScope(apiKey.scopes, "full-admin")) {
        return c.json(
          { error: "skipPreferenceCheck requires a full-admin key" },
          403,
        );
      }
    }

    // Validate the template server-side against the wired registry (§2.5).
    if (!getTemplateNames(templates).includes(body.template as TemplateName)) {
      return c.json({ error: `Unknown template: ${body.template}` }, 400);
    }

    const recipient = await resolveRecipient({
      db,
      userId: body.userId,
      email: body.to,
    });
    if (!recipient) {
      return c.json({ error: "No resolvable email for recipient" }, 404);
    }

    // Journeyless send (no journeyStateId) so §5 tracking runs. The
    // denormalized `userId` on the send row is external_id when present, else
    // the contact id fallback (§2.5).
    const result = await emailService.send({
      template: body.template as TemplateName,
      props: (body.props ?? {}) as never,
      to: recipient.email,
      from: body.from,
      subject: body.subject,
      replyTo: body.replyTo,
      category: body.category,
      userId: recipient.externalId ?? recipient.contactId,
      userEmail: recipient.email,
      skipPreferenceCheck: body.skipPreferenceCheck,
    });

    return c.json(
      {
        emailSendId: result.emailSendId,
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
      },
      202,
    );
  },
);
