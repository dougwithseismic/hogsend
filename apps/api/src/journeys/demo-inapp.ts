import { days } from "@hogsend/core";
import type { JourneyContext, JourneyUser } from "@hogsend/core/types";
import { defineJourney, sendFeedItem } from "@hogsend/engine";
import { DemoEvents } from "./constants/index.js";

/**
 * DOGFOOD DEMO journeys — power the "Try it live" panel on the docs client-side
 * page (apps/docs/content/docs/client-side/try.mdx).
 *
 * The closed loop, end to end on ONE anonymous identity:
 *   1. The browser fires `client.capture("demo.welcome", { name })` with its
 *      anonymous id (source "inapp").
 *   2. Ingest resolves that anon id to a canonical contact key, which becomes
 *      the journey's `user.id`.
 *   3. `sendFeedItem({ recipient: { anonymousId: user.id } })` re-resolves that
 *      same key and publishes to `feed:<recipientKey>` — the exact feed the
 *      browser's `client.feed()` / the nav bell polls.
 *   4. The bell badges; clicking the item (it carries an `actionUrl`) emits
 *      `inapp.item_clicked` back into the loop.
 * No identify call is involved — a `pk_` publishable key has no user token.
 *
 * `entryLimit: "unlimited"` + `suppress: days(0)` (mirrors the Discord
 * gamification journeys) so a visitor can re-fire each demo button repeatedly
 * and each click drops a fresh item. `actionUrl` is set on every item so the
 * "trackable link → inapp.item_clicked" story holds.
 *
 * The `run*` functions are exported standalone so the vitest harness can drive
 * them directly with a fixture user (the `DefinedJourney` only exposes
 * `{ meta, task }`; the run closure is otherwise unreachable).
 *
 * CANONICAL TEMPLATE — port verbatim to the hogsend-dogfood repo (the engine
 * the production docs site talks to). See .claude-work/docs-notification-demo.md.
 */

/** Pull the visitor's name off the firing event; fall back to "there". */
function nameOf(user: Pick<JourneyUser, "properties">): string {
  const n = user.properties.name;
  return typeof n === "string" && n ? n : "there";
}

/** demo.welcome → a personalized welcome item (with a returning-visitor touch). */
export async function runDemoWelcome(
  user: JourneyUser,
  ctx: JourneyContext,
): Promise<void> {
  const name = nameOf(user);
  // Returning-visitor touch: title with "back" once they've fired this before.
  const { found } = await ctx.history.hasEvent({
    userId: user.id,
    event: DemoEvents.WELCOME,
  });
  await sendFeedItem({
    recipient: { anonymousId: user.id },
    type: "welcome",
    title: found ? `Welcome back, ${name} 👋` : `Welcome, ${name} 👋`,
    body: "You fired demo.welcome → a journey ran → this dropped into your bell. Same anonymous identity, no login.",
    actionUrl: "https://hogsend.com/docs/client-side/try",
    journeyStateId: user.stateId,
  });
}

/** demo.launch_announcement → a broadcast-style item. */
export async function runDemoLaunch(user: JourneyUser): Promise<void> {
  const name = nameOf(user);
  await sendFeedItem({
    recipient: { anonymousId: user.id },
    type: "announcement",
    title:
      name === "there"
        ? "Hogsend v1 is live 🚀"
        : `${name} — Hogsend v1 is live 🚀`,
    body: "Code-first lifecycle journeys, in your repo, on PostHog + Resend. This is a broadcast item — clicking it fires a first-party event.",
    actionUrl: "https://hogsend.com/docs",
    journeyStateId: user.stateId,
  });
}

/** demo.trial_ending → a lifecycle nudge with a trackable CTA. */
export async function runDemoTrialNudge(user: JourneyUser): Promise<void> {
  const name = nameOf(user);
  await sendFeedItem({
    recipient: { anonymousId: user.id },
    type: "nudge",
    title:
      name === "there"
        ? "Your trial ends in 3 days"
        : `${name}, your trial ends in 3 days`,
    body: 'A lifecycle nudge a real journey would send on a schedule. The "Open" link below is trackable — clicking it emits inapp.item_clicked.',
    actionUrl: "https://hogsend.com/pricing",
    journeyStateId: user.stateId,
  });
}

export const demoWelcome = defineJourney({
  meta: {
    id: "demo-welcome",
    name: "Demo — In-app welcome",
    enabled: true,
    trigger: { event: DemoEvents.WELCOME },
    entryLimit: "unlimited",
    suppress: days(0),
  },
  run: runDemoWelcome,
});

export const demoLaunch = defineJourney({
  meta: {
    id: "demo-launch",
    name: "Demo — Launch announcement",
    enabled: true,
    trigger: { event: DemoEvents.LAUNCH_ANNOUNCEMENT },
    entryLimit: "unlimited",
    suppress: days(0),
  },
  run: runDemoLaunch,
});

export const demoTrialNudge = defineJourney({
  meta: {
    id: "demo-trial-nudge",
    name: "Demo — Trial-ending nudge",
    enabled: true,
    trigger: { event: DemoEvents.TRIAL_ENDING },
    entryLimit: "unlimited",
    suppress: days(0),
  },
  run: runDemoTrialNudge,
});
