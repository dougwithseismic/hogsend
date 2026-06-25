/**
 * Realtime transport — the SSE→WS swap seam. v1 ships the INTERFACE only; the
 * SSE impl + poll fallback land in v2. A consumer can supply their own
 * `RealtimeTransport` to `createHogsend({ realtime })` today and it typechecks.
 */

/** A realtime channel handle returned by {@link RealtimeTransport.connect}. */
export interface RealtimeChannel {
  /** Register a handler for incoming item batches. */
  onItems(listener: (items: unknown[]) => void): () => void;
  /** Register a handler for metadata (counter) updates. */
  onMetadata(listener: (metadata: unknown) => void): () => void;
  /** Close the channel. */
  close(): void;
}

/**
 * The realtime transport seam. SSE is the v2 primary (plain HTTP +
 * `EventSource`), with a poll fallback; WebSocket slots in later behind the
 * same interface, untouched.
 */
export interface RealtimeTransport {
  /** Open a channel (e.g. `feed:<recipientKey>`). */
  connect(channel: string): RealtimeChannel;
}

const NOT_IMPLEMENTED =
  "@hogsend/js: built-in realtime transports are not implemented in v1 (SSE/poll land in v2)";

/**
 * v2 factory placeholder for the built-in SSE transport. Throws until v2;
 * consumers may pass their own {@link RealtimeTransport} in the meantime.
 */
export function createSseTransport(_url: string): RealtimeTransport {
  throw new Error(NOT_IMPLEMENTED);
}

/** v2 factory placeholder for the poll-fallback transport. */
export function createPollTransport(_url: string): RealtimeTransport {
  throw new Error(NOT_IMPLEMENTED);
}
