/**
 * Channel lists — engine-synthesized delivery channels layered on the SAME
 * `email_preferences.categories` JSONB namespace as author-defined lists (D3).
 * A channel is an auto-registered opt-out list: `in_app` (the notification
 * feed) plus one per connector that exposes member-directed actions (discord,
 * telegram). There is no new table and no authoring surface — channels are
 * derived from the registered connector actions at container build time.
 *
 * POLARITY (zero behaviour flip): every channel is `defaultOptIn: true`, so
 * `ListRegistry.isSubscribed(categories, id)` returns `categories[id] !== false`
 * — subscribed unless the recipient explicitly set the category to `false`.
 * That is EXACTLY the unknown-id fallback an UNregistered channel already
 * resolved to (`isSubscribedByDefault` → `?? true`), so registering these lists
 * flips zero existing behaviour; it only makes the channels visible in the
 * catalog and (in a later phase) enforceable in `sendConnectorAction`.
 */
import type { DefinedConnectorAction } from "../connectors/define-action.js";
import type { ListMeta } from "./define-list.js";

/**
 * Reserved list id for the engine's in-app channel (the notification feed).
 * Always synthesized first by {@link synthesizeChannelLists}; also the
 * suppression key consulted by `sendFeedItem`.
 */
export const IN_APP_LIST_ID = "in_app";

/** Uppercase the first character of a connector id for the channel's display name. */
function capitalize(id: string): string {
  return id.length === 0 ? id : id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Synthesize the engine-owned channel {@link ListMeta}s from the registered
 * connector actions.
 *
 * Always yields the `in_app` channel first. Then one channel per DISTINCT
 * `connectorId` among actions declaring a member audience
 * (`action.audience?.kind === "member"`), de-duplicated via a `Set` in stable
 * first-appearance order. Actions WITHOUT a member audience (ops/channel-
 * directed) never mint a channel. Channel display name = the connector id with
 * its first letter capitalized ("discord" → "Discord").
 *
 * Every channel shares the opt-out polarity shape `{ defaultOptIn: true,
 * enabled: true, kind: "channel" }` — see the module docblock for why this
 * flips no existing behaviour.
 */
export function synthesizeChannelLists(
  actions: DefinedConnectorAction[],
  opts?: { sms?: boolean },
): ListMeta[] {
  const channels: ListMeta[] = [
    {
      id: IN_APP_LIST_ID,
      name: "In-app feed",
      defaultOptIn: true,
      enabled: true,
      kind: "channel",
    },
  ];

  const seen = new Set<string>();
  for (const action of actions) {
    if (action.audience?.kind !== "member") continue;
    if (seen.has(action.connectorId)) continue;
    seen.add(action.connectorId);
    channels.push({
      id: action.connectorId,
      name: capitalize(action.connectorId),
      defaultOptIn: true,
      enabled: true,
      kind: "channel",
    });
  }

  // The SMS channel is minted when an SMS provider is configured (SMS is NOT a
  // connector). Opt-out polarity like every channel — an inbound STOP flips
  // `categories.sms` to false; the tracked SMS sender gates on it. De-duped via
  // `seen` in case a connector also happened to use the id "sms".
  if (opts?.sms && !seen.has("sms")) {
    seen.add("sms");
    channels.push({
      id: "sms",
      name: "SMS",
      defaultOptIn: true,
      enabled: true,
      kind: "channel",
    });
  }

  return channels;
}
