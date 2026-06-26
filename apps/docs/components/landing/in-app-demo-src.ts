/**
 * The in-app welcome journey, shown verbatim in the home-page live-demo code
 * panel.
 *
 * Lives in its own server-safe module (NOT `"use client"`) for the same reason
 * as `survey-demo-src.ts`: the panel is rendered by `<CodeWindow>` — whose
 * `<CodeHighlight>` is an async RSC (server-side Shiki) — from the server
 * `InAppDemo` wrapper, then passed into the client `<InAppDemoLive>` as a prop.
 * Exporting the string from a client module would hand back a client-reference
 * proxy instead of the actual source, so it stays a plain value here.
 *
 * Mirrors `demoWelcome` deployed on the dogfood engine
 * (`src/journeys/docs-inapp-demo.ts`) — the onboarding moment the demo leads
 * with.
 */
export const IN_APP_SRC = `import { days } from "@hogsend/core";
import { defineJourney, sendFeedItem } from "@hogsend/engine";
import { Events } from "./constants/index.js";

// demo.welcome -> drop a personalized welcome into the visitor's bell.
// The shape every onboarding flow uses: an event comes in, a journey reads
// the person, and sendFeedItem keys the notification to their canonical id
// -- anonymous or known, one identity end to end.
export const demoWelcome = defineJourney({
  meta: {
    id: "demo-welcome",
    name: "Demo — In-app welcome",
    enabled: true,
    trigger: { event: Events.DEMO_WELCOME }, // "demo.welcome"
    entryLimit: "unlimited",                 // re-fire freely
    suppress: days(0),
  },
  run: async (user) => {
    const name =
      typeof user.properties.name === "string"
        ? user.properties.name
        : "there";
    await sendFeedItem({
      recipient: { anonymousId: user.id }, // your canonical key
      type: "welcome",
      title: "Your welcome journey just ran ✅",
      body: \`Welcome, \${name} — you fired demo.welcome, a journey picked it up, and this dropped into your bell. Same identity end to end, no login.\`,
      actionUrl: "https://hogsend.com/docs/client-side/try",
    });
  },
});`;
