/**
 * Event names for the dogfood in-app notification demo (the "Try it live" panel
 * on the docs client-side page). The browser's `client.capture("demo.welcome",
 * { name })` fires these; the matching journeys in `demo-inapp.ts` trigger on
 * them and `sendFeedItem` a personalized notification back into the visitor's
 * own anonymous feed.
 *
 * The trigger strings here MUST match the `ACTIONS[].event` strings in
 * apps/docs/components/hogsend/try-it-demo.tsx exactly.
 */
export const DemoEvents = {
  WELCOME: "demo.welcome",
  LAUNCH_ANNOUNCEMENT: "demo.launch_announcement",
  TRIAL_ENDING: "demo.trial_ending",
} as const;

export type DemoEvent = (typeof DemoEvents)[keyof typeof DemoEvents];
