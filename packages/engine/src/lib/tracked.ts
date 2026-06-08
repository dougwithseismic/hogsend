import type { EmailProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { emailPreferences, emailSends } from "@hogsend/db";
import type {
  EmailSuppressionError,
  RetryOptions,
  TemplateName,
  TemplateRegistry,
} from "@hogsend/email";
import {
  generateUnsubscribeUrl,
  getTemplate,
  renderToHtml,
} from "@hogsend/email";
import { eq } from "drizzle-orm";
import { getListRegistry } from "../lists/registry-singleton.js";
import {
  type FrequencyCapConfig,
  type SendTrackedEmailOptions,
  type TrackedSendResult,
  trackedSendResult,
} from "./email-service-types.js";
import { isFrequencyCapped } from "./frequency-cap.js";
import { hatchet } from "./hatchet.js";
import { createLogger, type Logger } from "./logger.js";
import { emitOutbound } from "./outbound.js";

// Module-level fallback logger for the outbound emit — the tracked-mailer's
// `logger` dep is optional, but `emitOutbound` requires one. Mirrors the
// `createLogger(process.env.LOG_LEVEL)` singleton pattern used elsewhere in the
// engine libs (define-journey, preferences).
const emitLogger = createLogger(process.env.LOG_LEVEL);

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

  // The idempotency-collision result, built identically whether the prior row is
  // found by the up-front short-circuit select OR the concurrent-insert loser
  // path below: surface the winner's send id, mapping "sent" → sent and anything
  // else → a skipped/"frequency_capped" placeholder.
  const idempotentResult = (prior: {
    id: string;
    status: string;
  }): TrackedSendResult =>
    trackedSendResult({
      emailSendId: prior.id,
      messageId: "",
      status: prior.status === "sent" ? "sent" : "skipped",
      ...(prior.status === "sent" ? {} : { reason: "frequency_capped" }),
    } as Omit<TrackedSendResult, "resendId">);

  // Idempotency short-circuit (POST /v1/emails): a retry with the same key
  // returns the prior send instead of dispatching a duplicate provider call /
  // tracking artifacts (mirrors the user_events idempotency pattern).
  if (options.idempotencyKey) {
    const existing = await db
      .select({ id: emailSends.id, status: emailSends.status })
      .from(emailSends)
      .where(eq(emailSends.idempotencyKey, options.idempotencyKey))
      .limit(1);
    const prior = existing[0];
    if (prior) {
      return idempotentResult(prior);
    }
  }

  // Resolve the template ONCE up front so its default category is available to
  // the suppression check (a public /v1/emails send may omit `category`, in
  // which case the per-category suppression must still consult the template's
  // own category — otherwise an unsubscribed recipient leaks the mail while the
  // row is stamped with that very category — risk 6 / §2.6).
  const {
    element,
    subject: defaultSubject,
    category: templateCategory,
  } = getTemplate({ key: options.templateKey, props: options.props, registry });

  const effectiveCategory = options.category ?? templateCategory;
  const subject = options.subject ?? defaultSubject;

  if (!options.skipPreferenceCheck) {
    const suppression = await checkSuppression(
      db,
      options.to,
      effectiveCategory,
    );
    if (suppression) {
      const rows = await db
        .insert(emailSends)
        .values({
          templateKey: options.templateKey,
          fromEmail: options.from,
          toEmail: options.to,
          subject: options.subject ?? "",
          category: effectiveCategory,
          journeyStateId: options.journeyStateId,
          userId: options.userId,
          userEmail: options.userEmail ?? options.to,
          status: "failed",
          // A suppressed send does NOT consume the idempotency key — leaving it
          // unset lets a later retry (e.g. after the recipient re-subscribes)
          // actually attempt the send rather than dedup to the suppressed row.
        })
        .returning({ id: emailSends.id });

      const suppressedRow = rows[0];
      if (!suppressedRow) throw new Error("Failed to insert email_sends row");

      return trackedSendResult({
        emailSendId: suppressedRow.id,
        messageId: "",
        status:
          suppression === "unsubscribed" ||
          suppression === "category_unsubscribed"
            ? "unsubscribed"
            : "suppressed",
      });
    }

    // Frequency cap — consulted only for non-system sends (system mail sets
    // skipPreferenceCheck and bypasses both suppression and the cap). On a cap
    // hit: no provider call, no row inserted, no throw — the journey continues.
    // Keyed on the caller-supplied `options.category` (NOT the template default)
    // so the cap's byCategory/exempt rules apply exactly to what the caller
    // asked to cap — distinct from suppression, which needs the template default
    // to honor a per-category unsubscribe even when the caller omits `category`.
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
        return trackedSendResult({
          emailSendId: "",
          messageId: "",
          status: "skipped",
          reason: "frequency_capped",
        });
      }
    }
  }

  // Unsubscribe surface (RFC 8058 / CAN-SPAM): generate the per-recipient
  // unsubscribe URL ONCE and inject it both as the in-body template prop AND the
  // List-Unsubscribe / List-Unsubscribe-Post: One-Click headers, so EVERY send
  // through the tracked mailer — journey AND public /v1/emails — carries it
  // uniformly. Suppressed only for true system mail (skipPreferenceCheck). Built
  // from the SAME user_id fallback (externalId ?? contactId) the email_sends row
  // uses, keeping the token externalId consistent with the preference-center key.
  const secret = process.env.BETTER_AUTH_SECRET;
  let unsubscribeUrl: string | undefined;
  if (!options.skipPreferenceCheck && options.baseUrl && secret) {
    unsubscribeUrl = generateUnsubscribeUrl({
      baseUrl: options.baseUrl,
      secret,
      externalId: options.userId ?? options.to,
      email: options.to,
      category: effectiveCategory,
    });
  }

  const sendHeaders: Record<string, string> = { ...(options.headers ?? {}) };
  if (unsubscribeUrl && !("List-Unsubscribe" in sendHeaders)) {
    sendHeaders["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
    sendHeaders["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  // Re-render the template element with the unsubscribe URL merged into props so
  // the in-body footer link renders for journeyless public sends too. Journey
  // sends already pass `unsubscribeUrl` in props (lib/email.ts); only set it when
  // the caller didn't, so we never clobber an explicitly-passed value.
  const propsRecord = options.props as unknown as
    | Record<string, unknown>
    | undefined;
  const sendElement =
    unsubscribeUrl && propsRecord?.unsubscribeUrl == null
      ? getTemplate({
          key: options.templateKey,
          props: {
            ...(propsRecord ?? {}),
            unsubscribeUrl,
          } as unknown as typeof options.props,
          registry,
        }).element
      : element;

  const baseInsert = db.insert(emailSends).values({
    templateKey: options.templateKey,
    fromEmail: options.from,
    toEmail: options.to,
    subject,
    category: effectiveCategory,
    journeyStateId: options.journeyStateId,
    userId: options.userId,
    userEmail: options.userEmail ?? options.to,
    status: "queued",
    idempotencyKey: options.idempotencyKey,
  });

  // With an idempotency key, swallow a concurrent-insert collision on the unique
  // index (the select-then-insert above is not atomic) and return the winner.
  const insertRows = options.idempotencyKey
    ? await baseInsert
        .onConflictDoNothing({ target: emailSends.idempotencyKey })
        .returning({ id: emailSends.id })
    : await baseInsert.returning({ id: emailSends.id });

  const insertedRow = insertRows[0];
  if (!insertedRow && options.idempotencyKey) {
    // A concurrent send claimed the key first — return its row.
    const winner = await db
      .select({ id: emailSends.id, status: emailSends.status })
      .from(emailSends)
      .where(eq(emailSends.idempotencyKey, options.idempotencyKey))
      .limit(1);
    const won = winner[0];
    if (won) {
      return idempotentResult(won);
    }
  }
  if (!insertedRow) throw new Error("Failed to insert email_sends row");
  const emailSendId = insertedRow.id;

  try {
    let html: string | undefined;
    if (options.baseUrl && prepareTrackedHtml) {
      const rawHtml = await renderToHtml(sendElement);
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
      ...(html ? { html } : { react: sendElement }),
      tags: options.tags,
      headers: sendHeaders,
      replyTo: options.replyTo,
    });

    const sentAt = new Date();
    await db
      .update(emailSends)
      .set({
        messageId: result.id,
        status: "sent",
        sentAt,
        updatedAt: sentAt,
      })
      .where(eq(emailSends.id, emailSendId));

    // OUTBOUND `email.sent` — fired ONLY on a real provider-accepted send (this
    // success branch). Suppressed/frequency-capped/failed branches and the
    // `db === undefined` mailer fallback do NOT reach here, so they never emit.
    // `dedupeKey` = `email.sent:<emailSendId>`: this runs inside the tracked
    // mailer which a journey (a Hatchet-retryable durable task) invokes, so a
    // re-execution recomputes the identical key and the unique
    // `(endpointId, dedupeKey)` index absorbs the duplicate. STRICTLY
    // fire-and-forget: an un-caught reject here would bubble into the catch below
    // and wrongly re-mark the (already sent) row `failed` (risk 2).
    void emitOutbound({
      db,
      hatchet,
      logger: logger ?? emitLogger,
      event: "email.sent",
      dedupeKey: `email.sent:${emailSendId}`,
      payload: {
        emailSendId,
        messageId: result.id,
        templateKey: options.templateKey,
        to: options.to,
        userId: options.userId ?? null,
        category: effectiveCategory ?? null,
        journeyStateId: options.journeyStateId ?? null,
        subject,
        sentAt: sentAt.toISOString(),
      },
    }).catch((err: unknown) => {
      (logger ?? emitLogger).warn("emitOutbound email.sent failed", {
        emailSendId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return trackedSendResult({
      emailSendId,
      messageId: result.id,
      status: "sent",
    });
  } catch (error) {
    // A provider send failed (transient SMTP/network/429). Stamp `failed` AND
    // RELEASE the idempotency key (set it null), exactly like the suppression
    // path deliberately never consumes it: this lets a retry genuinely
    // RE-ATTEMPT the send rather than dedup to this failed row. Without the
    // release, the up-front short-circuit would return this `failed` row mapped
    // to `skipped`, so a real delivery failure would (a) never be re-sent and
    // (b) silently vanish from the campaign's failedCount into skippedCount.
    await db
      .update(emailSends)
      .set({
        status: "failed",
        idempotencyKey: null,
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

  const prefs = rows[0];

  if (prefs?.suppressed) return "suppressed";
  if (prefs?.unsubscribedAll) return "unsubscribed";

  // Registry-aware polarity (§2.6, D3) — applied through the SINGLE source of
  // truth `ListRegistry.isSubscribed` so it matches the preference center EXACTLY
  // (categories default to `{}` when there is NO prefs row or NO categories map).
  // This MUST run even when the row is absent/empty: an opt-out list
  // (`defaultOptIn:false`) requires `categories[id] === true` to be subscribed,
  // so absence-of-true (the common "never opted in" case) MUST block — otherwise
  // a contact the preference center shows as "Unsubscribed" would still receive
  // the mail (the two surfaces would disagree, which §2.6 forbids).
  if (category) {
    const categories = (prefs?.categories ?? {}) as Record<string, boolean>;
    if (!getListRegistry().isSubscribed(categories, category)) {
      return "category_unsubscribed";
    }
  }

  return null;
}
