/**
 * The in-app survey journeys, shown verbatim in the survey demo's code panel.
 *
 * Lives in its own server-safe module (NOT `"use client"`) for the same reason
 * as `demo-journey-src.ts`: the panel is rendered by `<CodeWindow>` — whose
 * `<CodeHighlight>` is an async RSC (server-side Shiki) — from inside the server
 * MDX, then passed into the client `<SurveyDemo>` as a prop. Exporting the
 * string from a client module would hand back a client-reference proxy instead
 * of the actual source. Keeping it here keeps it a real value on both sides.
 *
 * Mirrors the two journeys deployed on the dogfood engine
 * (`src/journeys/docs-inapp-demo.ts`): `demoSurvey` drops the NPS card,
 * `demoNpsAnswered` reads the score back off the spine and posts the thank-you.
 */
export const SURVEY_SRC = `import { days } from "@hogsend/core";
import { defineJourney, sendFeedItem, sendSurvey } from "@hogsend/engine";
import { Events } from "./constants/index.js";

// demo.survey → drop an in-app NPS card the visitor answers in their bell.
export const demoSurvey = defineJourney({
  meta: {
    id: "demo-survey",
    name: "Demo — In-app survey",
    enabled: true,
    trigger: { event: Events.DEMO_SURVEY }, // "demo.survey"
    entryLimit: "unlimited",                // re-fire freely
    suppress: days(0),
  },
  run: async (user) => {
    await sendSurvey({
      recipient: { anonymousId: user.id }, // your canonical key
      event: Events.DEMO_NPS_SUBMITTED,    // "demo.nps_submitted"
      mode: "nps",
      property: "score",                   // the answer rides here
      prompt: "How likely are you to recommend Hogsend?",
      title: "Quick question 👇",
      minLabel: "Not likely",
      maxLabel: "Very likely",
    });
    // sendSurvey has NO journeyStateId option — replay-safety is auto-keyed off
    // the Hatchet run anchor inside sendFeedItem.
  },
});

// demo.nps_submitted → a thank-you item echoing the score (closes the loop).
export const demoNpsAnswered = defineJourney({
  meta: {
    id: "demo-nps-answered",
    name: "Demo — NPS answered → thank-you",
    enabled: true,
    trigger: { event: Events.DEMO_NPS_SUBMITTED }, // "demo.nps_submitted"
    entryLimit: "unlimited",
    suppress: days(0),
  },
  run: async (user) => {
    const raw = user.properties.score; // SurveyBlockView captured it under "score"
    const score =
      typeof raw === "number" || typeof raw === "string" ? String(raw) : "?";
    await sendFeedItem({
      recipient: { anonymousId: user.id },
      type: "survey-thanks",
      title: \`Thanks — you scored \${score} 🙏\`,
      body: "You answered an in-app survey. That emitted demo.nps_submitted onto the spine — a journey read your score and dropped this.",
      actionUrl: "https://hogsend.com/docs/client-side/survey",
      journeyStateId: user.stateId, // sendFeedItem DOES accept this
    });
  },
});`;
