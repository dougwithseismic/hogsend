import { emailSends } from "@hogsend/db/schema";
import { and, eq } from "drizzle-orm";
import type { EmailEngagementCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";

export async function evaluateEmailEngagementCondition(opts: {
  condition: EmailEngagementCondition;
  ctx: ConditionContext;
}): Promise<boolean> {
  const { condition, ctx } = opts;
  if (condition.templateKey === undefined) {
    // An absent templateKey means "scoped by caller context" (campaign waves
    // read it as "any prior send of THIS campaign") — the per-user evaluator
    // has no such scope, so an unscoped condition here is an authoring error.
    throw new Error(
      "email_engagement condition without templateKey is scoped by caller context (campaign waves) — the per-user evaluator requires an explicit templateKey.",
    );
  }
  // `email_sends.to_email` is an address. Prefer the explicitly-resolved
  // `ctx.email` (the flag path passes the contact's real email); fall back to
  // `ctx.userId` only for legacy callers that never set `email`. A contact with
  // no email cannot have engagement — resolve to false rather than mis-query.
  const recipient = ctx.email !== undefined ? ctx.email : ctx.userId;
  if (recipient == null) return false;
  const send = await ctx.db.query.emailSends.findFirst({
    where: and(
      eq(emailSends.toEmail, recipient),
      eq(emailSends.templateKey, condition.templateKey),
    ),
    orderBy: (sends, { desc }) => [desc(sends.createdAt)],
  });

  if (!send) return false;

  switch (condition.check) {
    case "opened":
      return send.openedAt !== null;
    case "clicked":
      return send.clickedAt !== null;
    case "not_opened":
      return send.openedAt === null;
    case "not_clicked":
      return send.clickedAt === null;
    default:
      return false;
  }
}
