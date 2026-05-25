import type { Database } from "@hogsend/db";
import { emailPreferences, emailSends } from "@hogsend/db";
import type {
  EmailSuppressionError,
  RetryOptions,
  TemplateName,
} from "@hogsend/email";
import { getTemplate } from "@hogsend/email";
import { eq } from "drizzle-orm";
import type { Resend } from "resend";
import { sendEmail } from "./send.js";
import type { SendTrackedEmailOptions, TrackedSendResult } from "./types.js";

interface TrackedEmailDeps {
  db: Database;
  client: Resend;
  retryOptions?: RetryOptions;
}

export async function sendTrackedEmail<K extends TemplateName>(
  deps: TrackedEmailDeps,
  options: SendTrackedEmailOptions<K>,
): Promise<TrackedSendResult> {
  const { db, client, retryOptions } = deps;

  if (!options.skipPreferenceCheck) {
    const suppression = await checkSuppression(
      db,
      options.to,
      options.category,
    );
    if (suppression) {
      const rows = await db
        .insert(emailSends)
        .values({
          templateKey: options.templateKey,
          fromEmail: options.from,
          toEmail: options.to,
          subject: options.subject ?? "",
          category: options.category,
          journeyStateId: options.journeyStateId,
          status: "failed",
        })
        .returning({ id: emailSends.id });

      const suppressedRow = rows[0];
      if (!suppressedRow) throw new Error("Failed to insert email_sends row");

      return {
        emailSendId: suppressedRow.id,
        resendId: "",
        status:
          suppression === "unsubscribed" ||
          suppression === "category_unsubscribed"
            ? "unsubscribed"
            : "suppressed",
      };
    }
  }

  const {
    element,
    subject: defaultSubject,
    category,
  } = getTemplate(options.templateKey, options.props);

  const subject = options.subject ?? defaultSubject;

  const insertRows = await db
    .insert(emailSends)
    .values({
      templateKey: options.templateKey,
      fromEmail: options.from,
      toEmail: options.to,
      subject,
      category: options.category ?? category,
      journeyStateId: options.journeyStateId,
      status: "queued",
    })
    .returning({ id: emailSends.id });

  const insertedRow = insertRows[0];
  if (!insertedRow) throw new Error("Failed to insert email_sends row");
  const emailSendId = insertedRow.id;

  try {
    const result = await sendEmail(
      client,
      {
        from: options.from,
        to: options.to,
        subject,
        react: element,
        tags: options.tags,
        headers: options.headers,
        replyTo: options.replyTo,
      },
      retryOptions,
    );

    await db
      .update(emailSends)
      .set({
        resendId: result.id,
        status: "sent",
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(emailSends.id, emailSendId));

    return {
      emailSendId,
      resendId: result.id,
      status: "sent",
    };
  } catch (error) {
    await db
      .update(emailSends)
      .set({
        status: "failed",
        updatedAt: new Date(),
      })
      .where(eq(emailSends.id, emailSendId));

    throw error;
  }
}

type SuppressionReason = EmailSuppressionError["reason"] | null;

async function checkSuppression(
  db: Database,
  email: string,
  category?: string,
): Promise<SuppressionReason> {
  const rows = await db
    .select()
    .from(emailPreferences)
    .where(eq(emailPreferences.email, email))
    .limit(1);

  if (rows.length === 0) return null;

  const prefs = rows[0];
  if (!prefs) return null;

  if (prefs.suppressed) return "suppressed";
  if (prefs.unsubscribedAll) return "unsubscribed";

  if (category && prefs.categories) {
    const categories = prefs.categories as Record<string, boolean>;
    if (categories[category] === false) return "category_unsubscribed";
  }

  return null;
}
