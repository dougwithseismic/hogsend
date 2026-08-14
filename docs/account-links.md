# Account links

An account link binds a player's third-party platform account (Steam, Twitch) to
a Hogsend contact. The case it was built for: you know a player by their
SteamID, your CRM knows them by email, and nothing joins the two, so a Steam
event cannot start a journey and a lifecycle email cannot name the account it is
about. A completed link is an identity fact (a row in `linked_accounts`), a
lifecycle event (`account.linked` on the outbound spine), and a row a publisher
can mirror into their own database. Providers register only on operator intent:
a deploy that sets no account-link env var and passes no `accountLinks` option
registers no providers, serves no `/v1/accounts/*` behaviour for them, and logs
no warning.

## Quick start (Steam, no credentials)

Steam is the zero-credential provider. "Sign in through Steam" is OpenID 2.0:
the relying party presents no client id and no secret, there is no app to
register and no redirect URI to file. Twitch needs an OAuth application and both
halves of its credential pair; see [Provider setup](#provider-setup).

One env var is the whole configuration. Its presence is the operator intent that
registers Steam:

```bash
API_PUBLIC_URL=https://api.yourgame.com                   # http://localhost works for Steam
ACCOUNT_LINK_ALLOWED_ORIGINS=https://play.yourgame.com    # the one returnTo allowlist
# STEAM_WEB_API_KEY=xxxxxxxx                              # optional: adds persona name + avatar
# ACCOUNT_LINK_STATE_TTL_SECONDS=900                      # link-URL lifetime, default 900 (15 min)
```

Redis is required. The hosted flow burns a single-use nonce and holds PKCE
material there, so `/start` and `/callback` answer `503` without a connected
Redis rather than serving a state they cannot safely complete.

Create a secret API key with the `accounts` scope (`POST /v1/admin/api-keys`,
admin-authenticated). `accounts` is orthogonal to `ingest`; a key that both
ingests events and mints link URLs carries both.

The contact must exist before you mint. Identify the player however you already
do:

```bash
curl -X POST $API/v1/events -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"proof.signup","userId":"steam-proof-player","email":"steam-proof@example.com"}'
```

Mint the link URL:

```bash
curl -X POST $API/v1/accounts/mint-link -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"provider":"steam","email":"steam-proof@example.com"}'
# {"url":"https://api.yourgame.com/v1/accounts/steam/start?t=<state>","expiresAt":"…"}
```

Mint before the contact exists and the answer is `404 {"error":"unknown_contact"}`.
Nothing is minted, because the callback would refuse a state naming a contact
that is not there.

The URL is engine-origin, never a platform URL. Send the player to it. `/start`
302s to `steamcommunity.com`, the player approves, Steam returns to
`/v1/accounts/steam/callback`, the engine verifies the assertion server-side and
writes one row:

| column | value |
| --- | --- |
| `provider` | `steam` |
| `provider_user_id` | `76561197993723325` (the 17-digit steamid64) |
| `version` | `1` |
| `method` | `oauth` |
| `unlinked_at` | `NULL` (live) |

The player lands on the hosted success page, or on your `returnTo` when you
passed one and it is on the allowlist.

Read it back on the operator plane:

```bash
curl -H "Authorization: Bearer $KEY" $API/v1/accounts/steam/76561197993723325
# {"account":{"provider":"steam","providerUserId":"76561197993723325",
#             "contactId":"…","username":null,"avatarUrl":null,
#             "method":"oauth","version":"1","linkedAt":"…","tokensRevokedAt":null}}

curl -H "Authorization: Bearer $KEY" "$API/v1/accounts?email=steam-proof@example.com"
# {"accounts":[ … ]}
```

`version` is the string `"1"`, not the number `1`. See
[The version contract](#the-version-contract).

`username` and `avatarUrl` are `null` here because `STEAM_WEB_API_KEY` is unset.
A Steam login proves a steamid64 and nothing else: no display name, no avatar,
no email, ever. The persona name and avatar come from the keyed
`GetPlayerSummaries` Web API call, which is why the key widens the provider
instead of enabling it.

## How a provider registers

`accountLinksFromEnv` (`packages/engine/src/lib/account-links-from-env.ts`) runs
one intent gate, then builds the presets:

- Intent is either env-side (`ACCOUNT_LINK_TWITCH_CLIENT_ID`,
  `ACCOUNT_LINK_TWITCH_CLIENT_SECRET`, `STEAM_WEB_API_KEY` or
  `ACCOUNT_LINK_ALLOWED_ORIGINS` is set) or code-side (any `accountLinks` option
  passed to `createHogsendClient`, including `accountLinks: {}`).
- No intent means an empty registry. Not an error, not a warning, no boot noise.
- With intent, **Steam always registers**. It needs no credential. The one thing
  it does need is `API_PUBLIC_URL` (trailing slash stripped) as the OpenID
  realm, and the engine already requires that var.
- Twitch registers only when **both** `ACCOUNT_LINK_TWITCH_CLIENT_ID` and
  `ACCOUNT_LINK_TWITCH_CLIENT_SECRET` are set. Exactly one set means the
  provider is absent from the registry, not present and disabled, plus one boot
  warning naming the missing var.
- `ACCOUNT_LINK_STATE_TTL_SECONDS` is deliberately not an intent signal. It
  carries a default, so counting it would make every deploy look like intent.

Consumer-supplied providers merge after the presets, so a provider with the same
`meta.id` wins:

```ts
const client = createHogsendClient({
  accountLinks: {
    providers: [myProvider],
    hooks: { afterLink: grantReward },
    allowedOrigins: ["https://play.yourgame.com"],
  },
});
```

`allowedOrigins` concatenates with `ACCOUNT_LINK_ALLOWED_ORIGINS` and is parsed
by the same rule. A malformed entry throws at boot naming the entry. It is never
`*`. Register the option on the client your HTTP entry point builds, since that
process serves `/v1/accounts/*`; mirror it in `worker.ts` so the two containers
describe the same deployment.

With providers registered and the allowlist empty, the container warns once at
boot: no `returnTo` will be accepted.

## The two ways to start a link

Both mint the same thing: an engine-origin
`<API_PUBLIC_URL>/v1/accounts/<provider>/start?t=<state>` URL with an
`expiresAt`. The platform's own authorize URL is never handed to a caller; it is
only ever a 302 target.

**`POST /v1/accounts/mint-link`** is the operator mint. Secret key plus the
`accounts` scope. Your server picks the contact by `contactId` or `email`, so it
can put a link button in an email, a DM or a support tool. Neither key supplied
is `400`; an unknown contact is `404`.

**`POST /v1/accounts/link-url`** is the browser mint. A publishable or secret key
plus a `userToken` your server minted (`generateUserToken` from
`@hogsend/engine`, signed with `BETTER_AUTH_SECRET`). It mints **only** for the
token's own user: a `contactId` or `email` in the body is `403` with no mint, and
a `userId` that differs from the token's subject is the same `403`. The browser
calls the engine directly, so you ship no backend endpoint of your own.

Both throttle through Redis and both fail closed: over budget and Redis
unavailable are both `429` with no URL. The budget is a fixed window of 20 per
15 minutes, counted per contact on the mints and per IP on the public `/start`
and `/callback` routes (plus per contact once a warm `/start` knows which
contact it is for).

`/start` also accepts a cold call with no `?t=`. It mints a browser anonymous
key (setting the `hs_anon_id` cookie) and binds the link to that. A cold link may
never displace a live owner; see [Security posture](#security-posture).

## The three planes

A consumer integrates through exactly three surfaces, and each does a job the
other two cannot.

| Plane | Surface | Job | Guarantee |
| --- | --- | --- | --- |
| PULL | `/v1/accounts/*` | The system of record. Reconciliation, backfill, "what is true right now", reverse lookup | Strongly consistent. Hogsend wins any disagreement |
| PUSH | outbound webhooks | The mirror feed, for a production database Hogsend is not deployed inside | At-least-once, retried, reorderable |
| IN-PROCESS | `AccountLinkHooks` | The only place a veto can live, and the only place an in-band write to your own database can happen | Not a delivery mechanism. A throw does not retry |

PULL answers "who owns this Steam account right now". `GET /v1/accounts/{provider}/{providerUserId}`
returns the live row or `404`; an unlinked pair is history, not an owner.
`GET /v1/accounts` lists live links filtered by `contactId`, `email` or
`provider` (at least one is required, else `400`), newest first, `limit` default
50 and max 200.

PUSH answers "something just changed". It is the feed you subscribe to when the
account state has to land in your own database, and it is the plane the version
contract exists for.

IN-PROCESS answers "should this link happen, and what do I write in the same
breath". `beforeLink` is the only veto point in the feature. `afterLink` is the
only place a grant runs before the player reads the success page.

The choosing rule: reconcile from PULL, react from PUSH, veto from IN-PROCESS.

## The version contract

Every mutation of a `(provider, providerUserId)` pair allocates the pair's own
next `version`, `COALESCE(MAX(version), 0) + 1` across every row for that pair,
live and unlinked. A relink burns two: the displaced owner's `account.unlinked`
at the lower version, then the new owner's `account.linked` at the higher one.
Those are two independent deliveries with independent retries, so they can arrive
out of order, duplicated, or a day late.

Every `account.linked` and `account.unlinked` payload carries the **full current
state**, including `{ state, version }`, never a delta. That is what makes one
rule sufficient:

> Upsert keyed on `(provider, providerUserId)`; apply only when
> `incoming.version > stored.version`; otherwise discard.

One guard covers all three failure modes. A duplicate carries a version that is
not greater, so it is discarded. A reordered pair applies the higher version and
discards the lower whichever arrives first. A late delivery is a low version
against a high stored one, so it is discarded. No timestamp is a valid
tiebreaker: two mutations of one pair can share a second, and `at` is stamped at
emit time on a different clock from the one that ordered the writes.

**`version` is a Postgres `bigint`, and it crosses every boundary as a decimal
string.** Compare it with `BigInt()`, or store it in a numeric column and compare
in SQL. Never `parseInt` or `Number()`: a value above `Number.MAX_SAFE_INTEGER`
rounds through float64 and the `>` guard silently stops discriminating, which is
exactly the case the guard exists for. Nothing errors; you just record the wrong
owner permanently. A reader who copies the rule and drops it into `parseInt` has
implemented the bug.

```ts
// Your subscriber, on account.linked / account.unlinked.
const stored = await db.playerAccount.findUnique({
  where: { provider_providerUserId: { provider, providerUserId } },
});
if (stored && BigInt(payload.version) <= BigInt(stored.version)) return; // discard

await db.playerAccount.upsert({
  where: { provider_providerUserId: { provider, providerUserId } },
  create: { provider, providerUserId, state: payload.state,
            version: payload.version, contactId: payload.contactId },
  update: { state: payload.state, version: payload.version,
            contactId: payload.contactId },
});
```

Worked example, one Steam account moving from contact A to contact B. Versions
are the pair's own sequence.

| Delivery | Arrives | Stored after |
| --- | --- | --- |
| `linked` v3 (A) | first | `linked`, A, v3 |
| `linked` v5 (B) | before v4 | `linked`, B, v5 |
| `unlinked` v4 (A) | late | unchanged: `4 > 5` is false |
| `linked` v5 (B) | retry | unchanged: `5 > 5` is false |

Without the guard, the late v4 would overwrite v5 and your database would say the
account is unlinked while Hogsend says B owns it. PULL is authoritative, so a
reconcile against `GET /v1/accounts/{provider}/{providerUserId}` repairs a mirror
that drifted.

## Events

Three outbound events, all emitted from the intent layer (the hosted callback,
the data plane, the merge and contact-deletion legs), never from the ingest path.

- **`account.linked`**: `{ state: "linked", provider, providerUserId,
  contactId, userId, email, username, method, relink, version, at }`. `userId` is
  the canonical contact key (`external_id ?? anonymous_id ?? id`). `email` is the
  **contact's** address, never the provider-reported one. `relink` is true when
  the link moved the platform account off another contact.
- **`account.unlinked`**: `{ state: "unlinked", provider, providerUserId,
  contactId, userId, email, reason, version, at }`. `reason` is `player`, `api`
  or `relinked`. It shares the pair's version sequence with `account.linked`,
  which is what lets one monotonic guard cover both.
- **`account.link_failed`**: `{ provider, reason, contactId, at }`. `reason` is
  `denied`, `vetoed`, `exchange_failed` or `state_invalid`. It carries no
  `version` and no `state`, because nothing mutated. `contactId` is `null`
  whenever the flow failed before a trustworthy contact was in hand, and this
  event never mints a contact.

The two state events dedupe on `al:<provider>:<providerUserId>:v<version>`, so a
re-emit of the same mutation is swallowed at the delivery layer.
`account.link_failed` deliberately carries no dedupe key: two genuine failures in
a row are two genuine facts, and collapsing them would hide a brute-force
pattern.

Two events deliberately do not exist. There is no `account.link_started`:
journeys mint link URLs at volume and most are never clicked, and `/start`
writes nothing to the database. There is no `account.updated`: read
`tokensRevokedAt` and the rest of the row from the pull plane instead.

## Hooks

```ts
accountLinks: {
  hooks: {
    beforeLink: async (ctx) => {
      if (ctx.currentOwnerContactId) return { allow: false, reason: "takeover" };
    },
    afterLink: async (ctx) => {
      await grantSkin(ctx.userId, ctx.identity.providerUserId);
    },
    afterUnlink: async (ctx) => {
      await revokeSkin(ctx.userId, ctx.providerUserId);
    },
  },
}
```

`beforeLink` is blocking, bounded at 5s (`ACCOUNT_LINK_HOOK_TIMEOUT_MS`) and
**fail-closed**. A throw, a timeout and an explicit `{ allow: false }` are one
outcome: the link is rejected and `account.link_failed{vetoed}` is emitted. A
slow hook is a rejected link. Returning nothing allows, so a hook that only
observes cannot veto by accident. It runs after the provider proved control and
before anything is written, so a veto leaves no row and, on the cold path, no
contact.

`afterLink` and `afterUnlink` run post-commit, are at-least-once (write them
idempotent), are fail-open, and are bounded by the same 5s. A throw is logged and
never unwinds the link. `afterLink` runs before the success page renders, so "you
now have your reward" is true when the player reads it.

`ctx.contactId` is `null` on `beforeLink` for a cold link and `anonymousId` is
set instead; exactly one of the two is present. On `afterLink` the contact is
always resolved. `currentOwnerContactId` is set only on the warm path, and only
when a different contact currently owns the platform account.

These are in-process hooks, not a delivery mechanism. A process that dies
mid-hook loses the call. Anything that must not be missed belongs on the outbound
webhooks or on a pull reconcile.

## Examples

Four things a consumer writes. The first, second and fourth type-check against
the exported types; the third runs in your app, against your database, so only
its guard is ours.

### 1. Register providers

This repo's own consumer app is the reference: `apps/api/src/account-links.ts`
holds the hooks, `apps/api/src/index.ts` and `apps/api/src/worker.ts` pass them.
Providers are not listed anywhere in it. The env presets build them, so the same
code serves a Steam-only deploy and a Steam plus Twitch one.

```ts
import { contacts, type Database } from "@hogsend/db";
import type { AccountLinkHooks } from "@hogsend/engine";
import { eq, sql } from "drizzle-orm";

// The hooks are passed INTO createHogsendClient, which is what builds `db`, so
// they read a deferred handle wired after the client exists.
let dbHandle: Database | undefined;
export function setAccountLinkDb(db: Database): void {
  dbHandle = db;
}

export const accountLinkHooks: AccountLinkHooks = {
  // Post-commit, at-least-once, fail-open, bounded at 5s. Idempotent by
  // construction: one UPDATE setting the same keys to the same values, with no
  // read-modify-write in between. A null value clears its key.
  async afterLink(ctx) {
    if (!dbHandle) return;
    const patch = {
      [`${ctx.provider}_user_id`]: ctx.identity.providerUserId,
      [`${ctx.provider}_username`]: ctx.identity.username ?? null,
      [`${ctx.provider}_linked_at`]: ctx.at,
      // The bigint version as a STRING. Never parseInt it.
      [`${ctx.provider}_link_version`]: ctx.version,
    };
    await dbHandle
      .update(contacts)
      .set({
        properties: sql`jsonb_strip_nulls(COALESCE(${contacts.properties}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
      })
      .where(eq(contacts.id, ctx.contactId));
  },
};
```

```ts
const client = createHogsendClient({
  journeys,
  email: { templates },
  accountLinks: {
    hooks: accountLinkHooks,
    allowedOrigins: ["https://play.yourgame.com"],
  },
});
setAccountLinkDb(client.db);
```

The link lands on `contacts.properties` as `steam_user_id`,
`steam_linked_at` and `steam_link_version`, so journeys, buckets and the Studio
contact panel read it with no new machinery. `afterUnlink` sets the same keys to
`null`, which `jsonb_strip_nulls` removes.

Passing `accountLinks` at all is operator intent, so `apps/api` passes it only
when one of the four env-intent vars is set: `ACCOUNT_LINK_ALLOWED_ORIGINS`,
`ACCOUNT_LINK_TWITCH_CLIENT_ID`, `ACCOUNT_LINK_TWITCH_CLIENT_SECRET` or
`STEAM_WEB_API_KEY`. `ACCOUNT_LINK_STATE_TTL_SECONDS` is not one of them,
because it carries a default and counting it would make every deploy look like
it opted in. That keeps a deploy that never asked for account linking free of a
live `/v1/accounts/steam/start`. An app built for account linking can pass the
option unconditionally.

### 2. Add a platform the engine does not ship

Battle.net is a plain OAuth2 authorization-code platform, so it is
`oauth2Link()` plus a field mapping. No package, no plugin, no engine change.

```ts
import { AccountLinkCallbackError, oauth2Link } from "@hogsend/engine";

export const battlenet = oauth2Link({
  meta: { id: "battlenet", name: "Battle.net" },
  authorizeEndpoint: "https://oauth.battle.net/authorize",
  tokenEndpoint: "https://oauth.battle.net/token",
  clientId: process.env.BATTLENET_CLIENT_ID ?? "",
  clientSecret: process.env.BATTLENET_CLIENT_SECRET ?? "",
  scopes: ["openid"],
  usePkce: true,
  userInfo: {
    url: "https://oauth.battle.net/oauth/userinfo",
    // MUST pick the platform's immutable id. `sub` is the account id;
    // `battletag` is a renameable handle, so it is display data only.
    map: (json) => {
      const profile = json as { sub?: string; battletag?: string };
      if (!profile.sub) {
        throw new AccountLinkCallbackError(
          "exchange_failed",
          "userinfo carried no sub",
        );
      }
      return {
        providerUserId: profile.sub,
        ...(profile.battletag ? { username: profile.battletag } : {}),
      };
    },
  },
  // One live Battle.net account per contact, and an account already owned by
  // someone else is refused rather than moved.
  multiple: false,
  onConflict: "reject",
});
```

Register it with `accountLinks: { providers: [battlenet] }`. Add `storeTokens:
true` to seal the grant into `linked_accounts.tokens`, which also enables
`refresh()`, and `revokeEndpoint` to add best-effort revoke on unlink. Set
`userInfo.headers` for a platform that needs a second header on the profile
call, as Twitch does with `Client-Id`.

### 3. Mirror links into your own database

The version guard, in full, with the discard branch written out. This is the
example to copy exactly: it is what makes duplicate, out-of-order and late
deliveries safe.

```ts
// The payload of account.linked / account.unlinked, narrowed to the fields the
// mirror needs. `version` is a decimal string because the column is a Postgres
// bigint.
interface AccountEvent {
  state: "linked" | "unlinked";
  provider: string;
  providerUserId: string;
  contactId: string;
  userId: string | null;
  email: string | null;
  version: string;
  at: string;
}

export async function handleAccountEvent(event: AccountEvent) {
  const stored = await db.playerAccount.findUnique({
    where: {
      provider_providerUserId: {
        provider: event.provider,
        providerUserId: event.providerUserId,
      },
    },
  });

  // DISCARD. A duplicate, a reordered pair and a late delivery all land here.
  // BigInt, never parseInt: past Number.MAX_SAFE_INTEGER a float64 comparison
  // stops discriminating and records the wrong owner, silently and forever.
  if (stored && BigInt(event.version) <= BigInt(stored.version)) {
    return "discarded";
  }

  // APPLY. Upsert keyed on the pair, never on contactId: a relink moves the
  // pair between contacts and both mutations belong to one version sequence.
  await db.playerAccount.upsert({
    where: {
      provider_providerUserId: {
        provider: event.provider,
        providerUserId: event.providerUserId,
      },
    },
    create: {
      provider: event.provider,
      providerUserId: event.providerUserId,
      state: event.state,
      contactId: event.contactId,
      version: event.version,
      linkedAt: event.at,
    },
    update: {
      state: event.state,
      contactId: event.contactId,
      version: event.version,
      linkedAt: event.at,
    },
  });
  return "applied";
}
```

Verify the signature first: the delivery is a signed outbound webhook, and this
handler must not run on an unverified body. `account.link_failed` carries no
`version` and no `state`, so it never reaches this function.

### 4. Use a link server-side

The reverse lookup. Your game server knows a SteamID and nothing else; this
turns it into the contact and puts the event on the lifecycle spine under the
contact's own key, where a journey can trigger on it.

```ts
import { contacts } from "@hogsend/db";
import { defineWebhookSource, getLiveLink } from "@hogsend/engine";
import { eq } from "drizzle-orm";
import { z } from "zod";

export const gameServerSource = defineWebhookSource({
  meta: { id: "game-server", name: "Game server" },
  auth: {
    type: "match",
    header: "x-game-server-secret",
    envKey: "GAME_SERVER_WEBHOOK_SECRET",
  },
  schema: z.object({
    steamId: z.string().regex(/^\d{17}$/),
    event: z.string(),
    level: z.number().optional(),
  }),
  async transform(payload, ctx) {
    const link = await getLiveLink({
      db: ctx.db,
      provider: "steam",
      providerUserId: payload.steamId,
    });
    // No link means we do not know who this is. Returning null ingests
    // nothing, which is the honest answer: a SteamID is not a contact.
    if (!link) return null;

    const [contact] = await ctx.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, link.contactId))
      .limit(1);
    if (!contact) return null;

    return {
      event: payload.event,
      // The canonical contact key: external_id ?? anonymous_id ?? id.
      userId: contact.externalId ?? contact.anonymousId ?? contact.id,
      ...(contact.email ? { userEmail: contact.email } : {}),
      eventProperties: {
        steam_id: payload.steamId,
        ...(payload.level === undefined ? {} : { level: payload.level }),
      },
    };
  },
});
```

`getLiveLink` reads the live row directly, so it is strongly consistent and
never a cached mirror. Outside the engine process, `GET
/v1/accounts/{provider}/{providerUserId}` answers the same question with a
secret key.

### Triggering a journey on a link

`account.linked`, `account.unlinked` and `account.link_failed` reach the journey
plane, so a journey triggers on them directly:

```ts
export const steamWelcome = defineJourney({
  meta: {
    id: "steam-welcome",
    trigger: { event: "account.linked", where: (b) => b.prop("provider").eq("steam") },
    entryLimit: { type: "once" },
  },
  async run(user, ctx) {
    await sendEmail({ to: user.email, template: Templates.STEAM_LINKED });
  },
});
```

The event properties are scalars: `provider`, `providerUserId`, `username`,
`method`, `relink`, `version`, and `state`. `version` is a decimal STRING —
compare it with `BigInt()`, never `parseInt`.

This is a SECOND plane, not a replacement for the outbound webhook. The journey
plane fires journeys inside Hogsend and reaches no subscriber; the outbound
spine ships state to yours. A fact arrives on both.

An `account.link_failed` never creates a contact, so a journey only sees one
when the failure can be attributed to a contact that already exists.

## Unlinking

**`POST /v1/accounts/me/revoke` is the primary path.** The publisher's site
already knows the signed-in player and already mints a `userToken` for the rest
of the SDK, so this needs no email, no hosted page and no token in a URL:

```bash
curl -X POST $API/v1/accounts/me/revoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pk_…" \
  -d '{"provider":"steam","userToken":"…"}'
# {"revoked":1}
```

It is keyed on `provider`, not `providerUserId`, because `GET /v1/accounts/me`
deliberately returns no id. It unlinks every live link the token's contact holds
for that provider with `reason: "player"`, each at its own new version, each
emitting one `account.unlinked`. A body naming an identity (`contactId`, `email`
or a foreign `userId`) is `403`. A token problem is `200 {"revoked":0}`, the same
answer as a player who holds nothing.

**`DELETE /v1/accounts/{provider}/{providerUserId}` is the operator path.**
Secret key plus the `accounts` scope, for reconciliation and erasure. It stamps
`reason: "api"` and returns `{ unlinked, version }`. An unknown pair is
`200 {"unlinked":false}` with no emission.

Contact deletion soft-unlinks every live link the contact held, one version and
one `account.unlinked` per row, so a mirror converges without a special case.

Unlinks are soft. The row keeps its history and `unlinked_at` is set, which is
what keeps the pair's version sequence monotonic across relinks.

The hosted manage page for a player with no session is not built yet; see
[Limitations](#limitations).

## `GET /v1/accounts/me` never confirms existence

```bash
curl "$API/v1/accounts/me?userToken=forged" -H "Authorization: Bearer pk_…"
# {"accounts":[]}
curl "$API/v1/accounts/me" -H "Authorization: Bearer pk_…"
# {"accounts":[]}
```

An absent token, a malformed one, an expired one, a forged one and a valid token
for a user nobody owns all return `200 {"accounts":[]}`, byte-identical to a real
player with no links. There is no `401`, no `403`, no `404` and no varying error
body. The route is browser-reachable, so any distinguishable answer would let a
caller enumerate which players a publisher has and which platform accounts they
hold.

It returns display fields only: `provider`, `username`, `avatarUrl`, `linkedAt`.
Never `providerUserId`, `contactId`, `version` or `method`. The serializer builds
a fresh four-key object rather than spreading the row, so a new column cannot
leak into it.

The one non-200 is `403` for a body that tries to name an identity on the revoke
sibling. That is a malformed request, not a question about whether a contact
exists.

## Importing existing links

`POST /v1/accounts/import` backfills links a customer already had, so arriving
with years of Steam history does not mean asking every player to re-authorize.
Secret key plus the `accounts` scope, up to 1000 rows, each naming exactly one of
`contactId` or `email`, optionally `username`, `avatarUrl` and a historical
`linkedAt`.

```bash
curl -X POST $API/v1/accounts/import -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"rows":[{"provider":"steam","providerUserId":"7656…","email":"a@example.com"}]}'
# {"inserted":1,"conflicts":[]}
```

**It is insert-only, and structurally so.** A pair that already has a live owner
comes back under `conflicts` with `reason: "already_linked"` and the existing row
completely untouched: same contact, same version, same `linkedAt`. Only a
completed hosted callback may move a link, because only the callback carries
proof of control of the platform account. The route passes
`allowDisplaceLiveOwner: false` and pins `onConflict: "reject"`, so a provider
whose author wrote `onConflict: "replace"` does not become an import-time
takeover primitive.

Partial success is the contract: every clean row applies and both counts come
back. A row naming a contact that does not exist is a conflict with
`reason: "unknown_contact"`, never a newly minted contact. A pair already owned
by that same contact is neither an insert nor a conflict; nothing transitioned,
so nothing is emitted. Imported rows are stamped `method: "import"` and hold no
tokens.

**An import does not enroll journeys.** A backfill is a statement about the
past, so `enrollJourneys` defaults to `false`: importing a publisher's existing
Steam history does not run an `account.linked` journey once per row, and does
not send a welcome email to the entire back catalogue on migration day. Opt in
per request when you want it:

```bash
-d '{"enrollJourneys":true,"rows":[…]}'
```

The **outbound** `account.linked` webhook fires either way — the customer's
mirror has to converge whether or not a journey ran. The two are different
planes.

If you do opt in, imported rows are stamped `method: "import"` and `method` is
one of the event properties, so a trigger can still single them out:

```ts
where: (b) => b.prop("method").neq("import")
```

Re-running the same import is safe regardless: an unchanged pair transitions
nothing, so it emits nothing and enrolls nothing.

## Provider setup

### Steam

No OAuth application, no client id, no secret, no redirect URI to register.
"Sign in through Steam" is OpenID 2.0, and the entire security model is a
server-side `check_authentication` round trip. Steam issues no tokens at all, so
there is nothing to refresh and nothing to revoke, and `linked_accounts.tokens`
is null for every Steam row.

The only optional piece is a Web API key from `https://steamcommunity.com/dev/apikey`,
which requires a Steam account that owns at least one game and a domain at
registration. Set it as `STEAM_WEB_API_KEY` to fill `username` and `avatarUrl`.
Without it both stay null and linking is unaffected.

### Twitch

Create an application at `https://dev.twitch.tv/console/apps`, copy the Client ID
and Client Secret into `ACCOUNT_LINK_TWITCH_CLIENT_ID` and
`ACCOUNT_LINK_TWITCH_CLIENT_SECRET`, and register the OAuth Redirect URL exactly:

```
https://api.yourgame.com/v1/accounts/twitch/callback
```

The redirect URI is derived from `API_PUBLIC_URL` with any trailing slash
stripped, and the callback leg presents it byte-for-byte. `providerUserId` is the
Helix numeric `id`, never `login` or `display_name`: both are user-editable, so
keying on one would let a player rename themselves onto another player's link
row. A Helix email arrives as the `twitch_email` property, never as an identity
key, because Helix exposes no per-address verification flag.

### Discord is not an account-link provider

Discord linking already exists and works through `plugin-discord` (the
`member_link` OAuth flow, cold connect, and `contacts.discordId`), and that is
the supported path. A second writer on `contacts.discordId` would drift against
the first. An operator who sees the `ACCOUNT_LINK_` prefix and goes looking for a
Discord pair will find `DISCORD_APPLICATION_ID` / `DISCORD_CLIENT_SECRET`, which
belong to the Discord **connector**. See `docs/connect-discord.md`.

## Per-tenant redirect URIs

Hogsend is deployed instance per tenant, so each customer registers their own
OAuth application against their own `API_PUBLIC_URL`. Grants are issued to the
customer's application and tokens are sealed in the customer's own database.
There is no Hogsend-operated OAuth application in the path, so a Hogsend
compromise cannot surrender another customer's players. A multi-tenant SaaS that
proxies every customer through one registered application has exactly that single
point of surrender.

The cost is honest and worth stating: a customer must register the application
themselves, and a redirect URI has to be re-registered whenever `API_PUBLIC_URL`
changes. Steam pays neither cost, because it registers nothing.

## Adding another provider

The provider set is open. Author one with `defineAccountLink()` from
`@hogsend/engine` in your own repo and pass it via `accountLinks.providers`:

```ts
import { defineAccountLink } from "@hogsend/engine";

export const itch = defineAccountLink({
  meta: { id: "itch", name: "itch.io" },
  capabilities: { tokens: true, pkce: true },
  authorizeUrl: ({ state, redirectUri, codeChallenge }) => "…",
  handleCallback: async ({ query, redirectUri, codeVerifier }) => ({
    providerUserId: "…", // the platform's IMMUTABLE id, never a handle
  }),
});
```

An account-link provider is not a plugin package. Steam and Twitch are config
over presets inside `@hogsend/engine`, statically imported, so there is no
package to install and no direct-dependency rule to satisfy.

A provider owns exactly two wires: build the authorize URL, and turn a callback
into a proven `LinkedIdentity`. Everything stateful (the state token, the contact
resolve, the link store, versioning, hooks, outbound events) lives in the engine
and is deliberately not expressible in the contract. `handleCallback` must verify
with the platform rather than trust the callback's own parameters, since it is
the only proof-of-control step in the feature.

`meta.id` is the `:provider` path segment and a database discriminator, so it
matches `/^[a-z][a-z0-9_-]{0,31}$/` and may not be one of the reserved ids: `me`,
`import`, `link-url`, `manage`, `callback`, `start`, `email`, `sms`.
`defineAccountLink` throws at module load on any of these, and on `onConflict`
without `multiple: false`, or `refresh` / `revoke` without
`capabilities.tokens`.

## Security posture

- **Only a completed hosted callback may move a link.** Import, the data plane
  and the SDK all pass `allowDisplaceLiveOwner: false`; only the callback, and
  only on the warm path, passes true.
- **A cold link may attach only to an anonymous-only contact.** The contact side
  of a cold link is an anonymous id typed into an unauthenticated URL, so it
  cannot displace a live owner and cannot attach to an identified contact. An
  `anonymous_id` that names a live contact's `external_id` or email is refused
  outright rather than minting a lookalike.
- **The authoritative contact is the one sealed into the state token**, never the
  provider-reported email. A provider email is a display property at most; only
  a provider-verified address is even recorded, and it never merges a contact.
- **Publishable keys cannot mint for an arbitrary contact.** `link-url` mints
  only for the `userToken`'s own user and `403`s a body naming any identity.
- **`beforeLink` is fail-closed.** A throw or a timeout rejects the link.
- **`GET /v1/accounts/me` never confirms existence** and returns display fields
  only.
- **The Steam `check_authentication` round trip goes to Steam's hardcoded
  endpoint**, never to the `openid.op_endpoint` the callback names. An attacker
  who names the verifier answers their own verification.
- **State tokens are single use.** The callback burns the nonce in Redis, refuses
  a state minted for another provider, and refuses a state whose purpose is not
  `account_link`. Redis being unavailable is a refusal, not a bypass.
- **`returnTo` is checked against the allowlist at redirect time**, not only at
  mint time, because the allowlist can be edited while the player is on the
  consent screen. An off-allowlist value falls back to the hosted page. It is
  never `*`.

## Limitations

- `username` and `avatarUrl` are `null` for Steam unless `STEAM_WEB_API_KEY` is
  set. The OpenID assertion carries the steamid64 and nothing else.
- A minted link URL expires after `ACCOUNT_LINK_STATE_TTL_SECONDS` (default 900,
  15 minutes). A stale link is refused at the callback even when the platform
  already returned a valid signed identity: the log carries the verification
  reason (for example `expired`), `account.link_failed{state_invalid}` is emitted
  with `contactId: null`, nothing is written, and the page says "Nothing was
  changed." Mint the URL when the player clicks, not in advance.
- Redis is required for the mint throttle, the nonce burn and PKCE custody, and
  all three fail closed. No Redis means `503` on the hosted routes and `429` on
  the mints.
- The hosted result pages are placeholders. They are safe (nothing player-
  supplied is interpolated, `noindex`, and the failure page never says which of
  the four reasons occurred) but unbranded.
- Steam accepts a loopback realm. A link completed against
  `API_PUBLIC_URL=http://localhost:3007` on 2026-08-14, so the quickstart above
  needs no tunnel. Twitch is different: it rejects loopback redirect URIs on a
  public application, so testing Twitch locally needs a tunnel URL in
  `API_PUBLIC_URL`, registered as the redirect URI on the Twitch app, and an API
  restart.
- Not built yet, so do not go hunting for them: the hosted manage page, the embed
  SDK button (`hogsend.linkAccount()`), the `@hogsend/client` `accounts.*`
  resource, the periodic property sync (`AccountLinkProvider.sync` is declared in
  the contract and validated, but no cron reads it and there is no `synced_at`
  column), and a Studio panel.

## Deferrals (v1)

- Epic, Xbox and PSN presets. Epic in particular is gated on an organization
  application that takes weeks to approve.
- The Framer script-tag drop-in.
- Promoting a provider to a real `IdentityKind`. A steamid64 is not a merge key
  today; a cold Steam link keys its contact on a browser anonymous id until the
  player identifies, at which point the ordinary orphan-adoption path stamps
  their history.
- `account.updated`. Read `tokensRevokedAt` from the pull plane instead.
- Discord as a `defineAccountLink` provider. The `plugin-discord` connector is
  the supported path today, not a stopgap. See `docs/connect-discord.md`.
