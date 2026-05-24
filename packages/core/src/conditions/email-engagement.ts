import { emailSends } from "@hogsend/db/schema";
import { and, eq } from "drizzle-orm";
import type { EmailEngagementCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";

export async function evaluateEmailEngagementCondition(
  condition: EmailEngagementCondition,
  ctx: ConditionContext,
): Promise<boolean> {
  const send = await ctx.db.query.emailSends.findFirst({
    where: and(
      eq(emailSends.toEmail, ctx.userId),
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
