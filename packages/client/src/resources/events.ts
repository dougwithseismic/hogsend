import type { HttpClient } from "../internal/http.js";
import { assertIdentity } from "../internal/identity.js";
import type { IngestResult, SendEventInput } from "../types.js";

/** The `events.*` resource bound to an {@link HttpClient}. */
export class EventsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Send an event through the ingestion pipeline. The two property bags are
   * kept distinct: `eventProperties` feed `trigger.where`/`exitOn`,
   * `contactProperties` merge onto the contact. Optionally apply list
   * membership. Returns the ingest result (stored + exit evaluations).
   *
   * `idempotencyKey` is sent both as the `Idempotency-Key` header (which wins
   * server-side) and in the body, matching `POST /v1/events`.
   */
  send(input: SendEventInput): Promise<IngestResult> {
    assertIdentity(input);
    return this.http.post<IngestResult>(
      "/v1/events",
      {
        name: input.name,
        email: input.email,
        userId: input.userId,
        eventProperties: input.eventProperties,
        contactProperties: input.contactProperties,
        lists: input.lists,
        idempotencyKey: input.idempotencyKey,
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
  }

  /** Alias of {@link EventsResource.send}. */
  track(input: SendEventInput): Promise<IngestResult> {
    return this.send(input);
  }
}
