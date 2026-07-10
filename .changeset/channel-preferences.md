---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/email": minor
"@hogsend/db": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-telegram": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Channel-granular recipient preferences, enforced automatically on every send path — and the shipped `<PreferenceCenter>` now renders them. Zero migrations: channels are lists.

- **Channels are auto-registered opt-out lists** (`kind: "channel"` on `ListMeta`): `in_app` (the notification feed) plus one per connector that exposes member-directed actions (`telegram`, `discord`). They live in the same `email_preferences.categories` key namespace and are managed through the existing `GET /v1/lists` + `POST /v1/lists/:id/(un)subscribe` endpoints. Polarity is identical to the old unknown-key fallback, so existing data behaves exactly as before. `in_app` is now a reserved `defineList` id, and a user list id colliding with a channel id throws at boot.
- **Member-directed connector actions are preference-gated** — Discord `dmMember`, Telegram `dm`/`sendMessage` now check the resolved recipient's `unsubscribedAll` + channel list BEFORE the plugin runs, returning a typed `ConnectorActionSkipped` (guard: `isConnectorActionSkipped`) instead of sending. The verdict is recorded in the durable journal and replays verbatim. A ref that resolves no contact (raw platform id, group chat) has no preference surface and proceeds. Ops actions (roles, broadcasts, mentions, channel messages) are never gated. Namespaced refs (`telegram:<chatId>`) additionally resolve contacts via their `properties.<ns>` platform metadata, so a Telegram identity linked onto an already-identified contact still gates.
- **Feed preference check is now replay-safe and multi-row aware.** The `in_app` gate previously ran before the durable idempotency key was registered — a preference flip between run and replay shifted the positional journal and killed the run. The verdict now lives inside the recorded closure. The read also aggregates ALL `email_preferences` rows (matching the email path), so an unsubscribe imported as an `(email, email)` row suppresses the feed too — a deliberate, suppression-conservative fix.
- **`defineJourney` meta gains `category`** — stamps this journey's `sendEmail` sends in place of the built-in `journey` category, giving per-journey topic granularity through the existing enforcement. Validated fail-closed at boot (unknown → throw; a channel list → throw; an `ENABLED_LISTS`-excluded opt-in list → throw). Campaigns likewise reject channel lists as audiences.
- **New public write `POST /v1/lists/preferences`** sets the global master `unsubscribedAll` behind the same publishable identity gate as list writes; `GET /v1/lists` items carry `kind`; new `GET /v1/admin/lists` exposes the registry to Studio; the hosted preference page sections Channels above Email topics (byte-identical on channel-less engines).
- **`@hogsend/js` / `@hogsend/react`**: `ListSummary.kind?`, `preferences().setUnsubscribedAll()`, `ALL_EMAILS_CATEGORY` (`"$all"`) sentinel on `inapp.preference_changed`; `usePreferences().setUnsubscribedAll`; `<PreferenceCenter>` auto-sections into Channels (with a synthetic Email master row) and Topics when the catalog carries channel kinds — flat and matrix modes render byte-identically to before, so existing consumers need zero changes. New props `layout`, `emailToggle`, `sectionLabels`; new `section`/`sectionHeader` classNames; new `data-sectioned`/`data-section`/`data-kind` attributes.
- **Studio**: the contact drawer gains Channels/Topics preference toggles (email master included) over the new admin lists endpoint.
