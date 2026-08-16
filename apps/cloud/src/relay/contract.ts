import type { SesBatchEntryResult, SesMessage } from "../ses/types";
import type { SubstrateRegion } from "../substrate/types";

/**
 * The provider-neutral relay seam.
 *
 * A `RelayProvider` is the dumb wire the control plane sends outbound mail
 * through and reads delivery events back from. It is deliberately named for
 * what the control plane DOES — send a message, send a batch, normalize an
 * inbound event — not for the substrate underneath it. Today there is exactly
 * one implementation (`SesRelayProvider`, over the frozen SES seam), and the
 * only trimmed-scope caveat worth stating up front is ROUTING: this seam does
 * not abstract HOW a message is routed. `tenantName` / `configurationSetName`
 * are accepted verbatim as the SES implementation's routing inputs and passed
 * straight through — a second substrate that routed differently would widen
 * this interface, not reinterpret these fields.
 *
 * Every value crossing this boundary is a plain, portable one (the same rule
 * the SES seam holds): the message and event shapes are the neutral types the
 * layers above already speak, so a new provider is an additive change rather
 * than a churn through every caller.
 */
export interface RelayProvider {
  /** `id` names the wire in a log line; `region` is the jurisdiction it
   * serves, pinned for the provider's whole life. */
  readonly meta: { id: string; region: SubstrateRegion };

  /** Send one already-rendered message. Errors propagate verbatim — a caller
   * branches on the substrate error's `kind`, never a swallowed result. */
  send(input: RelaySendInput): Promise<RelaySendResult>;

  /**
   * Send many messages on one routing scope. Not all-or-nothing: one
   * unroutable address must not cost the rest of the batch its delivery, so
   * the result is one entry per input message, in order.
   */
  sendBatch(input: RelaySendBatchInput): Promise<RelaySendBatchResult>;
}

/** One outbound message plus the routing scope it is sent under. */
export interface RelaySendInput {
  tenantName: string;
  configurationSetName: string;
  message: SesMessage;
}

/**
 * The neutral send result. `id` is the substrate's own message id — the rename
 * of the SES seam's `{ messageId }`, so no caller above this seam speaks the
 * substrate's field name.
 */
export interface RelaySendResult {
  id: string;
}

/** Many messages on one routing scope. */
export interface RelaySendBatchInput {
  tenantName: string;
  configurationSetName: string;
  messages: SesMessage[];
}

/**
 * The batch result REUSES the per-entry shape verbatim. Downstream code
 * consumes `SesBatchEntryResult` positionally, and the entry is already
 * provider-neutral (`{ status: "sent"; messageId } | { status: "failed"; … }`),
 * so keeping it identical is a zero-regression choice — only the single-send
 * result is renamed to `{ id }`.
 */
export type RelaySendBatchResult = { results: SesBatchEntryResult[] };
