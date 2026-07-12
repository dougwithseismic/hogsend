/**
 * Touchpoint classification — which events on the spine count as marketing
 * TOUCHES for attribution (docs/revenue-attribution-plan.md §Phase 2/6).
 *
 * Touchpoints are a query-time classification of `user_events`, not a table:
 * the attribution engine (Phase 6) reads a contact's ordered events, keeps the
 * touchpoint-classed ones, and allocates conversion credit across them.
 * Reporting uses the same classification so "touches" always means one thing.
 *
 * Event names are string literals by design — the canonical emitters live in
 * `@hogsend/engine` (`lib/tracking-event-names.ts`) and `@hogsend/js`, which
 * both depend on core, so core re-declares the names. Keep them in sync BY
 * HAND with those modules.
 */

/** The marketing channel a touchpoint event class belongs to. */
export type TouchpointChannel =
  | "campaign" // paid/UTM landing captured by @hogsend/js (`campaign.arrived`)
  | "link" // managed/vanity/QR links (`link.clicked`, `link.arrived`)
  | "email" // first-party email clicks + semantic-link answers
  | "sms" // first-party SMS short-link clicks
  | "form"; // lead-capture submission (`lead.submitted`, Phase 3)

export interface TouchpointClass {
  event: string;
  channel: TouchpointChannel;
}

/**
 * The built-in touchpoint event classes. Deliberately CLICK/ACTION-grade
 * signals only — opens (`email.opened`) are excluded: bot/proxy inflation
 * (Apple MPP et al.) makes them too weak to carry conversion credit.
 */
export const TOUCHPOINT_EVENT_CLASSES: readonly TouchpointClass[] = [
  { event: "campaign.arrived", channel: "campaign" },
  { event: "link.clicked", channel: "link" },
  { event: "link.arrived", channel: "link" },
  { event: "email.link_clicked", channel: "email" },
  { event: "email.action", channel: "email" },
  { event: "sms.link_clicked", channel: "sms" },
  { event: "lead.submitted", channel: "form" },
];

/** The built-in touchpoint event names, in class order. */
export const TOUCHPOINT_EVENTS: readonly string[] =
  TOUCHPOINT_EVENT_CLASSES.map((c) => c.event);

/**
 * Resolve an event name to its touchpoint channel, or `null` when the event
 * is not a touchpoint. `extra` lets a deployment add its own classes (e.g. a
 * webhook-sourced `call.answered` as channel "form") without forking the
 * built-ins — extras win on a name collision.
 */
export function touchpointChannel(
  event: string,
  extra?: readonly TouchpointClass[],
): TouchpointChannel | null {
  if (extra) {
    for (const c of extra) if (c.event === event) return c.channel;
  }
  for (const c of TOUCHPOINT_EVENT_CLASSES) {
    if (c.event === event) return c.channel;
  }
  return null;
}

/** Whether an event name counts as a touchpoint ({@link touchpointChannel}). */
export function isTouchpointEvent(
  event: string,
  extra?: readonly TouchpointClass[],
): boolean {
  return touchpointChannel(event, extra) !== null;
}
