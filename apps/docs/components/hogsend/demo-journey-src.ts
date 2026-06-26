/**
 * The demo journey source, shown verbatim in the "Try it live" code panel.
 *
 * Lives in its own server-safe module (NOT `"use client"`) on purpose: the
 * panel is rendered by `<CodeWindow>` — whose `<CodeHighlight>` is an async RSC
 * (server-side Shiki) — from inside the server MDX, then passed into the client
 * `<TryItDemo>` as a prop. If this string were exported from the client
 * `try-it-demo` module, importing it into the server MDX would hand back a
 * client-reference proxy instead of the actual string. Keeping it here keeps it
 * a real value on both sides.
 */
export const JOURNEY_SRC = `import { days } from "@hogsend/core";
import { defineJourney, sendFeedItem } from "@hogsend/engine";
import { DemoEvents } from "./constants/index.js";

export const demoWelcome = defineJourney({
  meta: {
    id: "demo-welcome",
    name: "Demo — In-app welcome",
    enabled: true,
    trigger: { event: DemoEvents.WELCOME }, // "demo.welcome"
    entryLimit: "unlimited",                // re-fire freely
    suppress: days(0),
  },
  run: async (user) => {
    const n = user.properties.name;
    const name = typeof n === "string" && n ? n : "there";
    const greeting = name === "there" ? "Welcome" : \`Welcome, \${name}\`;
    await sendFeedItem({
      recipient: { anonymousId: user.id }, // your canonical key
      type: "welcome",
      // Report the event — the site banner already greets by name.
      title: "Your welcome journey just ran ✅",
      body: \`\${greeting} — you fired demo.welcome, a journey ran, and it dropped into your bell.\`,
      actionUrl: "https://hogsend.com/docs/client-side/try",
      journeyStateId: user.stateId,
    });
  },
});`;
