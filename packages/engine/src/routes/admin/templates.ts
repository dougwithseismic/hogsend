import {
  getTemplate,
  getTemplateDefinition,
  getTemplateNames,
  renderToHtml,
  renderToPlainText,
  type TemplateName,
  type TemplateRegistry,
} from "@hogsend/email";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { errorSchema } from "../../lib/schemas.js";
import { requireScope } from "../../middleware/api-key.js";

// ---------------------------------------------------------------------------
// Engine-injected preview defaults
//
// At real send time `sendEmail()` (lib/email.ts) always injects `name`,
// `unsubscribeUrl`, `journeyName`, `eventName`, and `body`. We mirror that here
// so previews render the same shape a recipient would actually receive, then
// layer the template's `examples` and any caller-supplied props on top.
// ---------------------------------------------------------------------------

function engineInjectedDefaults(key: string): Record<string, unknown> {
  return {
    name: "there",
    journeyName: key,
    eventName: key,
    body: "This is a preview of the email body.",
    // A no-op preview URL: never a real tracking domain, so previewing never
    // writes tracked_links or otherwise touches the send pipeline.
    unsubscribeUrl: "https://example.com/unsubscribe?preview=1",
  };
}

function decodeProps(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  const json = Buffer.from(raw, "base64").toString("utf8");
  const parsed = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("props must decode to a JSON object");
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GET /templates — catalog of all registered templates
// ---------------------------------------------------------------------------

const catalogRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Templates"],
  summary: "List all registered email templates",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            templates: z.array(
              z.object({
                key: z.string(),
                defaultSubject: z.string(),
                category: z.string().nullable(),
                hasPreview: z.boolean(),
              }),
            ),
          }),
        },
      },
      description: "Template catalog",
    },
  },
});

// ---------------------------------------------------------------------------
// GET /templates/{key}/preview — render one template
// ---------------------------------------------------------------------------

const previewRoute = createRoute({
  method: "get",
  path: "/{key}/preview",
  tags: ["Admin — Templates"],
  summary: "Render a template preview (HTML + plain text)",
  request: {
    params: z.object({ key: z.string() }),
    query: z.object({
      props: z.string().optional(),
      format: z.enum(["html", "text"]).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            key: z.string(),
            subject: z.string(),
            category: z.string().nullable(),
            preview: z.string().nullable(),
            html: z.string(),
            text: z.string(),
          }),
        },
        "text/html": { schema: z.string() },
        "text/plain": { schema: z.string() },
      },
      description: "Rendered preview",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid props payload",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Template not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Template failed to render",
    },
  },
});

// ---------------------------------------------------------------------------
// POST /templates/{key}/send-test — send one real email
// ---------------------------------------------------------------------------

const sendTestRoute = createRoute({
  method: "post",
  path: "/{key}/send-test",
  tags: ["Admin — Templates"],
  summary: "Send a single test email of a template",
  middleware: [requireScope("full-admin")] as const,
  request: {
    params: z.object({ key: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            to: z.string().email(),
            props: z.record(z.string(), z.unknown()).optional(),
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
            status: z.string(),
            emailSendId: z.string().optional(),
          }),
        },
      },
      description: "Test email dispatched",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Template not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Test send failed",
    },
  },
});

function templateExists(registry: TemplateRegistry, key: string): boolean {
  return getTemplateNames(registry).includes(key as TemplateName);
}

export const templatesRouter = new OpenAPIHono<AppEnv>()
  .openapi(catalogRoute, (c) => {
    const { templates } = c.get("container");

    const catalog = getTemplateNames(templates).map((key) => {
      const def = getTemplateDefinition({
        key: key as TemplateName,
        registry: templates,
      });
      return {
        key: key as string,
        defaultSubject: def.defaultSubject,
        category: def.category ?? null,
        hasPreview: typeof def.preview === "function",
      };
    });

    return c.json({ templates: catalog }, 200);
  })
  .openapi(previewRoute, async (c) => {
    const { templates } = c.get("container");
    const { key } = c.req.valid("param");
    const { props: encodedProps, format } = c.req.valid("query");

    if (!templateExists(templates, key)) {
      return c.json({ error: "Template not found" }, 404);
    }

    let decoded: Record<string, unknown>;
    try {
      decoded = decodeProps(encodedProps);
    } catch {
      return c.json(
        { error: "Invalid props: expected base64 JSON object" },
        400,
      );
    }

    const definition = getTemplateDefinition({
      key: key as TemplateName,
      registry: templates,
    });

    // Engine defaults < template examples < caller-supplied props.
    const props = {
      ...engineInjectedDefaults(key),
      ...(definition.examples ?? {}),
      ...decoded,
    } as never;

    try {
      const { element, subject, category } = getTemplate({
        key: key as TemplateName,
        props,
        registry: templates,
      });

      if (format === "html") {
        const html = await renderToHtml(element);
        return c.body(html, 200, {
          "Content-Type": "text/html; charset=utf-8",
        });
      }
      if (format === "text") {
        const text = await renderToPlainText(element);
        return c.body(text, 200, {
          "Content-Type": "text/plain; charset=utf-8",
        });
      }

      const [html, text] = await Promise.all([
        renderToHtml(element),
        renderToPlainText(element),
      ]);
      const preview = definition.preview?.(props) ?? null;

      return c.json(
        { key, subject, category: category ?? null, preview, html, text },
        200,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Render failed";
      return c.json({ error: `Failed to render template: ${message}` }, 500);
    }
  })
  .openapi(sendTestRoute, async (c) => {
    const { emailService, templates } = c.get("container");
    const { key } = c.req.valid("param");
    const { to, props: bodyProps } = c.req.valid("json");

    if (!templateExists(templates, key)) {
      return c.json({ error: "Template not found" }, 404);
    }

    const definition = getTemplateDefinition({
      key: key as TemplateName,
      registry: templates,
    });

    const props = {
      ...engineInjectedDefaults(key),
      ...(definition.examples ?? {}),
      ...(bodyProps ?? {}),
    } as never;

    try {
      const result = await emailService.send({
        template: key as TemplateName,
        props,
        to,
        subject: definition.defaultSubject,
        category: definition.category ?? "transactional",
        skipPreferenceCheck: true,
      });

      return c.json(
        { status: result.status, emailSendId: result.emailSendId },
        200,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Send failed";
      return c.json({ error: `Test send failed: ${message}` }, 500);
    }
  });
