import type { NormalizedSesEvent } from "../../lib/ses-events";
import { normalizeSesNotification } from "../../lib/ses-events";
import type { SesClient } from "../../ses/contract";
import type {
  RelayProvider,
  RelaySendBatchInput,
  RelaySendBatchResult,
  RelaySendInput,
  RelaySendResult,
} from "../contract";

/**
 * The relay wire over the frozen SES seam.
 *
 * It is a THIN adapter and nothing more: it renames the send result's field
 * (`messageId` → `id`), passes the batch result through untouched (its entry
 * shape is already neutral), and delegates event normalization to the one
 * function that owns it. It catches NO errors — a `SesError` (with its `kind`
 * and `retryable`) propagates verbatim so the caller decides what a throttle or
 * a tenant pause means, exactly as it would if it held the `SesClient`
 * directly.
 *
 * A class, for parity with `AwsSesClient`: it holds one dependency (the
 * `SesClient`) and exposes it as a stable identity.
 */
export class SesRelayProvider implements RelayProvider {
  readonly meta: { id: string; region: SesClient["region"] };

  constructor(private readonly ses: SesClient) {
    this.meta = { id: "ses", region: ses.region };
  }

  async send(input: RelaySendInput): Promise<RelaySendResult> {
    const result = await this.ses.sendEmail(input);
    return { id: result.messageId };
  }

  async sendBatch(input: RelaySendBatchInput): Promise<RelaySendBatchResult> {
    return await this.ses.sendBatch(input);
  }

  normalizeEvent(payload: unknown): NormalizedSesEvent | null {
    return normalizeSesNotification(payload);
  }
}
