/**
 * Engine-owned event vocabularies (both `email.opened` dot-style and
 * `journey:completed` colon-style exist) — a consumer-authored event in these
 * namespaces would corrupt insights or trigger engine-internal logic, so
 * every author-controlled surface (semantic links, blueprint triggers, …)
 * rejects them. This is the ONE canonical definition; the engine re-uses it.
 */
export const RESERVED_EVENT_NAMESPACES = [
  "email",
  "journey",
  "bucket",
  "contact",
  "deal",
  "funnel",
] as const;

export const RESERVED_EVENT_NAME_RE =
  /^(?:email|journey|bucket|contact|deal|funnel)[.:]/;

/** True when `event` sits in an engine-reserved namespace. */
export function isReservedEventName(event: string): boolean {
  return RESERVED_EVENT_NAME_RE.test(event);
}
