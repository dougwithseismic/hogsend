/**
 * `send_test_email` — the one tool that reaches a REAL inbox. Wraps
 * `POST /v1/admin/templates/{key}/send-test`, which renders the template with
 * its example props (plus any overrides) and dispatches a single message with
 * preference checks skipped. The route requires the `full-admin` scope, so a
 * read-only key comes back `forbidden`.
 */
import { z } from "zod";
import type { AdminClient } from "../lib/admin-client.js";
import { mapHttpError } from "../lib/result.js";
import { defineTool, type McpTool } from "../lib/tool.js";

const NAME = "send_test_email";

const sendTestShape = {
  templateKey: z
    .string()
    .min(1)
    .describe("Registered template key (see hogsend_report scope=catalog)."),
  to: z
    .string()
    .email()
    .describe("Recipient address — this DELIVERS A REAL EMAIL to this inbox."),
  props: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Optional prop overrides layered on the template's example props.",
    ),
} satisfies z.ZodRawShape;

const description =
  "Send a single real test email of a registered template to a real inbox — " +
  "this ACTUALLY DELIVERS a message, it is not a dry run (use manage_blueprint " +
  "validate or a template preview for non-delivering checks). The template is " +
  "rendered with its example props plus any `props` overrides; preference checks " +
  "are skipped. Requires a full-admin key. Returns { status, emailSendId }.";

/** Build the `send_test_email` tool bound to an {@link AdminClient}. */
export function createSendTestEmailTool(
  client: AdminClient,
): McpTool<typeof sendTestShape> {
  return defineTool({
    name: NAME,
    description,
    inputSchema: sendTestShape,
    run: async ({ templateKey, to, props }) => {
      try {
        const res = await client.post<{
          status: string;
          emailSendId?: string;
        }>(`/v1/admin/templates/${encodeURIComponent(templateKey)}/send-test`, {
          to,
          props,
        });
        return {
          ok: true as const,
          status: res.status,
          emailSendId: res.emailSendId,
        };
      } catch (err) {
        return mapHttpError(err);
      }
    },
  });
}
