---
"@hogsend/js": minor
"@hogsend/react": minor
---

Make a late-arriving `userToken` apply in place instead of forcing a
`<HogsendProvider>` remount.

`@hogsend/js` gains `client.setUserToken(token)`: it sets the signed token and
re-fetches every connected feed + banner so the notification bell
re-authenticates as the now-identified recipient. `reset()` now also clears the
token AND drops every feed/banner slice (then re-fetches as anon), so a
signed-out viewer on a shared device can't keep reading the previous
recipient's private notifications — the guarantee the old provider remount gave
by destroying the client.

`@hogsend/react` `<HogsendProvider>` now reacts to a `userToken` prop change
(mirroring the existing `userId` re-identify effect) and to sign-out
(`userId` → falsy calls `client.reset()`). Consumers that previously keyed the
provider on the resolved identity to force the token through can drop the
`key` — avoiding a full remount of the provider's subtree (which, in the docs
site, re-flashed the home hero every time the feed token resolved).
