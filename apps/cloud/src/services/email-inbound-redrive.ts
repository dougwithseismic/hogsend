import { and, asc, gte, isNotNull, isNull, lte } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { emailInboundMessages } from "../db/schema";
import type { ParsedInboundMessage } from "../lib/inbound-mime";
import { parseInboundMime } from "../lib/inbound-mime";
import type {
  ForwardInboundInput,
  ForwardInboundOutcome,
} from "./email-inbound-forward";
import { forwardInboundMessage } from "./email-inbound-forward";
import type { InboundObjectFetcher } from "./email-inbound-objects";
import {
  fetchInboundObject,
  MAX_INBOUND_OBJECT_BYTES,
} from "./email-inbound-objects";
import type { InboundRecipientOwner } from "./ses-inbound-config";
import { findInboundRecipientOwner } from "./ses-inbound-config";

/**
 * THE STUCK-FORWARD RE-DRIVE (the automatic half of PRD 16 task 6).
 *
 * The mandatory forward (`email-inbound-forward.ts`) runs LAST on the receive
 * path and never gates durability, so a TRANSIENT send failure — a throttled
 * SES, a tenant still mid-provision — settles the inbound row terminal
 * (`delivered`/`suppressed`) with only `forward_error` set. `mayBeClaimable`
 * returns false for a terminal row, so no SNS redelivery re-drives it; the row
 * lands on `forwarded_at IS NULL AND forward_error IS NOT NULL`, and without
 * this sweep that list is the OPERATOR's re-drive list and nothing else. The
 * human whose reply we accepted only hears back when a person notices.
 *
 * This is the cron that notices for them. It re-fetches the stored MIME, rebuilds
 * the same forward the receive path would have sent, and hands it back to
 * `forwardInboundMessage`, whose `forwarded_at IS NULL` guard makes the retry
 * idempotent (a re-drive that already sent is `already_forwarded`, and a success
 * clears `forward_error` in the same conditional write).
 *
 * BOUNDED three ways so it never becomes a thundering herd or an infinite loop:
 *  - a small per-tick LIMIT, serially;
 *  - a MIN-STALE floor on `updated_at`, so a row whose live forward failure was
 *    recorded seconds ago is not raced by this sweep;
 *  - a MAX-AGE ceiling on `created_at`. No forward-attempt counter exists on the
 *    row, so time is the bound: a forward that has been failing for longer than
 *    {@link DEFAULT_FORWARD_REDRIVE_MAX_AGE_MS} is a DIFFERENT kind of failure (a
 *    revoked tenant, a mailbox that no longer exists), and re-driving it forever
 *    buries the signal. Past the ceiling the row stays on the operator's list —
 *    the raw MIME is still in S3, so nothing is lost — rather than being retried
 *    for eternity.
 */

/** Every five minutes — the same cadence as the provision sweep. */
export const INBOUND_FORWARD_REDRIVE_CRON = "*/5 * * * *";

/** Rows re-driven per tick. Small and serial; forwards are rare. */
export const DEFAULT_FORWARD_REDRIVE_LIMIT = 20;

/**
 * How settled a `forward_error` must be before this sweep touches it. Long
 * enough that the live receive request that recorded the failure has certainly
 * returned, so the sweep never races the request that just settled the row.
 */
export const DEFAULT_FORWARD_REDRIVE_MIN_STALE_MS = 60 * 1000;

/**
 * The oldest a stuck row may be and still be re-driven. Time is the bound
 * because the row carries no forward-attempt counter (see the module comment):
 * past this age the failure is no longer transient, and the row is left for an
 * operator rather than retried forever.
 */
export const DEFAULT_FORWARD_REDRIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The forward, as a seam. See `email-inbound-forward.ts`. */
export type InboundForwarder = (
  input: ForwardInboundInput,
) => Promise<ForwardInboundOutcome>;

export interface ForwardRedriveOptions {
  db?: CloudDb;
  now?: () => number;
  limit?: number;
  minStaleMs?: number;
  maxAgeMs?: number;
  maxObjectBytes?: number;
  /** The S3 read seam. Injected so no test reaches AWS. */
  fetchObject?: InboundObjectFetcher;
  /** The forward seam. Injected so no test reaches SES. */
  forward?: InboundForwarder;
  /** The recipient → forwarding-address lookup. Injected for tests. */
  resolveOwner?: (recipient: string) => Promise<InboundRecipientOwner | null>;
}

export interface ForwardRedriveResult {
  /** Rows this tick re-forwarded (or found already forwarded). */
  forwarded: string[];
  /** Rows whose forward failed again — still stuck, tried next tick. */
  stillFailing: string[];
  /** Rows whose inbound config has since disappeared — nowhere to forward. */
  skipped: string[];
}

/**
 * Re-drive a bounded batch of forwards that failed transiently.
 *
 * Selects `forwarded_at IS NULL AND forward_error IS NOT NULL` rows that are
 * settled, resolved and not too old, rebuilds each forward from the stored MIME,
 * and retries it. Never throws: `forwardInboundMessage` records its own failures
 * on the row, and a per-row problem is caught and counted rather than aborting
 * the batch.
 */
export async function redriveStuckForwards(
  options: ForwardRedriveOptions = {},
): Promise<ForwardRedriveResult> {
  const db = options.db ?? defaultDb;
  const now = options.now ? options.now() : Date.now();
  const limit = options.limit ?? DEFAULT_FORWARD_REDRIVE_LIMIT;
  const minStaleMs = options.minStaleMs ?? DEFAULT_FORWARD_REDRIVE_MIN_STALE_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_FORWARD_REDRIVE_MAX_AGE_MS;
  const maxObjectBytes = options.maxObjectBytes ?? MAX_INBOUND_OBJECT_BYTES;
  const fetchObject = options.fetchObject ?? fetchInboundObject;
  const forward =
    options.forward ?? ((input) => forwardInboundMessage(input, { db }));
  const resolveOwner =
    options.resolveOwner ??
    ((recipient: string) => findInboundRecipientOwner(recipient, { db }));

  const staleCutoff = new Date(now - minStaleMs);
  const ageCutoff = new Date(now - maxAgeMs);

  const rows = await db
    .select({
      id: emailInboundMessages.id,
      region: emailInboundMessages.region,
      environmentId: emailInboundMessages.environmentId,
      domain: emailInboundMessages.domain,
      recipient: emailInboundMessages.recipient,
      bucket: emailInboundMessages.bucket,
      objectKey: emailInboundMessages.objectKey,
      status: emailInboundMessages.status,
      reason: emailInboundMessages.reason,
    })
    .from(emailInboundMessages)
    .where(
      and(
        isNull(emailInboundMessages.forwardedAt),
        isNotNull(emailInboundMessages.forwardError),
        // A row with no environment resolved to nobody, so there is no address
        // to forward to — it never had a forward and never will.
        isNotNull(emailInboundMessages.environmentId),
        gte(emailInboundMessages.createdAt, ageCutoff),
        lte(emailInboundMessages.updatedAt, staleCutoff),
      ),
    )
    // Oldest failure first: the row that has been stuck longest has waited
    // longest, and a tick takes only `limit` of them.
    .orderBy(asc(emailInboundMessages.updatedAt), asc(emailInboundMessages.id))
    .limit(limit);

  const result: ForwardRedriveResult = {
    forwarded: [],
    stillFailing: [],
    skipped: [],
  };

  for (const row of rows) {
    const environmentId = row.environmentId;
    if (!environmentId) continue; // Unreachable given the filter; narrows the type.

    // The forwarding address is not on the row — it lives in the domain's
    // inbound config, which an operator may have removed since the failure. A
    // gone config is a skip, not a retry: there is nowhere to send it.
    const owner = await resolveOwner(row.recipient);
    if (!owner) {
      result.skipped.push(row.id);
      continue;
    }

    // Rebuild the same forward the receive path would have sent, from the stored
    // MIME. A read/parse failure here is not fatal: forward the "could not read"
    // notice with the S3 reference, exactly as the receive path does — the human
    // still learns somebody replied.
    const parsed = await rebuildParsed(fetchObject, {
      bucket: row.bucket,
      key: row.objectKey,
      region: row.region,
      maxBytes: maxObjectBytes,
    });

    const outcome = await forward({
      rowId: row.id,
      region: row.region,
      environmentId,
      domain: row.domain ?? owner.domain,
      forwardTo: owner.forwardTo,
      recipient: row.recipient,
      parsed,
      // A suppression's forward already carried its reason; reproduce it so the
      // re-driven notice reads the same as the original would have.
      suppressedReason: row.status === "suppressed" ? row.reason : null,
      storage: { bucket: row.bucket, key: row.objectKey },
    });

    if (outcome.status === "failed") result.stillFailing.push(row.id);
    else result.forwarded.push(row.id);
  }

  return result;
}

/**
 * The parse the receive path had, re-derived from S3.
 *
 * Returns `null` on any read or parse failure — a too-large object, unparseable
 * bytes, or a transient S3 error — because `buildForwardMessage` handles a null
 * parse (the "could not read" notice), and a re-drive that produced no forward
 * at all would strand the row exactly as the original failure did.
 */
async function rebuildParsed(
  fetchObject: InboundObjectFetcher,
  ref: { bucket: string; key: string; region: "us" | "eu"; maxBytes: number },
): Promise<ParsedInboundMessage | null> {
  try {
    const object = await fetchObject(ref);
    return await parseInboundMime(object.body);
  } catch {
    return null;
  }
}
