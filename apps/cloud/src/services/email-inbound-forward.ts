import { and, eq, isNull } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { emailInboundMessages, sesTenants } from "../db/schema";
import { buildForwardMessage } from "../lib/inbound-forward";
import type { ParsedInboundMessage } from "../lib/inbound-mime";
import type { SesClient } from "../ses/contract";
import { getSesClient } from "../ses/index";
import type { SubstrateRegion } from "../substrate/types";

/**
 * THE MANDATORY FORWARD (PRD 16 task 6) — performing it.
 *
 * EARS, verbatim: "WHEN inbound is enabled for a domain, the system SHALL
 * forward every received message to the configured human address, and a
 * forwarding failure SHALL NOT lose the stored message or the event."
 *
 * Both halves of that sentence are decisions, and they pull in opposite
 * directions, so the ordering is stated once here:
 *
 *  - **EVERY received message**, not every EMITTED one. An auto-responder is
 *    stored and deliberately produces no event — and the human still gets their
 *    correspondent's vacation notice. Same for a message too large to read and
 *    one we could not parse: those forward a NOTICE naming the stored original,
 *    because "somebody replied and we could not process it" is exactly the thing
 *    a customer must be told rather than shielded from. The one message that is
 *    never forwarded is one whose recipient resolved to no environment: there is
 *    no configured address for it, and broadcasting is never the answer.
 *  - **Never a gate.** This runs AFTER the durable record and AFTER the event
 *    has been handed to the instance, and it cannot throw: every failure is
 *    recorded on the row (`forward_error`) and returned, never propagated. A
 *    forward that fails must not un-store a message or un-emit an event.
 *
 * READ-then-send-then-stamp, deliberately in that order. A crash between the
 * send and the stamp leaves the row unstamped, so a re-drive forwards a second
 * time; stamping first would leave a crash mid-send looking forwarded forever.
 * A duplicate in a human's inbox is a papercut. A reply that silently never
 * arrives is the failure this whole feature exists to prevent.
 */

export interface ForwardInboundDeps {
  db?: CloudDb;
  /** The SES seam. Injected so no test reaches AWS. */
  ses?: SesClient;
  now?: Date;
}

export interface ForwardInboundInput {
  /** The `email_inbound_messages` row this forward belongs to. */
  rowId: string;
  region: SubstrateRegion;
  environmentId: string;
  /** The customer's verified sending domain (`acme.com`). */
  domain: string;
  /** The human mailbox, resolved with the recipient. */
  forwardTo: string;
  /** The envelope recipient the message arrived at. */
  recipient: string;
  /** The parse, or `null` when the message was never read (too large/unparseable). */
  parsed: ParsedInboundMessage | null;
  storage: { bucket: string; key: string };
  /** Set when no event was emitted, so the forward can say why. */
  suppressedReason?: string | null;
}

export type ForwardInboundOutcome =
  | { status: "forwarded"; messageId: string }
  /** A re-drive of a message already forwarded. Nothing sent, nothing wrong. */
  | { status: "already_forwarded" }
  /** No SES tenancy for this environment — recorded, never thrown. */
  | { status: "failed"; error: string };

/**
 * Forward one received message to its domain's configured human address.
 *
 * NEVER THROWS. Callers are on the receive path, where the message and the
 * event are already durable, and an exception here would convert a forwarding
 * problem into a re-drive of work that already succeeded.
 */
export async function forwardInboundMessage(
  input: ForwardInboundInput,
  deps: ForwardInboundDeps = {},
): Promise<ForwardInboundOutcome> {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? new Date();

  try {
    const [row] = await db
      .select({ forwardedAt: emailInboundMessages.forwardedAt })
      .from(emailInboundMessages)
      .where(eq(emailInboundMessages.id, input.rowId))
      .limit(1);
    if (row?.forwardedAt) return { status: "already_forwarded" };

    // The tenant, because the forward goes out under the CUSTOMER's own
    // verified domain and their own SES tenant — not ours. That is what keeps
    // it DMARC-aligned at the receiving mailbox, and what keeps a stranger's
    // words off Hogsend's own sending reputation.
    const [tenant] = await db
      .select({
        tenantName: sesTenants.tenantName,
        configurationSetName: sesTenants.configurationSetName,
      })
      .from(sesTenants)
      .where(eq(sesTenants.environmentId, input.environmentId))
      .limit(1);
    if (!tenant) {
      return recordFailure(
        db,
        input.rowId,
        now,
        "the environment has no SES tenancy, so there is nothing to send the forward through",
      );
    }

    const ses = deps.ses ?? getSesClient(input.region);
    const { messageId } = await ses.sendEmail({
      tenantName: tenant.tenantName,
      configurationSetName: tenant.configurationSetName,
      message: buildForwardMessage({
        domain: input.domain,
        forwardTo: input.forwardTo,
        recipient: input.recipient,
        parsed: input.parsed,
        storage: input.storage,
        suppressedReason: input.suppressedReason ?? null,
      }),
    });

    // Stamped conditionally so a concurrent re-drive that also sent cannot
    // move the timestamp backwards, and so the clearing of `forward_error` is
    // tied to the same statement that records the success.
    await db
      .update(emailInboundMessages)
      .set({ forwardedAt: now, forwardError: null, updatedAt: now })
      .where(
        and(
          eq(emailInboundMessages.id, input.rowId),
          isNull(emailInboundMessages.forwardedAt),
        ),
      );
    return { status: "forwarded", messageId };
  } catch (error) {
    return recordFailure(
      db,
      input.rowId,
      now,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Record WHY the human did not get the message.
 *
 * On its own column rather than `last_error`, which belongs to the instance
 * hop: a reply can perfectly well reach the tenant's journey and fail to reach
 * the person, and a shared column would let the successful half erase the
 * evidence of the failed one. `forwarded_at IS NULL AND forward_error IS NOT
 * NULL` is the operator's re-drive list.
 *
 * Its own try/catch because this is the error path: a failure to WRITE the
 * failure must not become a throw out of a function whose whole contract is
 * that it never throws.
 */
async function recordFailure(
  db: CloudDb,
  rowId: string,
  now: Date,
  error: string,
): Promise<ForwardInboundOutcome> {
  try {
    await db
      .update(emailInboundMessages)
      .set({ forwardError: error, updatedAt: now })
      .where(
        and(
          eq(emailInboundMessages.id, rowId),
          isNull(emailInboundMessages.forwardedAt),
        ),
      );
  } catch (cause) {
    console.error(
      `[cloud:ses-inbound] could not record a forwarding failure for ${rowId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  return { status: "failed", error };
}
