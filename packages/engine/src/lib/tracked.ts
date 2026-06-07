import type { EmailProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { emailPreferences, emailSends } from "@hogsend/db";
import type {
  EmailSuppressionError,
  RetryOptions,
  TemplateName,
  TemplateRegistry,
} from "@hogsend/email";
import { getTemplate, renderToHtml } from "@hogsend/email";
import { eq } from "drizzle-orm";
import { getListRegistry } from "../lists/registry-singleton.js";
import type {
  FrequencyCapConfig,
  SendTrackedEmailOptions,
  TrackedSendResult,
} from "./email-service-types.js";
import { isFrequencyCapped } from "./frequency-cap.js";
import type { Logger } from "./logger.js";

export type PrepareTrackedHtmlFn = (opts: {
  html: string;
  emailSendId: string;
  baseUrl: string;
  db: Database;
}) => Promise<string>;

interface TrackedEmailDeps {
  db: Database;
  provider: EmailProvider;
  /** The client app's template registry, threaded into {@link getTemplate}. */
  registry: TemplateRegistry;
  retryOptions?: RetryOptions;
  prepareTrackedHtml?: PrepareTrackedHtmlFn;
  /** Optional per-client frequency cap; undefined disables capping. */
  frequencyCap?: FrequencyCapConfig;
  /** Optional structured logger for operational events (e.g. cap skips). */
  logger?: Logger;
}

export async function sendTrackedEmail<K extends TemplateName>(
  opts: TrackedEmailDeps & { options: SendTrackedEmailOptions<K> },
): Promise<TrackedSendResult> {
  const {
    db,
    provider,
    registry,
    prepareTrackedHtml,
    frequencyCap,
    logger,
    options,
  } = opts;

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
          userId: options.userId,
          userEmail: options.userEmail ?? options.to,
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

    // Frequency cap — consulted only for non-system sends (system mail sets
    // skipPreferenceCheck and bypasses both suppression and the cap). On a cap
    // hit: no provider call, no row inserted, no throw — the journey continues.
    if (frequencyCap) {
      const capped = await isFrequencyCapped({
        db,
        to: options.to,
        category: options.category,
        config: frequencyCap,
      });
      if (capped) {
        logger?.info("send skipped: frequency_capped", {
          to: options.to,
          category: options.category,
        });
        return {
          emailSendId: "",
          resendId: "",
          status: "skipped",
          reason: "frequency_capped",
        };
      }
    }
  }

  const {
    element,
    subject: defaultSubject,
    category,
  } = getTemplate({ key: options.templateKey, props: options.props, registry });

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
      userId: options.userId,
      userEmail: options.userEmail ?? options.to,
      status: "queued",
    })
    .returning({ id: emailSends.id });

  const insertedRow = insertRows[0];
  if (!insertedRow) throw new Error("Failed to insert email_sends row");
  const emailSendId = insertedRow.id;

  try {
    let html: string | undefined;
    if (options.baseUrl && prepareTrackedHtml) {
      const rawHtml = await renderToHtml(element);
      html = await prepareTrackedHtml({
        html: rawHtml,
        emailSendId,
        baseUrl: options.baseUrl,
        db,
      });
    }

    const result = await provider.send({
      from: options.from,
      to: options.to,
      subject,
      ...(html ? { html } : { react: element }),
      tags: options.tags,
      headers: options.headers,
      replyTo: options.replyTo,
    });

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
    // Registry-aware polarity (§2.6, D3). A defined list resolves its own
    // `defaultOptIn`; non-list categories (`transactional`/`journey`) and any
    // unknown id resolve to `defaultOptIn true`, so the block condition reduces
    // to the legacy `=== false` check for them.
    const list = getListRegistry().get(category);
    const defaultOptIn = list?.defaultOptIn ?? true;
    const blocked = defaultOptIn
      ? categories[category] === false
      : categories[category] !== true;
    if (blocked) return "category_unsubscribed";
  }

  return null;
}
