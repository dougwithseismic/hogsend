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
  /**
   * Read the current group associations (`groupType → groupKey`) attached to
   * every capture. Association-only — the spine never sends group properties.
   * Omitted (or an empty map) means no `groups` field on the payload.
   */
  getGroups?: () => Record<string, string>;
  /**
   * Observe every captured event (an outbound tap, e.g. the dataLayer bridge).
   * Fired after enqueue; a throw is swallowed so a tap can never break the
   * telemetry path.
   */
  onCapture?: (event: string, properties: Properties) => void;
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
      const groups = opts.getGroups?.();
      queue.enqueue({
        name: event,
        eventProperties: properties ?? {},
        source: "inapp",
        anonymousId: opts.identity.getAnonymousId(),
        ...(userId ? { userId } : {}),
        // The token only authorizes a claimed userId; never sent anon-only.
        ...(userId && userToken ? { userToken } : {}),
        // Association-only group map; omitted when empty.
        ...(groups && Object.keys(groups).length ? { groups } : {}),
        ...(captureOpts?.idempotencyKey
          ? { idempotencyKey: captureOpts.idempotencyKey }
          : {}),
        ...(captureOpts?.timestamp ? { timestamp: captureOpts.timestamp } : {}),
        ...(captureOpts?.value !== undefined
          ? { value: captureOpts.value }
          : {}),
        ...(captureOpts?.currency ? { currency: captureOpts.currency } : {}),
      });
      if (opts.onCapture) {
        try {
          opts.onCapture(event, properties ?? {});
        } catch {
          // A tap must never break the telemetry path.
        }
      }
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
