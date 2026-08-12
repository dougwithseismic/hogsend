// First-party tracking event names emitted by the engine's own tracking
// endpoints (link click + open pixel). These belong to the engine — they are
// not journey content — so they live here rather than in app-side constants.
export const EMAIL_OPENED = "email.opened" as const;
export const EMAIL_LINK_CLICKED = "email.link_clicked" as const;

// A human REPLIED to a message we sent (PRD 16). The BUS name deliberately
// EQUALS the outbound catalog name — unlike the click pair, where the bus event
// is `email.link_clicked` and the webhook is `email.clicked` — because the whole
// point of the feature is that a journey author writes exactly what the PRD
// promises: `ctx.waitForEvent({ event: "email.replied" })`. A second spelling
// would be one more thing to look up in order to stop a sequence when somebody
// says "please stop emailing me".
export const EMAIL_REPLIED = "email.replied" as const;

// First-party BUS event for a NON-email managed-link click (re-ingested through
// `ingestEvent` so journeys can trigger / `ctx.waitForEvent` on a click of a
// SPECIFIC managed link). It deliberately SHARES the name string with the
// existing per-hit OUTBOUND `link.clicked` webhook, but the two differ in
// payload + subject: the OUTBOUND carries `trackedLinks.id` as `linkId` + the
// raw mint distinctId; the BUS event carries the MANAGED `links.id` as `linkId`
// + the RESOLVED survivor contact key (see `pushLinkClickEvent`).
export const LINK_CLICKED = "link.clicked" as const;

// A visitor CONFIRMED landing from a tracked hit (POST /v1/t/arrive, opt-in
// `hs_ref`). Subset of `link.clicked`: fires only when the link opts in AND
// the landing page integrates. Unlike `link.clicked`, it carries the VISITOR's
// identity (token-verified userId or clamped anon id) — which is what answers
// "did a known user scan this QR?". Bus + outbound both define `linkId` as the
// managed `links.id` and carry `trackedLinkId` separately (no legacy split).
export const LINK_ARRIVED = "link.arrived" as const;

// First-party BUS event for an SMS short-link click (`/s/:code`) — the SMS
// sibling of `email.link_clicked`, re-ingested through `ingestEvent` so
// journeys can trigger / `ctx.waitForEvent` on a click of a link texted to
// THIS user. The per-hit OUTBOUND counterpart is `sms.clicked`.
export const SMS_LINK_CLICKED = "sms.link_clicked" as const;
