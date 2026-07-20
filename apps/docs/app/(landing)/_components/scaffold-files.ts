import type { EmailPreview } from "./minted-files";

/* ==========================================================================
 *  The scaffolded workspace the homepage explorer walks through — a small
 *  monorepo: `hogsend/` is the engine app `create-hogsend` writes (journeys
 *  grouped by the team that owns them, React Email templates one-for-one
 *  with every template a journey references, the Stripe preset, the
 *  Hatchet-powered worker), and `web/` is the product itself consuming the
 *  client SDK (provider, flags hook, video watch-depth).
 *
 *  Journey/webhook/web files use the real engine + SDK APIs (same rules as
 *  the homepage code blocks; playbook names — dunning, event summon,
 *  pre-boarding, silver medalist, second-session rescue — match
 *  hogsend.com/playbook). Every email file carries BOTH source and a
 *  rendered `EmailPreview`; the explorer floats the rendered message in a
 *  corner window beside the code.
 * ========================================================================== */

export type ScaffoldFile = {
  path: string;
  lang: "ts" | "tsx" | "ini" | "bash";
  source: string;
  /** When present, the explorer floats the rendered email beside the code. */
  email?: EmailPreview;
  /** When true, the explorer floats the timezone schedule readout instead. */
  timing?: boolean;
};

/* ---- email factory: one definition renders both the source shown in the
 *      editor and the preview floated beside it, so they can never drift. -- */

function pascal(file: string): string {
  return file
    .replace(/\.tsx$/, "")
    .split("-")
    .map((s) => s[0]?.toUpperCase() + s.slice(1))
    .join("");
}

function wrap(text: string, width = 56): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function email(
  path: string,
  def: {
    subject: string;
    preheader: string;
    heading: string;
    body: string[];
    cta: { label: string; href: string; note?: string };
    sentBy: string;
    comment?: string;
  },
): ScaffoldFile {
  const name = pascal(path.split("/").pop() ?? "");
  const paragraphs = def.body
    .map((p) =>
      [
        "      <Text>",
        ...wrap(p).map((l) => `        ${l}`),
        "      </Text>",
      ].join("\n"),
    )
    .join("\n");
  return {
    path,
    lang: "tsx",
    source: `${def.comment ?? "// Powered by react-email — a template is just a component."}
import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "../_layout";

export function ${name}() {
  return (
    <EmailLayout preview="${def.preheader}">
      <Heading>${def.heading}</Heading>
${paragraphs}
      <Button href={appUrl("${def.cta.href}")}>
        ${def.cta.label}
      </Button>
    </EmailLayout>
  );
}`,
    email: {
      subject: def.subject,
      preheader: def.preheader,
      heading: def.heading,
      body: def.body,
      cta: { label: def.cta.label, note: def.cta.note },
      footer: `Sent by ${def.sentBy}.`,
    },
  };
}

/* ------------------------------------------------------------------------- */

export const SCAFFOLD_FILES: ScaffoldFile[] = [
  /* ==== hogsend/ — the engine app ========================================= */

  /* ---- journeys/product -------------------------------------------------- */
  {
    path: "hogsend/src/journeys/product/onboarding.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import {
  defineJourney,
  sendConnectorAction,
  sendEmail,
} from "@hogsend/engine";

export const onboarding = defineJourney({
  meta: {
    id: "onboarding",
    trigger: { event: "user.signed_up" },
    entryLimit: "once",
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "welcome" });

    // Park durably until THIS user creates a project — or 3 days pass.
    const { timedOut } = await ctx.waitForEvent({
      event: "project.created",
      timeout: days(3),
    });

    if (timedOut) {
      // Stalled — nudge them, and tag the team where it works.
      await sendEmail({ to: user.email, template: "activation-nudge" });
      await sendConnectorAction({
        connectorId: "discord",
        action: "sendChannelMessage",
        args: {
          channelId: process.env.GROWTH_CHANNEL_ID,
          content: \`\${user.email} stalled before their first project.\`,
        },
      });
      return;
    }

    await sendEmail({ to: user.email, template: "first-win" });
  },
});`,
  },
  {
    path: "hogsend/src/journeys/product/second-session-rescue.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

// The second session is the real activation moment — most
// churn simply never comes back for it.
export const secondSessionRescue = defineJourney({
  meta: {
    id: "second-session-rescue",
    trigger: { event: "session.first_ended" },
    entryLimit: "once",
  },
  run: async (user, ctx) => {
    const { timedOut } = await ctx.waitForEvent({
      event: "session.started",
      timeout: days(2),
    });

    if (timedOut) {
      await sendEmail({ to: user.email, template: "second-session" });
    }
    // Came back on their own? Say nothing. Silence is a feature.
  },
});`,
  },
  {
    path: "hogsend/src/journeys/product/winback.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const winback = defineJourney({
  meta: {
    id: "winback",
    trigger: { event: "bucket.went_dormant" },
    exitOn: [{ event: "contact.active" }],
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "winback-check-in" });

    await ctx.sleep({ duration: days(7), label: "cool-off" });

    await sendEmail({ to: user.email, template: "winback-offer" });
  },
});`,
  },

  {
    path: "hogsend/src/journeys/product/weekly-digest.ts",
    lang: "ts",
    timing: true,
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

// Rolling per-user digest: the first report opens a 7-day
// window, the rest of the week folds into ONE send.
export const weeklyDigest = defineJourney({
  meta: {
    id: "weekly-digest",
    trigger: { event: "report.created" },
    entryLimit: "unlimited", // a fresh window after each flush
    suppress: days(0), // the digest IS the rate limit
  },
  run: async (user, ctx) => {
    const digest = await ctx.digest({ window: days(7), label: "weekly" });

    // Tuesday 09:00 in the READER'S timezone — resolved per
    // user, then slept to durably (survives deploys).
    await ctx.sleepUntil(ctx.when.next("tuesday").at("09:00"));

    // 7 days is a long wait — re-check consent before sending.
    if (!(await ctx.guard.isSubscribed())) return;

    // Grouping is plain TypeScript over the window's events.
    const byProject = Object.groupBy(digest.events, (e) =>
      String(e.properties?.projectId),
    );

    await sendEmail({
      to: user.email,
      template: "weekly-digest",
      props: { projects: Object.keys(byProject) },
    });
  },
});`,
  },

  /* ---- journeys/billing --------------------------------------------------- */
  {
    path: "hogsend/src/journeys/billing/trial-conversion.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const trialConversion = defineJourney({
  meta: {
    id: "trial-conversion",
    trigger: { event: "trial.started" },
    // Converted? Out instantly — mid-sequence, mid-sleep, anywhere.
    exitOn: [{ event: "subscription.created" }],
  },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(1), label: "day-one" });
    await sendEmail({ to: user.email, template: "trial-first-value" });

    await ctx.sleep({ duration: days(5), label: "mid-trial" });

    // Branch on real usage, not time: have they done the thing?
    const { found } = await ctx.history.hasEvent({
      userId: user.id,
      event: "report.created",
      within: days(6),
    });

    await sendEmail({
      to: user.email,
      template: found ? "trial-upgrade-value" : "activation-nudge",
    });
  },
});`,
  },
  {
    path: "hogsend/src/journeys/billing/dunning.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

// Triggered by the Stripe webhook source —
// src/webhook-sources/stripe.ts feeds the same pipeline.
export const dunning = defineJourney({
  meta: {
    id: "dunning",
    trigger: { event: "invoice.payment_failed" },
    exitOn: [{ event: "invoice.paid" }],
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "card-trouble" });

    // Three quiet days before the second ask — exitOn cancels
    // the journey the moment the invoice clears.
    await ctx.sleep({ duration: days(3), label: "grace" });

    await sendEmail({ to: user.email, template: "final-notice" });
  },
});`,
  },

  /* ---- journeys/marketing ------------------------------------------------- */
  {
    path: "hogsend/src/journeys/marketing/event-summon.ts",
    lang: "ts",
    source: `import {
  defineJourney,
  sendConnectorAction,
  sendEmail,
} from "@hogsend/engine";

// Live-event summon: email everyone, then DM the Discord
// members where they actually are.
export const eventSummon = defineJourney({
  meta: {
    id: "event-summon",
    trigger: { event: "event.doors_open" },
    entryLimit: "once_per_period",
  },
  run: async (user) => {
    await sendEmail({ to: user.email, template: "doors-open" });

    if (user.properties.discordMemberId) {
      await sendConnectorAction({
        connectorId: "discord",
        action: "dmMember",
        args: {
          member: user.properties.discordMemberId,
          content: "Doors are open — we're live in #main-stage.",
        },
      });
    }
  },
});`,
  },

  /* ---- journeys/people ---------------------------------------------------- */
  {
    path: "hogsend/src/journeys/people/pre-boarding.ts",
    lang: "ts",
    source: `import { defineJourney, sendEmail } from "@hogsend/engine";

// Lifecycle isn't only customers — the people team runs the
// offer-signed → day-one stretch through the same engine.
export const preBoarding = defineJourney({
  meta: {
    id: "pre-boarding",
    trigger: { event: "offer.signed" },
    entryLimit: "once",
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "pre-boarding-day-one" });

    // Sleep durably until the day before their start date.
    const dayBefore = new Date(String(user.properties.startDate));
    dayBefore.setDate(dayBefore.getDate() - 1);
    await ctx.sleepUntil(dayBefore, { label: "day-before" });

    await sendEmail({ to: user.email, template: "day-before-checklist" });
  },
});`,
  },
  {
    path: "hogsend/src/journeys/people/silver-medalist.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

// The runner-up you'd hire tomorrow: keep them warm, and
// reach back out the moment the role reopens.
export const silverMedalist = defineJourney({
  meta: {
    id: "silver-medalist",
    trigger: { event: "candidate.runner_up" },
    exitOn: [{ event: "candidate.hired" }],
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "stay-in-touch" });

    const { timedOut } = await ctx.waitForEvent({
      event: "role.reopened",
      timeout: days(60),
    });

    if (!timedOut) {
      await sendEmail({ to: user.email, template: "role-reopened" });
    }
  },
});`,
  },

  /* ---- emails — one file per template the journeys reference -------------- */
  email("hogsend/src/emails/product/welcome.tsx", {
    subject: "Welcome to my-app",
    preheader: "Your workspace is ready.",
    heading: "Welcome 👋",
    body: [
      "Your workspace is ready. Connect your repo and your first journey ships with your next deploy.",
    ],
    cta: { label: "Open your workspace", href: "/start" },
    sentBy: "onboarding — journeys/product/onboarding.ts",
  }),
  email("hogsend/src/emails/product/activation-nudge.tsx", {
    subject: "Your first project is one command away",
    preheader: "Three minutes, start to finish.",
    heading: "Stuck on step one?",
    body: [
      "Most teams get their first project live in under three minutes. If something got in the way, reply — a human reads these.",
    ],
    cta: { label: "Create your first project", href: "/new" },
    sentBy: "onboarding (stalled branch) — onboarding.ts",
  }),
  email("hogsend/src/emails/product/first-win.tsx", {
    subject: "That first project looked good",
    preheader: "Here's what unlocks next.",
    heading: "First project — done ✅",
    body: [
      "Nice work. Now wire a webhook source and your product's own events start driving journeys.",
    ],
    cta: { label: "Add a webhook source", href: "/sources" },
    sentBy: "onboarding (happy branch) — onboarding.ts",
  }),
  email("hogsend/src/emails/product/second-session.tsx", {
    subject: "Pick up where you left off",
    preheader: "Your setup is saved and waiting.",
    heading: "Everything's where you left it",
    body: [
      "Your first session set the groundwork. The second one is where it clicks — your setup is saved and waiting.",
    ],
    cta: { label: "Jump back in", href: "/dashboard" },
    sentBy: "second-session-rescue.ts",
  }),
  email("hogsend/src/emails/product/winback-check-in.tsx", {
    subject: "Still the right tool?",
    preheader: "No pitch — one honest question.",
    heading: "How's it going?",
    body: [
      "You went quiet a few weeks ago. If we stopped being useful, tell us why — if you just got busy, everything is where you left it.",
    ],
    cta: { label: "See what's changed", href: "/changelog" },
    sentBy: "winback — journeys/product/winback.ts",
  }),
  email("hogsend/src/emails/product/winback-offer.tsx", {
    subject: "Still thinking it over?",
    preheader: "20% off your next three months — expires Friday.",
    heading: "We kept your workspace warm",
    body: [
      "Everything is where you left it — journeys, templates, contacts.",
      "If budget was the sticking point, here's 20% off your next three months.",
    ],
    cta: {
      label: "Reactivate my workspace",
      href: "/reactivate",
      note: "Offer expires Friday",
    },
    sentBy: "winback — journeys/product/winback.ts",
    comment:
      "// Powered by react-email — versioned and reviewed like\n// the journey that sends it.",
  }),
  email("hogsend/src/emails/product/weekly-digest.tsx", {
    subject: "Your week in review",
    preheader: "Everything your projects did this week, in one email.",
    heading: "Your week in review 📈",
    body: [
      "Three projects moved this week. Here's what happened while you were building — reports, comments, and the numbers that changed.",
    ],
    cta: { label: "Open the full digest", href: "/digest" },
    sentBy: "weekly-digest — one send per active week",
  }),
  email("hogsend/src/emails/billing/trial-first-value.tsx", {
    subject: "Day one: the shortest path to value",
    preheader: "One thing to try before anything else.",
    heading: "Start here",
    body: [
      "Skip the tour. The single feature trial users love most takes two minutes — here's exactly how to run it on your own data.",
    ],
    cta: { label: "Try it on your data", href: "/quickstart" },
    sentBy: "trial-conversion (day one) — trial-conversion.ts",
  }),
  email("hogsend/src/emails/billing/trial-upgrade-value.tsx", {
    subject: "You've already outgrown the trial",
    preheader: "Your usage says you're ready.",
    heading: "You're ready",
    body: [
      "You've shipped real work this week — the trial limits are the only thing in your way now. Upgrade keeps everything exactly as it is.",
    ],
    cta: { label: "Upgrade and keep going", href: "/upgrade" },
    sentBy: "trial-conversion (usage branch) — trial-conversion.ts",
  }),
  email("hogsend/src/emails/billing/card-trouble.tsx", {
    subject: "Your payment didn't go through",
    preheader: "No interruption yet — just update your card.",
    heading: "Card trouble — easy fix",
    body: [
      "Your last invoice didn't clear. Nothing is paused yet — update your card and we'll retry automatically.",
    ],
    cta: { label: "Update payment method", href: "/billing" },
    sentBy: "dunning — journeys/billing/dunning.ts",
  }),
  email("hogsend/src/emails/billing/final-notice.tsx", {
    subject: "Last try before your plan pauses",
    preheader: "We retry one more time tomorrow.",
    heading: "One more retry tomorrow",
    body: [
      "We've retried your card for three days. One more attempt tomorrow, then your plan pauses — your data stays safe either way.",
    ],
    cta: { label: "Fix it in 30 seconds", href: "/billing" },
    sentBy: "dunning (grace elapsed) — dunning.ts",
  }),
  email("hogsend/src/emails/marketing/doors-open.tsx", {
    subject: "Doors are open 🎪",
    preheader: "We're live — come find your seat.",
    heading: "We're live",
    body: [
      "Doors just opened. Grab your seat, say hi in the chat, and bring a question for the Q&A.",
    ],
    cta: { label: "Join the stream", href: "/live" },
    sentBy: "event-summon — journeys/marketing/event-summon.ts",
  }),
  email("hogsend/src/emails/people/pre-boarding-day-one.tsx", {
    subject: "You're in! Here's day one",
    preheader: "We can't wait — everything you need for your first day.",
    heading: "You're in 🎉",
    body: [
      "Contract's signed — the whole team is excited. Your laptop ships this week.",
      "Here's your day-one guide, your team, and where to show up.",
    ],
    cta: { label: "Read the day-one guide", href: "/day-one" },
    sentBy: "pre-boarding — journeys/people/pre-boarding.ts",
    comment:
      "// Powered by react-email — the people team's templates live\n// beside product's, in the same repo.",
  }),
  email("hogsend/src/emails/people/day-before-checklist.tsx", {
    subject: "Tomorrow's the day",
    preheader: "Three things before 9am.",
    heading: "See you tomorrow ☀️",
    body: [
      "Quick checklist: badge photo uploaded, laptop charged, and doors open at 9 — your buddy meets you in the lobby.",
    ],
    cta: { label: "Open the checklist", href: "/day-one#checklist" },
    sentBy: "pre-boarding (day-before) — pre-boarding.ts",
  }),
  email("hogsend/src/emails/people/stay-in-touch.tsx", {
    subject: "We meant it — let's stay in touch",
    preheader: "You were a genuinely close call.",
    heading: "You were a close call",
    body: [
      "The decision came down to timing, not talent. When the right role opens we'd love to talk again — no re-interview from zero.",
    ],
    cta: { label: "Keep my profile warm", href: "/talent" },
    sentBy: "silver-medalist — journeys/people/silver-medalist.ts",
  }),
  email("hogsend/src/emails/people/role-reopened.tsx", {
    subject: "That role just reopened",
    preheader: "You're the first person we thought of.",
    heading: "First call goes to you",
    body: [
      "The role you interviewed for is open again, and you're the first person we're telling. Fancy picking up where we left off?",
    ],
    cta: { label: "Restart the conversation", href: "/talent/apply" },
    sentBy: "silver-medalist (role.reopened) — silver-medalist.ts",
  }),

  /* ---- webhook sources ---------------------------------------------------- */
  {
    path: "hogsend/src/webhook-sources/stripe.ts",
    lang: "ts",
    source: `import { stripeSource } from "@hogsend/engine";

// The built-in Stripe preset: signature-verified with node:crypto,
// events normalized (invoice.payment_failed, subscription.updated, …)
// so any of them can trigger a journey. Set STRIPE_WEBHOOK_SECRET
// and point Stripe at POST /v1/webhooks/stripe — that's the setup.
export const stripe = stripeSource;`,
  },

  /* ---- scripts ------------------------------------------------------------ */
  {
    path: "hogsend/scripts/event-qr.sh",
    lang: "bash",
    source: `# Mint a tracked link for the event posters — vanity slug,
# first-party clicks, QR from the same API.
curl -X POST "$API_URL/v1/admin/links" \\
  -H "Authorization: Bearer $HOGSEND_SECRET_KEY" \\
  -d '{
    "url": "https://my-app.com/live",
    "slug": "doors-open"
  }'

# → vanity /l/doors-open · QR via /v1/admin/links/:id/qr
# The QR encodes the durable id, never the destination —
# a printed poster can be re-pointed after it ships.`,
  },

  /* ---- entry points -------------------------------------------------------- */
  {
    path: "hogsend/src/worker.ts",
    lang: "ts",
    source: `// Powered by Hatchet — every journey runs as a durable task.
// A seven-day sleep survives deploys, restarts, and crashes.
import { createWorker } from "@hogsend/engine";
import { client } from "./client";
import { journeys } from "./journeys";

const worker = await createWorker({ container: client, journeys });

await worker.start();`,
  },
  {
    path: "hogsend/.env",
    lang: "ini",
    source: `DATABASE_URL=postgres://localhost:5432/my-app

# Provider is config, not journey code — swap without a rewrite.
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...

# Webhook sources auto-enable when their secret is set.
STRIPE_WEBHOOK_SECRET=whsec_...

# Connectors
DISCORD_BOT_TOKEN=...
GROWTH_CHANNEL_ID=...

# Optional: PostHog turns on identity + person properties.
POSTHOG_API_KEY=phc_...`,
  },

  /* ==== api/ — your backend, on the server SDK ============================ */
  {
    path: "api/src/routes/signup.ts",
    lang: "ts",
    source: `import { Hogsend } from "@hogsend/client";
import { Hono } from "hono";

// Backend Node: the secret-key client talks to the engine's
// data API — capture events, upsert contacts, mint links.
const hs = new Hogsend({
  baseUrl: process.env.HOGSEND_API_URL,
  apiKey: process.env.HOGSEND_SECRET_KEY,
});

export const signup = new Hono().post("/", async (c) => {
  const { email } = await c.req.json();
  const user = await createUser(email);

  // ONE capture starts the lifecycle: the engine routes
  // user.signed_up to every journey that triggers on it —
  // onboarding, and anything you ship next.
  await hs.events.track({
    userId: user.id,
    email,
    event: "user.signed_up",
    properties: { plan: "trial" },
  });

  return c.json({ ok: true });
});`,
  },

  /* ==== web/ — the product, consuming the client SDK ====================== */
  {
    path: "web/src/app.tsx",
    lang: "tsx",
    source: `import { HogsendProvider } from "@hogsend/react";

// One provider, one client — every hook below shares it.
// pk_ keys are browser-safe and anonymous-only by design;
// identity is a server-minted userToken, never trusted input.
export function App({ children }: { children: React.ReactNode }) {
  return (
    <HogsendProvider
      apiUrl="https://api.my-app.com"
      publishableKey={import.meta.env.VITE_HOGSEND_PK}
    >
      {children}
    </HogsendProvider>
  );
}`,
  },
  {
    path: "web/src/components/paywall.tsx",
    lang: "tsx",
    source: `import { useFlag, useHogsend } from "@hogsend/react";

// Flags live in the repo — typed, reviewed, deployed.
// A typo'd key won't compile.
export function Paywall() {
  const newCheckout = useFlag("new-checkout-flow");
  const { capture } = useHogsend();

  return (
    <button onClick={() => capture("checkout.opened")}>
      {newCheckout ? "Start free — no card needed" : "Start trial"}
    </button>
  );
}`,
  },
  {
    path: "web/src/components/lesson-player.tsx",
    lang: "tsx",
    source: `import { useHogsend } from "@hogsend/react";
import {
  createHogsendEmitter,
  createHtml5Adapter,
  createVideoTracker,
} from "@hogsend/video";

// Watch depth as first-class events: milestones fire once,
// monotonic, the same shape into Hogsend and PostHog — so a
// journey can wait for video.milestone_reached.
export function LessonPlayer({ src }: { src: string }) {
  const { capture } = useHogsend();
  const tracker = createVideoTracker({
    emitter: createHogsendEmitter({ capture }),
    milestones: [10, 50, 95],
  });

  return (
    <video
      controls
      src={src}
      ref={(el) =>
        el && tracker.attach(createHtml5Adapter(el, { title: "Lesson 1" }))
      }
    />
  );
}`,
  },
];
