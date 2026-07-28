---
"@hogsend/engine": minor
---

**BREAKING: `getPostHog()` has been removed from `@hogsend/engine`.** There is no
deprecated shim and no re-export alias — the import fails to compile, on purpose.
A silent runtime no-op would have looked like "analytics stopped working" weeks
later; a type error is discovered at build time.

Replace it with the vendor-neutral `getAnalytics()`, newly exported from
`@hogsend/engine`. It returns the container's active `AnalyticsProvider` (or
`undefined` when the deployment configures none), so swapping the `analytics`
option on `createHogsendClient` actually swaps what your journeys get back —
which was never true of the PostHog-shaped singleton. The engine's own internals
already read `getAnalytics()`; this finishes ADR 0001 (provider boundary) for
the analytics ACCESSOR. Vendor-named exports still exist for vendor-specific
work (`lookupPostHogPerson`, `EXPECTED_POSTHOG_SCOPES`, `seedPostHogDestination`,
`posthogDestination`) — those name PostHog because they ARE PostHog. What is
gone is the vendor name on the general-purpose wire every journey reaches for.

Migration:

```ts
// Before
import { getPostHog } from "@hogsend/engine";

await getPostHog()?.getPersonProperties(user.id);
getPostHog()?.identify(user.id, { plan: "pro" });
getPostHog()?.captureEvent({ distinctId: user.id, event: "upgraded" });
await getPostHog()?.shutdown();

// After
import { getAnalytics } from "@hogsend/engine";

await getAnalytics()?.getPersonProperties(user.id);
await getAnalytics()?.setPersonProperties({
  distinctId: user.id,
  set: { plan: "pro" },
});
getAnalytics()?.capture({ distinctId: user.id, event: "upgraded" });
await getAnalytics()?.shutdown?.();
```

Three call-shape differences to watch for:

- `identify(id, props)` becomes `setPersonProperties({ distinctId, set })` — the
  properties move under `set`, and the call now returns a `Promise`, so `await`
  it (or explicitly ignore it) rather than leaving it floating.
- `shutdown()` is OPTIONAL on `AnalyticsProvider`, so it needs a second optional
  chain: `getAnalytics()?.shutdown?.()`.
- `captureEvent` is renamed `capture`; the options object is unchanged.

One difference the compiler CANNOT catch: `getPostHog()` read
`POSTHOG_API_KEY` at call time and lazily built its own client, so it worked
from any module in any process. `getAnalytics()` reads a singleton that
`createHogsendClient` installs, so it returns `undefined` until a container has
been built IN THAT PROCESS. That is exactly right for journeys, workflows and
route handlers — the API and worker both build a container at boot. But a
standalone script (a one-off backfill, a cron entry point) that imported
`getPostHog` and never touched the container will compile clean after the
mechanical rename and then silently capture nothing. Build a container in those
scripts, or call your analytics provider's SDK directly.

`isFeatureEnabled()` has no successor and is dropped. It existed only on the
deprecated `PostHogService` interface, and the adapter that wraps a legacy
service into an `AnalyticsProvider` already discarded it. Read flags directly
from the PostHog SDK, or use Hogsend's own DB-backed flags.
