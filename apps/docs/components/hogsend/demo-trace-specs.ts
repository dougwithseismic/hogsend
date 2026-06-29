/**
 * Live home-demo trace specs — one `ClipSpec` per demo action, fed to the
 * one-shot `JourneyShot` engine in `components/landing/demo-trace.tsx`. Each is
 * the journey-trace vocabulary (real journey code on the left, the run on the
 * right) for the event the visitor just fired.
 *
 * FAITHFUL to the journeys the production docs site actually talks to —
 * hogsend-dogfood/src/journeys/docs-inapp-demo.ts (NOT the trimmed apps/api
 * mirror). The real shape:
 *   - welcome  → `getPostHog().identify` the visitor (name → PostHog person
 *     property) → check `ctx.history.hasEvent` (returning?) → mint a per-visitor
 *     TRACKED link → `sendFeedItem` into the bell → mirror the event into the
 *     team's Discord (`mirrorToKitchenSink`).
 *   - launch / trial → mint tracked link → `sendFeedItem` → mirror to Discord.
 *   - survey   → `sendSurvey` drops an NPS card; answering emits
 *     `demo.nps_submitted`, and a SECOND journey (`demoNpsAnswered`) writes the
 *     score back onto the PostHog person (identify / $set) and drops a thank-you
 *     item. A true two-journey write-back loop.
 *
 * Every item's `actionUrl` is a minted tracked link (campaign "demo-inapp"), so
 * clicking it fires a real first-party `link.clicked` the engine turns into yet
 * another bell item — surfaced in the band caption, not a trace step (it's a
 * downstream click, not part of this run).
 *
 * `buildDemoTraceSpec(event, name)` injects the visitor's name into the run (the
 * event actor + the rendered send subject) so the trace greets them the same way
 * the rest of the demo does. The `code` strings are trimmed-for-the-frame but
 * real — server-safe plain strings, tokenized client-side by the clip engine.
 *
 * Bands are 0-indexed `[firstLine, lineCount]` into each `code` string.
 */

import type { ClipSpec, ClipStep } from "@/components/clips/clip-types";

/** The event actor shown on the `event` row. */
const actor = (name?: string): string => (name?.trim() ? name.trim() : "you");

/** Launch headline — prefixes the visitor's name like the real journey does. */
const launchSubject = (name?: string): string =>
  name?.trim()
    ? `${name.trim()} — Hogsend v1 is live 🚀`
    : "Hogsend v1 is live 🚀";

/** Trial nudge headline — `${name}, your trial ends…` with the same fallback. */
const trialSubject = (name?: string): string =>
  name?.trim()
    ? `${name.trim()}, your trial ends in 3 days`
    : "Your trial ends in 3 days";

const WELCOME_CODE = `export const demoWelcome = defineJourney({
  meta: { trigger: { event: Events.DEMO_WELCOME } },
  run: async (user, ctx) => {
    // identify on PostHog — name becomes a person property
    getPostHog()?.identify(user.id, {
      name: user.properties.name,
    });
    const { found } = await ctx.history.hasEvent({
      event: Events.DEMO_WELCOME,
    });
    // tracked link — a click fires link.clicked
    const actionUrl = await mintDemoLink(
      "https://hogsend.com/docs/client-side/try",
    );
    await sendFeedItem({
      recipient: { anonymousId: user.id },
      type: "welcome",
      title: found ? "ran again ✅" : "just ran ✅",
      actionUrl,
    });
    await mirrorToKitchenSink(Events.DEMO_WELCOME);
  },
});`;

const LAUNCH_CODE = `export const demoLaunch = defineJourney({
  meta: {
    trigger: { event: Events.DEMO_LAUNCH_ANNOUNCEMENT },
  },
  run: async (user) => {
    const actionUrl = await mintDemoLink(
      "https://hogsend.com/docs",
    );
    await sendFeedItem({
      recipient: { anonymousId: user.id },
      type: "announcement",
      title: "Hogsend v1 is live 🚀",
      actionUrl,
    });
    await mirrorToKitchenSink(
      Events.DEMO_LAUNCH_ANNOUNCEMENT,
    );
  },
});`;

const TRIAL_CODE = `export const demoTrialNudge = defineJourney({
  meta: { trigger: { event: Events.DEMO_TRIAL_ENDING } },
  run: async (user) => {
    const name = user.properties.name ?? "there";
    const actionUrl = await mintDemoLink(
      "https://hogsend.com/pricing",
    );
    await sendFeedItem({
      recipient: { anonymousId: user.id },
      type: "nudge",
      title: \`\${name}, your trial ends in 3 days\`,
      actionUrl,
    });
    await mirrorToKitchenSink(Events.DEMO_TRIAL_ENDING);
  },
});`;

const SURVEY_CODE = `export const demoSurvey = defineJourney({
  meta: { trigger: { event: Events.DEMO_SURVEY } },
  run: async (user) => {
    await sendSurvey({
      recipient: { anonymousId: user.id },
      event: Events.DEMO_NPS_SUBMITTED, // on answer
      mode: "nps",
      property: "score",
      prompt: "How likely are you to recommend Hogsend?",
    });
  },
});

// A second journey reacts to the answer:
export const demoNpsAnswered = defineJourney({
  meta: { trigger: { event: Events.DEMO_NPS_SUBMITTED } },
  run: async (user) => {
    const { score } = user.properties;
    // write the score onto the PostHog person ($set)
    getPostHog()?.identify(user.id, { nps_score: score });
    await sendFeedItem({
      recipient: { anonymousId: user.id },
      type: "survey-thanks",
      title: \`Thanks — you scored \${score} 🙏\`,
    });
  },
});`;

type DemoSpecConfig = {
  id: string;
  file: string;
  code: string;
  steps: (name?: string) => ClipStep[];
};

/** The fan-out destinations the demo journeys write to. */
const POSTHOG = { dest: "PostHog", logo: "posthog.svg" } as const;
const DISCORD = { dest: "Discord", logo: "discord.svg" } as const;

const CONFIGS: Record<string, DemoSpecConfig> = {
  "demo.welcome": {
    id: "demo-welcome",
    file: "src/journeys/docs-inapp-demo.ts",
    code: WELCOME_CODE,
    steps: (name) => [
      { kind: "event", event: "demo.welcome", who: actor(name), band: [1, 1] },
      {
        kind: "fanout",
        label: "identify",
        events: ["name"],
        ...POSTHOG,
        band: [4, 3],
      },
      {
        kind: "check",
        question: "ctx.history.hasEvent",
        sub: "demo.welcome",
        verdict: "found: false",
        band: [7, 3],
      },
      {
        kind: "send",
        subject: "Your welcome journey just ran ✅",
        accent: true,
        band: [14, 6],
      },
      {
        kind: "fanout",
        label: "mirror",
        events: ["demo.welcome"],
        ...DISCORD,
        band: [20, 1],
      },
    ],
  },
  "demo.launch_announcement": {
    id: "demo-launch",
    file: "src/journeys/docs-inapp-demo.ts",
    code: LAUNCH_CODE,
    steps: (name) => [
      {
        kind: "event",
        event: "demo.launch_announcement",
        who: actor(name),
        band: [2, 1],
      },
      {
        kind: "send",
        subject: launchSubject(name),
        accent: true,
        band: [8, 6],
      },
      {
        kind: "fanout",
        label: "mirror",
        events: ["demo.launch_announcement"],
        ...DISCORD,
        band: [14, 3],
      },
    ],
  },
  "demo.trial_ending": {
    id: "demo-trial-nudge",
    file: "src/journeys/docs-inapp-demo.ts",
    code: TRIAL_CODE,
    steps: (name) => [
      {
        kind: "event",
        event: "demo.trial_ending",
        who: actor(name),
        band: [1, 1],
      },
      {
        kind: "send",
        subject: trialSubject(name),
        accent: true,
        band: [7, 6],
      },
      {
        kind: "fanout",
        label: "mirror",
        events: ["demo.trial_ending"],
        ...DISCORD,
        band: [13, 1],
      },
    ],
  },
  "demo.survey": {
    id: "demo-survey",
    file: "src/journeys/docs-inapp-demo.ts",
    code: SURVEY_CODE,
    steps: (name) => [
      { kind: "event", event: "demo.survey", who: actor(name), band: [1, 1] },
      {
        kind: "send",
        subject: "How likely are you to recommend Hogsend?",
        band: [3, 7],
      },
      {
        kind: "wait",
        event: "demo.nps_submitted",
        timeout: "3d",
        resolve: "score: 9",
        band: [15, 1],
      },
      {
        kind: "fanout",
        label: "identify",
        events: ["nps_score: 9"],
        ...POSTHOG,
        band: [18, 2],
      },
      {
        kind: "send",
        subject: "Thanks — you scored 9 🙏",
        accent: true,
        band: [20, 5],
      },
    ],
  },
};

/** Event ids that have a bespoke trace (the rest fall back to welcome). */
export const DEMO_TRACE_EVENTS = Object.keys(CONFIGS);

/**
 * Build the trace spec for a fired event, greeting `name`. Unknown events fall
 * back to the welcome trace so the band never renders empty.
 */
export function buildDemoTraceSpec(event: string, name?: string): ClipSpec {
  const config = CONFIGS[event] ?? CONFIGS["demo.welcome"];
  return {
    id: config.id,
    file: config.file,
    code: config.code,
    steps: config.steps(name),
  };
}
