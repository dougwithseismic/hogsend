import { randomUUID } from "node:crypto";
import type { SmsProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { smsSends, smsSuppressions, trackedLinks } from "@hogsend/db";
import {
  countSmsSegments,
  getSmsTemplate,
  renderSmsToText,
  type SmsTemplateName,
  type SmsTemplateRegistry,
} from "@hogsend/sms";
import { eq } from "drizzle-orm";
import {
  deriveJourneyKey,
  getJourneyBoundary,
  registerKey,
} from "../journeys/journey-boundary.js";
import { logTransition } from "../journeys/journey-log.js";
import { getListRegistry } from "../lists/registry-singleton.js";
import type { FrequencyCapConfig } from "./email-service-types.js";
import { hatchet } from "./hatchet.js";
import { isGlobalControl } from "./holdout.js";
import { checkJourneySuppress } from "./journey-suppress.js";
import { createLogger, type Logger } from "./logger.js";
import { emitOutbound } from "./outbound.js";
import { readRecipientPreferences } from "./preferences.js";
import { isSmsFrequencyCapped } from "./sms-frequency-cap.js";
import {
  isShortCodeCollision,
  planSmsLinkRewrite,
  type SmsLinkRewritePlan,
} from "./sms-link-tracking.js";
import type {
  SendTrackedSmsOptions,
  SmsTrackedSendResult,
} from "./sms-service-types.js";

const emitLogger = createLogger(process.env.LOG_LEVEL);

/** The engine-synthesized SMS channel list id (opt-out polarity). */
export const SMS_CHANNEL_ID = "sms";

interface TrackedSmsDeps {
  db: Database;
  provider: SmsProvider;
  registry: SmsTemplateRegistry;
  frequencyCap?: FrequencyCapConfig;
  logger?: Logger;
  /** `false` disables the STOP footer; a string overrides the default text. */
  stopFooter?: string | false;
  /** Container-wired test-mode resolver (validated env). Absent ⇒ never active. */
  testMode?: () => boolean;
  /** Redirect target while test mode is active (env.HOGSEND_TEST_PHONE). */
  testPhone?: string;
  /** Rewrite bare URLs to first-party short tracked links. Default true. */
  linkTracking?: boolean;
  /** Full origin short links are minted under; rewriting is skipped if absent. */
  linkHost?: string;
}

/**
 * Boundary-aware entry point mirroring {@link sendTrackedEmail}. A raw-service
 * SMS send from INSIDE a journey (no idempotency key set) is auto-keyed with the
 * `smsSend` kind so the engine's exactly-once guarantee covers it. Outside a
 * journey, or with a key already set, this is a transparent pass-through.
 */
export async function sendTrackedSms<K extends SmsTemplateName>(
  opts: TrackedSmsDeps & { options: SendTrackedSmsOptions<K> },
): Promise<SmsTrackedSendResult> {
  const boundary = getJourneyBoundary();
  if (!boundary) return sendTrackedSmsInner(opts);

  // Inside a journey run the engine KNOWS the enrollment — default the
  // attribution to the boundary's state id so authors never hand-thread it.
  // An explicit journeyStateId (cross-enrollment sends) still wins. Without
  // this, a forgotten journeyStateId silently blinds transition logs AND the
  // meta.suppress min-gap guard.
  const attributed = {
    ...opts,
    options: {
      ...opts.options,
      journeyStateId: opts.options.journeyStateId ?? boundary.stateId,
    },
  };
  if (attributed.options.idempotencyKey) {
    return sendTrackedSmsInner(attributed);
  }

  const site = boundary.currentLabel ?? String(opts.options.templateKey);
  const key = deriveJourneyKey({
    kind: "smsSend",
    anchor: boundary.runAnchor,
    site,
    discriminant: String(opts.options.templateKey),
  });
  registerKey(boundary, key);
  const keyed = {
    ...attributed,
    options: { ...attributed.options, idempotencyKey: key },
  };
  return boundary.memoize([key], () => sendTrackedSmsInner(keyed));
}

/**
 * The result for a keyed send that found an already-DISPATCHED row under its
 * key: `sent` (or `delivered` — the webhook advanced it) is a satisfied
 * duplicate. Any other status is defensively skipped (a `failed` row releases
 * its key, so it can't actually collide).
 */
function duplicateResult(row: {
  id: string;
  status: string;
}): SmsTrackedSendResult {
  return {
    smsSendId: row.id,
    messageId: "",
    status:
      row.status === "sent" || row.status === "delivered" ? "sent" : "skipped",
  };
}

async function sendTrackedSmsInner<K extends SmsTemplateName>(
  opts: TrackedSmsDeps & { options: SendTrackedSmsOptions<K> },
): Promise<SmsTrackedSendResult> {
  const {
    db,
    provider,
    registry,
    frequencyCap,
    logger,
    stopFooter,
    linkTracking,
    linkHost,
    options,
  } = opts;

  // Idempotency short-circuit: a dispatched prior row is a satisfied
  // duplicate; an orphaned `queued` row (crash before the provider returned) is
  // REUSED and re-driven — with its STORED body (see below). A `failed` row
  // released its key, so it never collides.
  let reuseRow: { id: string; body: string; toPhone: string } | undefined;
  if (options.idempotencyKey) {
    const existing = await db
      .select({
        id: smsSends.id,
        status: smsSends.status,
        body: smsSends.body,
        toPhone: smsSends.toPhone,
      })
      .from(smsSends)
      .where(eq(smsSends.idempotencyKey, options.idempotencyKey))
      .limit(1);
    const prior = existing[0];
    if (prior) {
      if (prior.status === "queued") {
        reuseRow = prior;
      } else {
        return duplicateResult(prior);
      }
    }
  }

  const { element, category: templateCategory } = getSmsTemplate({
    key: options.templateKey,
    props: options.props,
    registry,
  });
  const effectiveCategory = options.category ?? templateCategory;

  // The suppression/consent gate runs UNCONDITIONALLY: `exempt` (transactional
  // or skipPreferenceCheck) bypasses only the consent + topic gates inside it —
  // never the phone STOP list or unsubscribed_all. Twilio 21610 enforces STOP
  // at the carrier anyway; bypassing it first-party would only produce failed
  // provider calls and compliance exposure.
  const exempt =
    options.skipPreferenceCheck === true ||
    effectiveCategory === "transactional";
  {
    const suppression = await checkSmsSuppression(db, {
      phone: options.to,
      userId: options.userId,
      category: effectiveCategory,
      exempt,
    });
    if (suppression) {
      const rows = await db
        .insert(smsSends)
        .values({
          templateKey: options.templateKey,
          fromPhone: options.from,
          toPhone: options.to,
          body: "",
          category: effectiveCategory,
          journeyStateId: options.journeyStateId,
          userId: options.userId,
          status: "failed",
          metadata: { suppressionReason: suppression },
          // A suppressed send does NOT consume the idempotency key — a later
          // retry (after re-subscribe / a consent grant) can then actually
          // attempt the send.
        })
        .returning({ id: smsSends.id });
      const row = rows[0];
      if (!row) throw new Error("Failed to insert sms_sends row");
      return {
        smsSendId: row.id,
        messageId: "",
        status:
          suppression === "no_consent"
            ? "no_consent"
            : suppression === "unsubscribed" || suppression === "channel_off"
              ? "unsubscribed"
              : "suppressed",
      };
    }
  }

  if (!options.skipPreferenceCheck) {
    // Global control group (impact plan §4.3) — the SMS leg of the email
    // gate in tracked.ts: same deterministic bucket, same key precedence
    // (userId when known, else the recipient address), same marker emit
    // (per-endpoint deduped on the contact key), so a contact with a stable
    // userId is controlled consistently across channels.
    if (effectiveCategory !== "transactional") {
      const controlKey = options.userId ?? options.to;
      if (isGlobalControl(controlKey)) {
        logger?.info("sms skipped: control_group", { to: options.to });
        void emitOutbound({
          db,
          hatchet,
          logger: logger ?? emitLogger,
          event: "contact.control_group",
          dedupeKey: `contact.control_group:${controlKey.toLowerCase()}`,
          payload: {
            userId: options.userId ?? null,
            email: null,
            at: new Date().toISOString(),
          },
        }).catch((err: unknown) => {
          (logger ?? emitLogger).warn("control_group marker emit failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return {
          smsSendId: "",
          messageId: "",
          status: "skipped",
          reason: "control_group",
        };
      }
    }

    if (frequencyCap) {
      const capped = await isSmsFrequencyCapped({
        db,
        to: options.to,
        category: options.category,
        config: frequencyCap,
      });
      if (capped) {
        logger?.info("sms skipped: frequency_capped", { to: options.to });
        return {
          smsSendId: "",
          messageId: "",
          status: "skipped",
          reason: "frequency_capped",
        };
      }
    }

    // Journey suppress (`meta.suppress`) — the same per-recipient min-gap
    // flooding guard the email pipeline enforces (tracked.ts), running against
    // SMS send history. Placed after the idempotency short-circuit (a replayed
    // already-dispatched send must return its dup first) and recorded set-once
    // so the verdict is replay-stable. Inert outside a journey boundary.
    const boundary = getJourneyBoundary();
    const suppress = await checkJourneySuppress({
      db,
      boundary,
      to: options.to,
      idempotencyKey: options.idempotencyKey,
      channel: "sms",
    });
    if (suppress.suppressed) {
      logger?.info("sms skipped: journey_suppressed", {
        to: options.to,
        journeyId: boundary?.journeyId,
      });
      return {
        smsSendId: "",
        messageId: "",
        status: "skipped",
        reason: "journey_suppressed",
      };
    }
  }

  // Test mode: redirect to HOGSEND_TEST_PHONE (block when unset). Preference
  // checks above stayed keyed to the ORIGINAL recipient. The resolver is
  // container-wired (validated env + email-side auto-arm coherence) — never a
  // raw process.env read here.
  const testActive = opts.testMode?.() ?? false;
  const testPhone = opts.testPhone;

  let smsSendId: string;
  let wireTo: string;
  let wireBody: string;

  if (reuseRow) {
    // Re-drive of an orphaned queued row (crash replay): wire the STORED body
    // verbatim — it already carries the rewritten short links, footer, and any
    // test prefix from the first drive, and its tracked_links rows were
    // committed atomically with it. Re-rendering + re-rewriting here would
    // mint duplicate tracked rows with fresh codes on every replay.
    if (testActive && !testPhone) {
      (logger ?? emitLogger).error(
        "SMS test mode active but HOGSEND_TEST_PHONE is unset; send blocked",
        { originalTo: options.to, templateKey: options.templateKey },
      );
      return {
        smsSendId: reuseRow.id,
        messageId: "",
        status: "skipped",
        reason: "test_mode_blocked",
      };
    }
    smsSendId = reuseRow.id;
    wireTo = testActive && testPhone ? testPhone : reuseRow.toPhone;
    wireBody = reuseRow.body;
  } else {
    // Render React → text, rewrite bare URLs to first-party short links, then
    // append the compliance STOP footer. The rewrite sits BEFORE the footer +
    // test prefix (neither carries URLs) so ONE final string flows to the
    // stored row, the segment count, and the provider wire. `derive` is
    // re-runnable — a short-code unique collision rolls the transaction back
    // and replans with fresh codes.
    const rawBody = await renderSmsToText(element);
    const rewriteEnabled = linkTracking !== false && Boolean(linkHost);
    const derive = (): { plan: SmsLinkRewritePlan; body: string } => {
      const plan: SmsLinkRewritePlan = rewriteEnabled
        ? planSmsLinkRewrite({ body: rawBody, linkHost: linkHost as string })
        : { body: rawBody, links: [] };
      return {
        plan,
        body: applyStopFooter({
          body: plan.body,
          category: effectiveCategory,
          skipPreferenceCheck: options.skipPreferenceCheck,
          stopFooter,
        }),
      };
    };
    let attempt = derive();

    if (testActive && !testPhone) {
      (logger ?? emitLogger).error(
        "SMS test mode active but HOGSEND_TEST_PHONE is unset; send blocked",
        { originalTo: options.to, templateKey: options.templateKey },
      );
      const rows = await db
        .insert(smsSends)
        .values({
          templateKey: options.templateKey,
          fromPhone: options.from,
          toPhone: options.to,
          body: attempt.body,
          category: effectiveCategory,
          journeyStateId: options.journeyStateId,
          userId: options.userId,
          status: "failed",
          metadata: { testMode: true, originalTo: options.to },
        })
        .returning({ id: smsSends.id });
      const row = rows[0];
      if (!row) throw new Error("Failed to insert sms_sends row");
      return {
        smsSendId: row.id,
        messageId: "",
        status: "skipped",
        reason: "test_mode_blocked",
      };
    }

    const applyTestPrefix = (body: string): string =>
      testActive && testPhone ? `[TEST → ${options.to}] ${body}` : body;
    wireTo = testActive && testPhone ? testPhone : options.to;
    wireBody = applyTestPrefix(attempt.body);

    // Insert the queued row AND its tracked_links in ONE transaction: the FK
    // forces the order, and atomicity means no queued row ever exists whose
    // short codes have no tracked rows (a crash window that would send dead
    // links), while a code collision rolls back cleanly for a full replan.
    // The concurrent idempotency-key LOSER adopts the winner's stored
    // body/toPhone — its own rewritten codes were rolled back with the losing
    // insert.
    let resolvedId: string | undefined;
    for (let tries = 0; tries < 3 && resolvedId === undefined; tries++) {
      const rowId = randomUUID();
      const pending = attempt.plan.links;
      let inserted = false;
      try {
        inserted = await db.transaction(async (tx) => {
          const baseInsert = tx.insert(smsSends).values({
            id: rowId,
            templateKey: options.templateKey,
            fromPhone: options.from,
            toPhone: wireTo,
            body: wireBody,
            category: effectiveCategory,
            journeyStateId: options.journeyStateId,
            userId: options.userId,
            status: "queued",
            idempotencyKey: options.idempotencyKey,
            ...(testActive && testPhone
              ? { metadata: { testMode: true, originalTo: options.to } }
              : {}),
          });
          const insertRows = options.idempotencyKey
            ? await baseInsert
                .onConflictDoNothing({ target: smsSends.idempotencyKey })
                .returning({ id: smsSends.id })
            : await baseInsert.returning({ id: smsSends.id });
          if (!insertRows[0]) return false;
          if (pending.length > 0) {
            await tx.insert(trackedLinks).values(
              pending.map((link) => ({
                smsSendId: rowId,
                source: "sms",
                originalUrl: link.originalUrl,
                shortCode: link.shortCode,
              })),
            );
          }
          return true;
        });
      } catch (err) {
        if (!isShortCodeCollision(err) || tries === 2) throw err;
        attempt = derive();
        wireBody = applyTestPrefix(attempt.body);
        continue;
      }

      if (inserted) {
        resolvedId = rowId;
        break;
      }
      // Idempotency-key loser: adopt the winner (nothing of ours committed).
      const winner = await db
        .select({
          id: smsSends.id,
          status: smsSends.status,
          body: smsSends.body,
          toPhone: smsSends.toPhone,
        })
        .from(smsSends)
        .where(eq(smsSends.idempotencyKey, options.idempotencyKey ?? ""))
        .limit(1);
      const won = winner[0];
      if (!won) throw new Error("Failed to insert sms_sends row");
      if (won.status !== "queued") return duplicateResult(won);
      resolvedId = won.id;
      wireBody = won.body;
      wireTo = testActive && testPhone ? testPhone : won.toPhone;
    }
    if (resolvedId === undefined) {
      throw new Error("Failed to insert sms_sends row");
    }
    smsSendId = resolvedId;
  }

  try {
    const segments = countSmsSegments(wireBody).segments;
    const result = await provider.send({
      from: options.from,
      to: wireTo,
      body: wireBody,
    });

    const sentAt = new Date();
    await db
      .update(smsSends)
      .set({
        messageId: result.id,
        status: "sent",
        segments,
        sentAt,
        updatedAt: sentAt,
      })
      .where(eq(smsSends.id, smsSendId));

    if (options.journeyStateId) {
      logTransition({
        db,
        journeyStateId: options.journeyStateId,
        to: `sms:${String(options.templateKey)}`,
        action: "send",
        detail: { template: String(options.templateKey), smsSendId },
      });
    }

    void emitOutbound({
      db,
      hatchet,
      logger: logger ?? emitLogger,
      event: "sms.sent",
      dedupeKey: `sms.sent:${smsSendId}`,
      payload: {
        smsSendId,
        messageId: result.id,
        templateKey: String(options.templateKey),
        to: options.to,
        userId: options.userId ?? null,
        category: effectiveCategory ?? null,
        journeyStateId: options.journeyStateId ?? null,
        segments,
        sentAt: sentAt.toISOString(),
      },
    }).catch((err: unknown) => {
      (logger ?? emitLogger).warn("emitOutbound sms.sent failed", {
        smsSendId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return { smsSendId, messageId: result.id, status: "sent" };
  } catch (error) {
    // Provider send failed. Stamp `failed` AND release the idempotency key so a
    // retry genuinely re-attempts (mirrors the email pipeline).
    await db
      .update(smsSends)
      .set({ status: "failed", idempotencyKey: null, updatedAt: new Date() })
      .where(eq(smsSends.id, smsSendId));
    throw error;
  }
}

type SmsSuppressionReason =
  | "suppressed"
  | "unsubscribed"
  | "channel_off"
  | "no_consent"
  | null;

/**
 * Resolve whether an SMS send to `phone` must be suppressed. The consent model
 * is EXPLICIT OPT-IN (TCPA prior-express-consent):
 *
 *  1. Phone track (`sms_suppressions`, tri-state, checked UNCONDITIONALLY —
 *     `exempt` never bypasses it): an ACTIVE row (`resubscribed_at IS NULL`,
 *     STOP / permanent carrier fail) blocks everything; a RESUBSCRIBED row
 *     (`resubscribed_at` set — an inbound START or an API grant for a
 *     phone-only contact) is express phone-level consent; no row is neither.
 *  2. `unsubscribed_all` on the contact's `email_preferences` — the master
 *     opt-out, also never bypassed.
 *  3. `exempt` (transactional / skipPreferenceCheck) short-circuits ONLY the
 *     consent + topic gates below this point.
 *  4. The `sms` channel gate: an explicit `categories.sms === false` (STOP /
 *     preference-center off) blocks even with phone consent; otherwise the
 *     send needs an explicit grant — `categories.sms === true` (the channel
 *     registers `defaultOptIn: false`) OR phone-track consent. A send with no
 *     resolvable `userId` and no phone consent fails CLOSED (`no_consent`).
 *  5. The topic-category gate (unchanged; topic lists keep their own polarity).
 *
 * The email-transport `suppressed` flag is NOT consumed (hard-bounce /
 * complaint is email-specific).
 */
async function checkSmsSuppression(
  db: Database,
  opts: {
    phone: string;
    userId?: string;
    category?: string;
    exempt?: boolean;
  },
): Promise<SmsSuppressionReason> {
  const phoneRows = await db
    .select({ resubscribedAt: smsSuppressions.resubscribedAt })
    .from(smsSuppressions)
    .where(eq(smsSuppressions.phone, opts.phone))
    .limit(1);
  const phoneRow = phoneRows[0];
  if (phoneRow && phoneRow.resubscribedAt === null) return "suppressed";
  const phoneConsent = phoneRow != null;

  const prefs = opts.userId
    ? await readRecipientPreferences(db, { userId: opts.userId })
    : null;
  if (prefs?.unsubscribedAll) return "unsubscribed";

  if (opts.exempt) return null;

  const registry = getListRegistry();
  if (prefs?.categories[SMS_CHANNEL_ID] === false) return "channel_off";
  const granted =
    (prefs != null &&
      registry.isSubscribed(prefs.categories, SMS_CHANNEL_ID)) ||
    phoneConsent;
  if (!granted) return "no_consent";

  if (
    opts.category &&
    prefs &&
    !registry.isSubscribed(prefs.categories, opts.category)
  ) {
    return "unsubscribed";
  }
  return null;
}

function applyStopFooter(opts: {
  body: string;
  category?: string;
  skipPreferenceCheck?: boolean;
  stopFooter?: string | false;
}): string {
  if (opts.stopFooter === false) return opts.body;
  if (opts.skipPreferenceCheck) return opts.body;
  if (opts.category === "transactional") return opts.body;
  // Skip only when the body already carries an opt-out INSTRUCTION ("Reply
  // STOP…", "Text STOP…"), not when prose merely contains the word "stop" —
  // "Don't stop now!" must still get the compliance footer.
  if (/\b(?:reply|text|send)\s+stop\b/i.test(opts.body)) return opts.body;
  const footer = opts.stopFooter ?? "Reply STOP to opt out";
  return `${opts.body}\n\n${footer}`;
}
