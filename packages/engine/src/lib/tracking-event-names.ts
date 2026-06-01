// First-party tracking event names emitted by the engine's own tracking
// endpoints (link click + open pixel). These belong to the engine — they are
// not journey content — so they live here rather than in app-side constants.
export const EMAIL_OPENED = "email.opened" as const;
export const EMAIL_LINK_CLICKED = "email.link_clicked" as const;
