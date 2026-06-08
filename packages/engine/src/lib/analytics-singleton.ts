import type { PostHogService } from "@hogsend/core";
import { createOptionalSingleton } from "./singleton.js";

/**
 * The injected analytics service, set once by `createHogsendClient` and read by
 * the module-level task-execution sites that have no client reference of their
 * own (the journey durable task in `define-journey`, the bucket PostHog sync).
 *
 * Its role is deliberately NARROW (see the `analytics?` option doc on
 * {@link createHogsendClient}): the identity PULL (`getPersonProperties` for
 * per-user timezone resolution) and the opt-in `bucket.syncToPostHog`
 * person-property mirror. It is explicitly NOT the outbound-catalog firing
 * path — the email/contact/journey/bucket lifecycle fans out durably via
 * DESTINATIONS on the webhook spine, not through this singleton.
 *
 * Mirrors the journey/bucket-registry + client-schedule-defaults singletons:
 * `createHogsendClient` runs in BOTH the API and worker processes, so by the
 * time any worker task executes, the container has already installed the
 * resolved `analytics` instance here — the SAME object exposed on
 * `HogsendClient.analytics`. This makes a swapped `opts.analytics` actually
 * load-bearing at those sites instead of falling back to the module singleton.
 *
 * `undefined` is a first-class value: when `POSTHOG_API_KEY` is unset the
 * container resolves `analytics` to `undefined` and installs it here, so every
 * read remains a no-op exactly as before — hence the optional singleton variant.
 */
const singleton = createOptionalSingleton<PostHogService>();

export const setAnalytics = singleton.set;
export const getAnalytics = singleton.get;
/** Reset the singleton — only for test cleanup. */
export const resetAnalytics = singleton.reset;
