/**
 * Conversion destinations (docs/revenue-attribution-plan.md §5.2) — where
 * fired conversion points get dispatched: ad-platform feedback APIs (Meta
 * CAPI, Google Enhanced Conversions, LinkedIn CAPI, …).
 *
 * Deliberately a SIBLING of the generic event-fan-out destinations
 * (`defineDestination`): this wire needs identifier hashing, click-ID joins,
 * and deterministic `event_id` idempotency the generic pipe doesn't have.
 * The ENGINE assembles the enriched payload (contact identifiers + recovered
 * click IDs + value); the provider only builds and sends the platform
 * request. The money path has no third-party CDP dependency.
 */

/** Contact identifiers, UNHASHED — providers hash what their platform wants. */
export interface ConversionContactIdentifiers {
  email?: string;
  phone?: string;
  externalId?: string;
  anonymousId?: string;
}

/** Ad-click evidence recovered from the contact's touchpoints. */
export interface ConversionClickContext {
  /** Click IDs from the most recent attributed arrival before the conversion. */
  clickIds: Record<string, string>;
  /** When that arrival happened (ms epoch) — `fbc` reconstruction needs it. */
  clickAt?: number;
  landingPage?: string;
}

/** The enriched dispatch payload the engine hands a destination. */
export interface ConversionDispatchInput {
  /**
   * Deterministic dedup id: `sha256(contactId:definitionId:eventRowId)`.
   * The SAME id is reused on every retry, so a platform receiving twice
   * dedups; a browser pixel twin sharing this id dedups against it too.
   */
  eventId: string;
  definitionId: string;
  /** The conversion's trigger event name (e.g. `crm.deal_sold`). */
  triggerEvent: string;
  value: number | null;
  currency: string | null;
  /** Conversion time (the triggering event's occurredAt), ms epoch. */
  occurredAt: number;
  contact: ConversionContactIdentifiers;
  clicks: ConversionClickContext;
}

export interface ConversionDestinationMeta {
  /** Registry key — referenced by `defineConversion({ destinations })`. */
  id: string;
  name: string;
  description?: string;
}

export interface ConversionDestination {
  readonly meta: ConversionDestinationMeta;
  /**
   * Deliver one conversion. THROW on retryable failure (the durable dispatch
   * task retries with the same eventId); resolve with the platform response
   * snippet for the dispatch log.
   */
  send(input: ConversionDispatchInput): Promise<{ response?: unknown }>;
}

/** Identity/validating factory — mirrors the other provider contracts. */
export function defineConversionDestination(
  destination: ConversionDestination,
): ConversionDestination {
  return destination;
}
