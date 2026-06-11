import {
  type ComponentPropsWithoutRef,
  createElement,
  type ReactElement,
} from "react";

/**
 * Attribute names used to carry semantic-link metadata from the rendered
 * template to the engine's link rewriter. INTERNAL wire format: the engine
 * strips both attributes before the HTML reaches the email provider — the
 * persisted `tracked_links` row is the contract, not this encoding.
 */
export const EMAIL_ACTION_EVENT_ATTR = "data-hs-event";
export const EMAIL_ACTION_PROPS_ATTR = "data-hs-props";

/**
 * Sentinel `href` for semantic links with no landing page of their own:
 * `href={HOSTED_ANSWER_HREF}` resolves at send time to the engine-hosted
 * answer page (`/v1/t/a/:linkId`) — a thanks page with an optional free-text
 * box whose submission ingests `<event>.comment`.
 */
export const HOSTED_ANSWER_HREF = "hogsend://answer";

/** Scalar-only payload — non-scalar values don't survive the Hatchet wire. */
export type EmailActionProperties = Record<
  string,
  string | number | boolean | null
>;

export interface EmailActionProps extends ComponentPropsWithoutRef<"a"> {
  /** Where the recipient lands after the click is recorded. */
  href: string;
  /**
   * Consumer event name emitted through the full ingest pipeline when this
   * link is clicked (e.g. "nps.submitted"). Engine-reserved namespaces
   * (`email.*`, `journey.*`, `bucket.*`, `contact.*`) are rejected at send
   * time.
   */
  event: string;
  /** Event payload, recorded at send time and emitted with every answer. */
  properties?: EmailActionProperties;
}

/**
 * A semantic link — an `<a>` whose click MEANS something. Renders a plain
 * anchor (react-email's Tailwind transform still applies to `className`),
 * tagged with the event metadata for the engine to lift at send time.
 *
 * Every answer in an email is a link: a yes/no question is two EmailActions,
 * an NPS survey is eleven. The first click per (send, event name) wins.
 *
 * Plain `.ts` + `createElement` (no JSX) so consumers type-checking this
 * package's raw source need no `jsx` compiler setting.
 */
export function EmailAction({
  event,
  properties,
  children,
  ...anchor
}: EmailActionProps): ReactElement {
  return createElement(
    "a",
    {
      ...anchor,
      [EMAIL_ACTION_EVENT_ATTR]: event,
      [EMAIL_ACTION_PROPS_ATTR]: properties
        ? JSON.stringify(properties)
        : undefined,
    },
    children,
  );
}
