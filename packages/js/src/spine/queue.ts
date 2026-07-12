/**
 * Offline buffer for captured events: a short batch window, retry/backoff on
 * transport failure, and a `sendBeacon` flush on page unload so the last events
 * survive navigation. The queue owns ordering and durability; the event-spine
 * owns payload shape.
 */

import { HogsendAPIError } from "../errors.js";
import type { Transport } from "./transport.js";

/** A single queued telemetry payload (engine `/v1/events` body shape). */
export interface QueuedEvent {
  name: string;
  eventProperties: Record<string, unknown>;
  source: "inapp";
  anonymousId: string;
  userId?: string;
  /** Signed proof of `userId` so a publishable key may assert it (engine reads
   * this from the body, not a header). */
  userToken?: string;
  idempotencyKey?: string;
  timestamp?: string;
  /** Event's monetary worth → `user_events.value` (revenue spine). */
  value?: number;
  /** ISO-4217 alpha code for `value`. */
  currency?: string;
}

export interface QueueOptions {
  transport: Transport;
  /** Path to POST telemetry to. Default "/v1/events". */
  path?: string;
  /** Batch window in ms before a flush fires. Default 100. */
  batchMs?: number;
  /** Max retry attempts per event before it is dropped. Default 5. */
  maxRetries?: number;
  /** Flush via sendBeacon on unload. Default true. */
  flushOnUnload?: boolean;
}

/** The telemetry queue. */
export interface EventQueue {
  /** Enqueue an event; schedules a batched flush. */
  enqueue(event: QueuedEvent): void;
  /** Force-flush the buffer now, awaiting in-flight delivery. */
  flush(): Promise<void>;
  /** Stop timers + unload listeners; final beacon flush if enabled. */
  teardown(): void;
}

const DEFAULT_BATCH_MS = 100;
const DEFAULT_MAX_RETRIES = 5;

/** Create the event queue. */
export function createQueue(opts: QueueOptions): EventQueue {
  const path = opts.path ?? "/v1/events";
  const batchMs = opts.batchMs ?? DEFAULT_BATCH_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const flushOnUnload = opts.flushOnUnload ?? true;

  const buffer: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let torndown = false;

  async function deliver(event: QueuedEvent, attempt = 0): Promise<void> {
    try {
      await opts.transport.post(path, event, {
        idempotencyKey: event.idempotencyKey,
      });
    } catch (err) {
      const status = err instanceof HogsendAPIError ? err.status : 0;
      // 4xx (except 429) are terminal — retrying won't help. Drop.
      const retriable = status === 0 || status === 429 || status >= 500;
      if (!retriable || attempt >= maxRetries) return;
      const backoff = Math.min(2 ** attempt * 200, 5_000);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      await deliver(event, attempt + 1);
    }
  }

  async function drain(): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    await Promise.all(batch.map((event) => deliver(event)));
  }

  function scheduleFlush(): void {
    if (timer !== null || torndown) return;
    timer = setTimeout(() => {
      timer = null;
      inFlight = drain();
    }, batchMs);
  }

  function beaconFlush(): void {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    for (const event of batch) opts.transport.beacon(path, event);
  }

  const onUnload = (): void => {
    if (flushOnUnload) beaconFlush();
  };

  if (
    flushOnUnload &&
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function"
  ) {
    window.addEventListener("pagehide", onUnload);
  }

  return {
    enqueue: (event) => {
      buffer.push(event);
      scheduleFlush();
    },
    flush: async () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight;
      inFlight = drain();
      await inFlight;
    },
    teardown: () => {
      torndown = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (
        typeof window !== "undefined" &&
        typeof window.removeEventListener === "function"
      ) {
        window.removeEventListener("pagehide", onUnload);
      }
      if (flushOnUnload) beaconFlush();
    },
  };
}
