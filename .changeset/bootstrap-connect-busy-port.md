---
"create-hogsend": patch
---

fix: bootstrap's PostHog connect step no longer breaks when the app's port is occupied. The "is the API up?" probe accepted ANY HTTP answer on the configured port, so an unrelated dev server squatting on :3002 made bootstrap skip starting the app and the connect CLI 404 against a stranger. The probe is now an authenticated `connect-info` GET with the admin key minted in step 7, whose 200 body must carry `providerId: "posthog"` — 200 proves the responder shares THIS app's database (also preventing the worse case: storing the credential into a *different* Hogsend instance that happens to be running). When the port is busy with anything foreign, the handshake API boots on the next free port via a `PORT` env override and the connect targets it explicitly.
