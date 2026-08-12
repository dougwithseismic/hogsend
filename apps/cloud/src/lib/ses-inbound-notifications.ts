import { createHash } from "node:crypto";
import type { SubstrateRegion } from "../substrate/types";

/**
 * SES's INBOUND (`Received`) notification JSON -> the values the receive
 * endpoint acts on.
 *
 * Pure over its input: no S3, no database, no clock. Everything it returns is
 * something SES stated, and the two things it refuses to return are the two
 * that would matter later:
 *
 *  - **an S3 pointer we did not provision.** The bucket and key ride in the
 *    payload, and "fetch whatever object this message names" is a read
 *    primitive an attacker who ever reached this endpoint would enjoy. The SNS
 *    signature already stops them, and a second lock costs one comparison: the
 *    bucket must be the region's CONFIGURED bucket and the key must sit under
 *    the prefix our own receipt rules write to;
 *  - **a notification with no recipient.** The envelope recipient is the ONLY
 *    tenant-identifying fact in a received message, because every header is
 *    written by the sender. A payload without one is not a message we can
 *    attribute, and must never be guessed at from `To:`.
 *
 * `mail.headers` is deliberately IGNORED here even though SES includes it. It
 * is capped at 10 KB and silently truncated (`headersTruncated`), so a message
 * whose correlation header fell off the end would read as an uncorrelated reply
 * rather than a truncated one. The raw MIME in S3 is the single source of truth
 * for headers; see `lib/inbound-mime.ts`.
 */

/** SES's own `notificationType` for a received message. */
export const SES_INBOUND_NOTIFICATION_TYPE = "Received";

export interface SesInboundNotification {
  /** SES's id for the RECEIVED message; also the S3 object's basename. */
  sesMessageId: string;
  /** Every envelope recipient SES matched, in SES's own order. */
  recipients: string[];
  bucket: string;
  objectKey: string;
  /** When SES received it, ISO-8601 with a `Z` offset. */
  receivedAt: string;
  /** `PASS` / `FAIL` / ... as SES stated them, or null when scanning was off. */
  spamVerdict: string | null;
  virusVerdict: string | null;
  /** Stable across redeliveries of the same received message. */
  dedupeKey: string;
}

/** Why a notification was not usable. */
export type SesInboundRejection =
  | "not_received"
  | "no_message_id"
  | "no_recipients"
  | "no_store_action"
  | "foreign_bucket"
  | "foreign_prefix"
  | "no_timestamp";

export type SesInboundParse =
  | { ok: true; notification: SesInboundNotification }
  | { ok: false; reason: SesInboundRejection };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** A verdict block is `{ status: "PASS" }`; scanning off means no block at all. */
function verdict(value: unknown): string | null {
  return str(record(value)?.status) ?? null;
}

/**
 * The stable identity of ONE received message.
 *
 * Derived from SES's `mail.messageId` rather than the SNS envelope's own
 * `MessageId`, for the reason `sesEventDedupeKey` gives: the envelope id is
 * unique per PUBLISH, so a redelivery would arrive with a fresh one and defeat
 * the collapse entirely. The region is folded in because the two regional
 * endpoints are separate topics writing one table.
 */
export function sesInboundDedupeKey(input: {
  region: SubstrateRegion;
  sesMessageId: string;
}): string {
  // A plain separator is safe HERE, unlike `sesEventDedupeKey`'s NUL, because
  // the arity is fixed and the first two components are closed vocabularies:
  // no two distinct inputs can canonicalize to the same string.
  const canonical = ["inbound", input.region, input.sesMessageId].join(":");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Normalize one SES inbound notification, or say why it is unusable.
 *
 * A rejection is an ORDINARY answer, not an error: SES publishing something
 * this endpoint does not consume is a provisioning bug to fix, never a reason
 * to fail the HTTP delivery and have SNS retry it for days.
 */
export function parseSesInboundNotification(
  payload: unknown,
  expected: {
    bucket: string;
    objectKeyPrefix: string;
    region: SubstrateRegion;
  },
): SesInboundParse {
  const notification = record(payload);
  if (str(notification?.notificationType) !== SES_INBOUND_NOTIFICATION_TYPE) {
    return { ok: false, reason: "not_received" };
  }

  const mail = record(notification?.mail);
  const receipt = record(notification?.receipt);
  const sesMessageId = str(mail?.messageId);
  if (!sesMessageId) return { ok: false, reason: "no_message_id" };

  // The ENVELOPE recipients (`RCPT TO`), which is what a receipt rule matched
  // on. NOT `mail.destination` and NOT `To:`, both of which are sender-written:
  // attributing a tenant from a sender-written field is the whole boundary
  // gone. `receipt.recipients` is SES stating who it accepted this for.
  const recipients = strings(receipt?.recipients);
  if (recipients.length === 0) return { ok: false, reason: "no_recipients" };

  const action = record(receipt?.action);
  const bucket = str(action?.bucketName);
  const objectKey = str(action?.objectKey);
  if (str(action?.type) !== "S3" || !bucket || !objectKey) {
    return { ok: false, reason: "no_store_action" };
  }
  // Both locks. Neither is reachable past the SNS signature; they are here so
  // that if it ever is, the worst this endpoint can be made to do is read an
  // object our own receipt rules wrote.
  if (bucket !== expected.bucket)
    return { ok: false, reason: "foreign_bucket" };
  if (!objectKey.startsWith(expected.objectKeyPrefix)) {
    return { ok: false, reason: "foreign_prefix" };
  }

  const receivedAt = instant(receipt?.timestamp, mail?.timestamp);
  if (!receivedAt) return { ok: false, reason: "no_timestamp" };

  return {
    ok: true,
    notification: {
      sesMessageId,
      recipients,
      bucket,
      objectKey,
      receivedAt,
      spamVerdict: verdict(receipt?.spamVerdict),
      virusVerdict: verdict(receipt?.virusVerdict),
      dedupeKey: sesInboundDedupeKey({
        region: expected.region,
        sesMessageId,
      }),
    },
  };
}

/**
 * An ISO-8601 instant with a `Z` offset. Normalized through `Date` so a
 * malformed value fails HERE, where there is still a fallback, rather than at
 * the instance where it would be a silently rejected webhook.
 */
function instant(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const value = str(candidate);
    if (!value) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}
