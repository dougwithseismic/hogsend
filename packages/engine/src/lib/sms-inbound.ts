import type { SmsEvent, SmsProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { contacts, smsSuppressions } from "@hogsend/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Logger } from "./logger.js";
import { upsertEmailPreference } from "./preferences.js";
import { SMS_CHANNEL_ID } from "./sms-tracked.js";

/** Standard opt-out keywords (case-insensitive, punctuation-stripped). */
const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);
/** Standard resubscribe keywords. */
const START_KEYWORDS = new Set(["START", "UNSTOP", "YES"]);
const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

/** Normalize an inbound body to a single keyword token for matching. */
export function normalizeKeyword(body: string): string {
  return body
    .trim()
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase();
}

/**
 * The FIRST whitespace-delimited token, letter-normalized. Matched alongside
 * the whole-message keyword so "STOP texting me" / "STOP please" still opt
 * out — the whole-message normalization concatenates ("STOPTEXTINGME") and
 * misses them. Exact single-keyword matching is the carrier norm, but honoring
 * a leading keyword costs nothing and only ever widens opt-out (never opt-in
 * beyond START itself leading the message).
 */
function firstToken(body: string): string {
  return normalizeKeyword(body.trim().split(/\s+/)[0] ?? "");
}

interface InboundDeps {
  db: Database;
  provider: SmsProvider;
  logger: Logger;
  /** Send STOP/START/HELP confirmation replies (default off). */
  optOutReplies?: boolean;
  from?: string;
}

/**
 * Handle a normalized inbound (mobile-originated) SMS. Detects STOP/START/HELP
 * keywords and records the opt-out in BOTH tracks: the phone-keyed
 * `sms_suppressions` table (authoritative — works even for a number with no
 * contact) and, when the phone resolves to a contact with an email, the `sms`
 * channel category on `email_preferences` (keeps the preference center
 * consistent and reuses the single `upsertEmailPreference` write choke, which
 * emits `contact.unsubscribed`). TCPA/CTIA compliant.
 */
export async function handleInboundSms(
  event: SmsEvent,
  deps: InboundDeps,
): Promise<void> {
  if (event.type !== "sms.inbound" || !event.inbound) return;
  const phone = event.phone;
  const keyword = normalizeKeyword(event.inbound.body);
  const lead = firstToken(event.inbound.body);

  if (STOP_KEYWORDS.has(keyword) || STOP_KEYWORDS.has(lead)) {
    await recordPhoneOptOut(deps.db, phone, "inbound_stop");
    await flipContactChannel(deps.db, phone, false, "stopped_keyword");
    deps.logger.info("sms inbound STOP processed", { phone, keyword });
    if (deps.optOutReplies) {
      await safeReply(
        deps,
        phone,
        "You have been unsubscribed. Reply START to resubscribe.",
      );
    }
    return;
  }

  if (START_KEYWORDS.has(keyword)) {
    await grantPhoneConsent(deps.db, phone, { reason: "inbound_start" });
    await flipContactChannel(deps.db, phone, true, "started_keyword");
    deps.logger.info("sms inbound START processed", { phone, keyword });
    if (deps.optOutReplies) {
      await safeReply(deps, phone, "You have been resubscribed.");
    }
    return;
  }

  if (
    (HELP_KEYWORDS.has(keyword) || HELP_KEYWORDS.has(lead)) &&
    deps.optOutReplies
  ) {
    await safeReply(
      deps,
      phone,
      "Reply STOP to unsubscribe. Msg & data rates may apply.",
    );
  }
}

/** Suppress a phone (STOP / manual). Upsert: re-STOP after START resets the flag. */
export async function recordPhoneOptOut(
  db: Database,
  phone: string,
  reason: "inbound_stop" | "manual",
): Promise<void> {
  const now = new Date();
  await db
    .insert(smsSuppressions)
    .values({ phone, reason, suppressedAt: now })
    .onConflictDoUpdate({
      target: smsSuppressions.phone,
      set: {
        reason,
        suppressedAt: now,
        resubscribedAt: null,
        updatedAt: now,
      },
    });
}

/**
 * Record express phone-level consent: an `sms_suppressions` row with
 * `resubscribed_at` set. Under the explicit opt-in model this row IS the
 * consent record for a number with no (or a phone-only) contact — texting
 * START is express consent, so a fresh START with no prior STOP row must
 * still grant (hence upsert, not update).
 */
export async function grantPhoneConsent(
  db: Database,
  phone: string,
  opts?: { reason?: "inbound_start" | "api_grant" },
): Promise<void> {
  const now = new Date();
  await db
    .insert(smsSuppressions)
    .values({
      phone,
      reason: opts?.reason ?? "inbound_start",
      suppressedAt: now,
      resubscribedAt: now,
    })
    .onConflictDoUpdate({
      target: smsSuppressions.phone,
      set: { resubscribedAt: now, updatedAt: now },
    });
}

/**
 * When the phone resolves to a contact with an email, flip the `sms` channel
 * category on `email_preferences` so the preference center agrees with the
 * suppression list. `false` emits `contact.unsubscribed`; `true` (a consent
 * grant) emits `contact.subscribed` — both from the single write choke, with
 * the keyword provenance in `source`.
 */
async function flipContactChannel(
  db: Database,
  phone: string,
  subscribed: boolean,
  source: string,
): Promise<void> {
  const rows = await db
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      email: contacts.email,
    })
    .from(contacts)
    .where(and(eq(contacts.phone, phone), isNull(contacts.deletedAt)))
    .limit(1);
  const contact = rows[0];
  if (!contact?.email) return;
  await upsertEmailPreference({
    db,
    externalId: contact.externalId ?? contact.id,
    email: contact.email,
    update: { categoryKey: SMS_CHANNEL_ID, categoryValue: subscribed },
    source,
  });
}

/** Send a confirmation reply, swallowing errors (never fail the webhook). */
async function safeReply(
  deps: InboundDeps,
  to: string,
  body: string,
): Promise<void> {
  try {
    await deps.provider.send({ to, body, from: deps.from });
  } catch (err) {
    deps.logger.warn("sms confirmation reply failed", {
      to,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
