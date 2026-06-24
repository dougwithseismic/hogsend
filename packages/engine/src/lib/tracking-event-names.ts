// First-party tracking event names emitted by the engine's own tracking
// endpoints (link click + open pixel). These belong to the engine — they are
// not journey content — so they live here rather than in app-side constants.
export const EMAIL_OPENED = "email.opened" as const;
export const EMAIL_LINK_CLICKED = "email.link_clicked" as const;

// First-party BUS event for a NON-email managed-link click (re-ingested through
// `ingestEvent` so journeys can trigger / `ctx.waitForEvent` on a click of a
// SPECIFIC managed link). It deliberately SHARES the name string with the
// existing per-hit OUTBOUND `link.clicked` webhook, but the two differ in
// payload + subject: the OUTBOUND carries `trackedLinks.id` as `linkId` + the
// raw mint distinctId; the BUS event carries the MANAGED `links.id` as `linkId`
// + the RESOLVED survivor contact key (see `pushLinkClickEvent`).
export const LINK_CLICKED = "link.clicked" as const;
