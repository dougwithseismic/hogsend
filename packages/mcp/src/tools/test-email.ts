/**
 * `send_test_email` — deliberately its own tool (not a manage_journey action):
 * it is the ONLY tool that delivers to a real inbox, so the client's approval
 * card names exactly that.
 */

import { z } from "zod";
import { isHttpError } from "../client.js";
import { type ToolDef, toolError, toolResult } from "../registry.js";

export const testEmailTool: ToolDef = {
  name: "send_test_email",
  title: "Send a test email",
  tier: "write",
  description:
    "Send ONE rendered template to ONE explicit email address so a human can review it in a real inbox. " +
    "This delivers a real email — only call it with an address the user gave in this conversation. " +
    'For content review without sending, use hogsend_report scope "template" instead.',
  inputSchema: {
    templateKey: z
      .string()
      .describe('Registered template key (see hogsend_report scope "catalog")'),
    to: z.string().describe("Recipient address the user explicitly provided"),
    props: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional template props override"),
  },
  handler: async (args, client) => {
    const templateKey = args.templateKey as string;
    const to = args.to as string;
    if (!templateKey || !to)
      return toolError("`templateKey` and `to` are required.");
    try {
      await client.post(`/v1/admin/templates/${templateKey}/send-test`, {
        to,
        ...(args.props ? { props: args.props } : {}),
      });
    } catch (err) {
      const body = isHttpError(err)
        ? ((err.body as { error?: string } | undefined)?.error ?? err.message)
        : err instanceof Error
          ? err.message
          : String(err);
      return toolError(`send_test_email failed: ${body}`);
    }
    return toolResult(
      `Test email "${templateKey}" sent to ${to}. Ask them to check the inbox (and spam folder).`,
      { templateKey, to },
    );
  },
};
