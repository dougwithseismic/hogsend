/**
 * The EventSpine — THE single telemetry path to the network. Every surface
 * (preferences, feed marks, banner dismissals) routes through `capture()`;
 * surfaces never POST telemetry directly. Emission lives here, source-stamped
 * `"inapp"` and idempotency-keyed, so even a headless consumer emits the loop.
 */

import type { IdentityStore } from "../identity/identity-store.js";
import type { CaptureOptions, CaptureResult, Properties } from "../types.js";
import { createQueue, type EventQueue } from "./queue.js";
import type { Transport } from "./transport.js";

export interface EventSpineOptions {
  transport: Transport;
  identity: IdentityStore;
  /** Override telemetry path (e.g. proxy mode handled in transport). */
  path?: string;
  batchMs?: number;
  flushOnUnload?: boolean;
}

/** The EventSpine — the stable core contract every surface depends on. */
export interface EventSpine {
  /**
   * Capture an event through the single telemetry path. Returns once the
   * event is enqueued; durability/retry is the queue's job. The `contactKey`
   * is the last-known canonical key (best-effort, since delivery is batched).
   */
  capture(
    event: string,
    properties?: Properties,
    opts?: CaptureOptions,
  ): Promise<CaptureResult>;
  flush(): Promise<void>;
  teardown(): void;
}

/** Build the EventSpine. */
export function createEventSpine(opts: EventSpineOptions): EventSpine {
  const queue: EventQueue = createQueue({
    transport: opts.transport,
    path: opts.path,
    batchMs: opts.batchMs,
    flushOnUnload: opts.flushOnUnload,
  });

  return {
    capture: async (event, properties, captureOpts) => {
      const userId = opts.identity.getUserId();
      const userToken = opts.identity.getUserToken();
      queue.enqueue({
        name: event,
        eventProperties: properties ?? {},
        source: "inapp",
        anonymousId: opts.identity.getAnonymousId(),
        ...(userId ? { userId } : {}),
        // The token only authorizes a claimed userId; never sent anon-only.
        ...(userId && userToken ? { userToken } : {}),
        ...(captureOpts?.idempotencyKey
          ? { idempotencyKey: captureOpts.idempotencyKey }
          : {}),
        ...(captureOpts?.timestamp ? { timestamp: captureOpts.timestamp } : {}),
      });
      return {
        stored: true,
        contactKey:
          opts.identity.getContactKey() ?? opts.identity.getDistinctId(),
      };
    },
    flush: () => queue.flush(),
    teardown: () => queue.teardown(),
  };
}
