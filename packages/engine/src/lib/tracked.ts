import type { EmailProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { emailSends } from "@hogsend/db";
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
import {
  deriveJourneyKey,
  getJourneyBoundary,
  parseJourneySendSite,
  registerKey,
} from "../journeys/journey-boundary.js";
import { logTransition } from "../journeys/journey-log.js";
import { getListRegistry } from "../lists/registry-singleton.js";
import type { TestModeState } from "./domain-status.js";
import {
  type FrequencyCapConfig,
  type SendTrackedEmailOptions,
  type TrackedSendResult,
  trackedSendResult,
} from "./email-service-types.js";
import { isFrequencyCapped } from "./frequency-cap.js";
import { hatchet } from "./hatchet.js";
import { checkJourneySuppress } from "./journey-suppress.js";
import { createLogger, type Logger } from "./logger.js";
import { emitOutbound } from "./outbound.js";
import { readRecipientPreferences } from "./preferences.js";
import {
  buildRedirect,
  isUnaddressable,
  logRedirect,
  NO_REDIRECT_MESSAGE,
} from "./test-mode.js";

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
  /**
   * The active test-mode state, resolved ONCE by the mailer (cache-only) and
   * threaded in so this module stays domainStatus-unaware. `null` ⇒ live send.
   * When active, suppression/frequency/unsubscribe still key to the ORIGINAL
   * recipient (`options.to`); only the wire + `email_sends` row are redirected.
   */
  testMode?: TestModeState | null;
}

/**
 * Boundary-aware entry point. When a send reaches the tracked mailer from INSIDE
 * a journey `run()` WITHOUT an idempotency key already set — i.e. a journey that
 * called the raw `getEmailService().send(...)` instead of the `sendEmail()`
 * helper (which derives its own key) — derive the same deterministic, replay-
 * stable key HERE so the engine's exactly-once guarantee covers that path too.
 * This closes the raw-service footgun: ANY journey send is auto-keyed + memoized
 * regardless of which import the author reached for. Outside a journey, or when
 * a key is already set (sendEmail / POST /v1/emails), this is a transparent
 * pass-through to {@link sendTrackedEmailInner}.
 */
export async function sendTrackedEmail<K extends TemplateName>(
  opts: TrackedEmailDeps & { options: SendTrackedEmailOptions<K> },
): Promise<TrackedSendResult> {
  const boundary = getJourneyBoundary();
  if (!boundary || opts.options.idempotencyKey) {
    return sendTrackedEmailInner(opts);
  }

  // Raw-service send inside a journey: derive the key the same way sendEmail
  // would (site = nearest authored wait label ?? templateKey; discriminant =
  // templateKey), register it for the loud intra-run collision throw, thread it
  // onto the options, and memoize the whole send (Layer 1 fast path when the
  // engine supports eviction; Layer 2 DB key otherwise).
  const site = boundary.currentLabel ?? String(opts.options.templateKey);
  const key = deriveJourneyKey({
    kind: "send",
    anchor: boundary.runAnchor,
    site,
    discriminant: String(opts.options.templateKey),
  });
  registerKey(boundary, key);
  const keyed = {
    ...opts,
    options: { ...opts.options, idempotencyKey: key },
  };
  return boundary.memoize([key], () => sendTrackedEmailInner(keyed));
}

async function sendTrackedEmailInner<K extends TemplateName>(
  opts: TrackedEmailDeps & { options: SendTrackedEmailOptions<K> },
): Promise<TrackedSendResult> {
  const {
    db,
    provider,
    registry,
    prepareTrackedHtml,
    frequencyCap,
    logger,
    testMode,
    options,
  } = opts;

  // Test-mode redirect (resolved by the mailer; null ⇒ live). When active, the
  // wire `to`/`from`/`subject` + the email_sends row are redirected, but EVERY
  // preference statement below (suppression, frequency cap, unsubscribe token)
  // still keys to the ORIGINAL recipient `options.to` — preferences belong to
  // the real user, never the shared test inbox. Resolved lazily after the
  // suppression/frequency-cap branch so the original recipient's preferences are
  // honored first.
  const redirectActive = Boolean(testMode?.active);

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
  //
  // CRASH-SAFETY: only a TERMINAL-success ("sent") prior row is a satisfied
  // duplicate. A "queued" row means a prior attempt inserted the row but the
  // worker died before the provider returned or before the status flip — the
  // email may NEVER have gone out. Returning it as a duplicate would silently
  // suppress a never-delivered send. Instead, REUSE that row and re-drive the
  // provider call (no second row — the unique index is honored). The failed path
  // already NULLs the key, so a "failed" row never collides here.
  let reuseRowId: string | undefined;
  if (options.idempotencyKey) {
    const existing = await db
      .select({ id: emailSends.id, status: emailSends.status })
      .from(emailSends)
      .where(eq(emailSends.idempotencyKey, options.idempotencyKey))
      .limit(1);
    const prior = existing[0];
    if (prior) {
      if (prior.status === "queued") {
        reuseRowId = prior.id;
      } else {
        return idempotentResult(prior);
      }
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

    // Journey suppress (`meta.suppress`) — a per-recipient min-gap flooding
    // guard, enforced ONLY for journey-bound sends (a JourneyBoundary is
    // present) whose journey sets suppress > 0. Slotted ADJACENT to the
    // frequency cap so the skip mirrors it exactly: on a hit there is no
    // provider call, no `email_sends` row, and no throw — the journey run
    // continues. It MUST run AFTER the idempotency short-circuit above: a replay
    // of an already-dispatched send has to return that dup (from its prior
    // `sent` row) BEFORE any suppress evaluation, or the second drive would
    // wrongly re-evaluate suppression for a send that already went out. The
    // verdict itself is RECORDED set-once (see checkJourneySuppress) so it is
    // replay-stable. Non-journey sends (no boundary: transactional API /
    // password-reset flows) are inert here.
    const boundary = getJourneyBoundary();
    const suppress = await checkJourneySuppress({
      db,
      boundary,
      to: options.to,
      idempotencyKey: options.idempotencyKey,
    });
    if (suppress.suppressed) {
      logger?.info("send skipped: journey_suppressed", {
        to: options.to,
        journeyId: boundary?.journeyId,
      });
      return trackedSendResult({
        emailSendId: "",
        messageId: "",
        status: "skipped",
        reason: "journey_suppressed",
      });
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

  // Test-mode redirect — resolved AFTER the original-recipient preference checks
  // above (suppression/frequency/unsubscribe), so preferences belong to the real
  // user. Hard-fail branch: active but unaddressable ⇒ write a `failed` row with
  // the metadata marker (so Studio surfaces the blocked send) and return a
  // skipped result. The provider is NEVER reached — the real recipient must not
  // receive mail from an unverified domain just because no test inbox is set.
  if (redirectActive && testMode && isUnaddressable(testMode)) {
    (logger ?? emitLogger).error(NO_REDIRECT_MESSAGE, {
      originalTo: options.to,
      templateKey: options.templateKey,
    });
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
        metadata: { testMode: true, originalTo: options.to },
      })
      .returning({ id: emailSends.id });
    const blockedRow = rows[0];
    if (!blockedRow) throw new Error("Failed to insert email_sends row");
    return trackedSendResult({
      emailSendId: blockedRow.id,
      messageId: "",
      status: "skipped",
      reason: "test_mode_blocked",
    });
  }

  // Active + addressable: compute the redirected wire fields ONCE. `email_sends`
  // records what ACTUALLY went out the wire (redirect inbox, prefixed subject,
  // effective from) plus the `metadata.originalTo` marker, while preferences
  // above stayed keyed to `options.to`.
  const redirect =
    redirectActive && testMode
      ? buildRedirect({
          from: options.from,
          to: options.to,
          subject,
          state: testMode,
        })
      : null;
  if (redirect && testMode) {
    logRedirect(logger ?? emitLogger, {
      originalTo: redirect.originalTo,
      redirectTo: testMode.redirectTo,
      reason: testMode.reason,
    });
  }
  const wireTo = redirect ? redirect.to : options.to;
  const wireSubject = redirect ? redirect.subject : subject;
  const wireFrom = redirect ? redirect.from : options.from;

  // Re-driving an orphaned "queued" row (crash before the provider returned):
  // reuse that row instead of inserting a second one, so the provider call is
  // re-attempted while the unique idempotency key stays honored.
  let emailSendId: string;
  if (reuseRowId) {
    emailSendId = reuseRowId;
  } else {
    const baseInsert = db.insert(emailSends).values({
      templateKey: options.templateKey,
      fromEmail: wireFrom,
      toEmail: redirect ? redirect.redirectTo : options.to,
      subject: wireSubject,
      category: effectiveCategory,
      journeyStateId: options.journeyStateId,
      userId: options.userId,
      userEmail: options.userEmail ?? options.to,
      status: "queued",
      idempotencyKey: options.idempotencyKey,
      ...(redirect
        ? { metadata: { testMode: true, originalTo: options.to } }
        : {}),
    });

    // With an idempotency key, swallow a concurrent-insert collision on the
    // unique index (the select-then-insert above is not atomic) and return the
    // winner.
    const insertRows = options.idempotencyKey
      ? await baseInsert
          .onConflictDoNothing({ target: emailSends.idempotencyKey })
          .returning({ id: emailSends.id })
      : await baseInsert.returning({ id: emailSends.id });

    const insertedRow = insertRows[0];
    if (!insertedRow && options.idempotencyKey) {
      // A concurrent send claimed the key first — return its row, UNLESS it is
      // an orphaned "queued" row (crash mid-send), in which case re-drive it.
      const winner = await db
        .select({ id: emailSends.id, status: emailSends.status })
        .from(emailSends)
        .where(eq(emailSends.idempotencyKey, options.idempotencyKey))
        .limit(1);
      const won = winner[0];
      if (won) {
        if (won.status !== "queued") {
          return idempotentResult(won);
        }
        emailSendId = won.id;
      } else {
        throw new Error("Failed to insert email_sends row");
      }
    } else if (!insertedRow) {
      throw new Error("Failed to insert email_sends row");
    } else {
      emailSendId = insertedRow.id;
    }
  }

  try {
    // HTML-ONLY wire — the engine ALWAYS renders React → HTML itself. When
    // tracking is on (baseUrl + prepareTrackedHtml) we render then rewrite
    // links/inject the open pixel; otherwise we render plain HTML. React Email
    // stays first-class for authoring/Studio; it never crosses the wire.
    const rawHtml = await renderToHtml(sendElement);
    const html =
      options.baseUrl && prepareTrackedHtml
        ? await prepareTrackedHtml({
            html: rawHtml,
            emailSendId,
            baseUrl: options.baseUrl,
            db,
          })
        : rawHtml;

    const result = await provider.send({
      from: wireFrom,
      to: wireTo,
      subject: wireSubject,
      html,
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

    // Fire-and-forget SEND transition log — journey sends only (journeyStateId
    // present). `to` MUST be `send:<site>` where <site> is the EXACT discriminant
    // the mailer embedded in the idempotency key
    // (`journeySend:<anchor>:<site>:<templateKey>`), parsed back out so it equals
    // the id `buildJourneyGraph` emits for this send node (A2) — this joins the
    // log row to the graph node in Phase 3. Recomputing `currentLabel ?? template`
    // would MISS an explicit `idempotencyLabel`, so we reuse the embedded value;
    // fall back to that only when there is no journey `journeySend:` key. Mirrors
    // the fire-and-forget `emitOutbound` call below; never throws into the send.
    if (options.journeyStateId) {
      const boundary = getJourneyBoundary();
      const site =
        (boundary
          ? parseJourneySendSite({
              key: options.idempotencyKey,
              anchor: boundary.runAnchor,
              discriminant: String(options.templateKey),
            })
          : undefined) ??
        boundary?.currentLabel ??
        String(options.templateKey);
      logTransition({
        db,
        journeyStateId: options.journeyStateId,
        to: `send:${site}`,
        action: "send",
        detail: { template: options.templateKey, emailSendId },
      });
    }

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
  // Aggregated across ALL `email_preferences` rows for this address by the shared
  // reader — an address can legitimately have MORE THAN ONE row (multi-row
  // (user_id, email) aggregation rationale lives in readRecipientPreferences).
  const prefs = await readRecipientPreferences(db, { email });

  if (prefs.suppressed) return "suppressed";
  if (prefs.unsubscribedAll) return "unsubscribed";

  // Registry-aware polarity (§2.6, D3) — applied through the SINGLE source of
  // truth `ListRegistry.isSubscribed` so it matches the preference center EXACTLY
  // (categories default to `{}` when there is NO prefs row or NO categories map).
  // This MUST run even when the row is absent/empty: an opt-out list
  // (`defaultOptIn:false`) requires `categories[id] === true` to be subscribed,
  // so absence-of-true (the common "never opted in" case) MUST block — otherwise
  // a contact the preference center shows as "Unsubscribed" would still receive
  // the mail (the two surfaces would disagree, which §2.6 forbids).
  if (category && !getListRegistry().isSubscribed(prefs.categories, category)) {
    return "category_unsubscribed";
  }

  return null;
}
