---
"@hogsend/engine": minor
"@hogsend/plugin-discord": minor
---

A contact is minted by identity, not by observation.

The engine no longer writes a `contacts` row for pure observation. Three paths
change: `POST /v1/events` on a publishable (`pk_`) key with nothing asserted,
`POST /v1/t/arrive` on the unauthenticated (no token) leg, and a feed send whose
recipient is a bare `anonymousId`. The refusal is inherited by every re-ingest
derived from a refused event (the feed mark and `feed_cleared` emits, the
journey holdout emit, a same-user `ctx.trigger`, and the bucket transition and
fast-expiry timer), so a downstream hop cannot re-resolve the same key and mint
an `external_id = <anonId>` row, which would be strictly worse than the ghost it
replaces: that row collides with identified contacts and 403s the visitor out of
their own feed.

Nothing is lost. A refused event still writes to `user_events` under the same
key, still routes to journeys, still evaluates exits and buckets, and is still
mirrored to analytics. When the visitor later identifies, the create arm adopts
the anonymous key's history (events, journey states, bucket memberships, sends
and preferences repoint onto the new canonical key) rather than stranding it.

`@hogsend/plugin-discord` drops `GUILD_PRESENCES` from the gateway worker's
default intents. It is a privileged intent, so requesting less cannot break a
deploy that was not already granted it.

**What you will observe.** Contact counts stop growing from anonymous traffic:
if your Studio contacts list is dominated by rows with a blank email and a blank
external id, that growth stops. `discord.presence_active` stops firing.

**The one change that can surprise a revenue-tracking deploy.** An anonymous
browser event with no `value` no longer fires conversions, attribution credits
or funnel progress. `conversions.contact_id`, `funnel_progress.contact_id` and
`deals.contact_id` are all NOT NULL foreign keys to `contacts.id`, so a refused
ingest has no degraded write available. The carve-outs, plainly:

- an event carrying `value` still creates, so e-commerce revenue conversions and
  their attribution credits keep firing anonymously exactly as before;
- an event carrying a `groups` map still creates, so a pre-login
  `hogsend.group()` still writes the group and the membership;
- any secret-key (`sk_`) caller still creates, on every path;
- any event asserting an `email`, or a `userId` proven by a server-minted user
  token, still creates.

**Keeping the old behaviour.** `ingestEvent` and `ingestTransformResult` take an
`allowCreate` option that defaults to `true`, so your own ingest calls (webhook
sources, custom routes, server-side SDK writes) are unchanged, and passing
`allowCreate: true` explicitly pins that. The three built-in refusal sites above
are not configurable: to keep minting from browser traffic, identify the visitor
or write from a secret key. For Discord, toggle PRESENCE in the portal and pass
an explicit `intents` bitfield including `DISCORD_INTENTS.GUILD_PRESENCES` to
`createDiscordGatewayWorker`; the `PRESENCE_UPDATE` transform is untouched, so
the intent is the only switch. `createDiscordRuntime` (the default inline path)
does not forward an `intents` option, so a worker-hosted deploy that wants
presence supplies its own `ConnectorRuntime` around
`createDiscordGatewayWorker`.

**New public API.** `resolveContactNoCreate` is exported: it resolves an
identity and returns `{ id: null, resolvedKey }` instead of creating when
nothing matches. It throws unless the highest-precedence key supplied is
`userId` or `anonymousId`, because those are the only shapes whose refusal keys
history on the same string the create arm would have written.
`resolveOrCreateContact`'s signature and return type are unchanged;
`ingestEvent` and `ingestTransformResult` gain only the optional `allowCreate`.
`ingestTransformResult` is now exported too; it was engine-internal.
