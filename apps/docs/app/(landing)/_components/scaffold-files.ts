import type { EmailPreview, SurfacePreview } from "./minted-files";

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

/** The corner pane that describes a file — "say stuff about it in the
 *  bottom right". Rendered for capability files that don't ship an email or a
 *  connector surface. */
export type FileNote = { title: string; body: string; tags?: string[] };

export type ScaffoldFile = {
  path: string;
  lang: "ts" | "tsx" | "ini" | "bash" | "json";
  source: string;
  /** When present, the explorer floats the rendered email beside the code. */
  email?: EmailPreview;
  /** When true, the explorer floats the timezone schedule readout instead. */
  timing?: boolean;
  /** When present, floats what actually lands — a Discord/Telegram/Slack/bell
   *  card — the way the hero mints connector surfaces. */
  surface?: SurfacePreview;
  /** Fallback corner pane: a short "what this is" note with capability tags. */
  note?: FileNote;
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
    note: {
      title: "Send, wait, branch on what they did",
      body: "waitForEvent parks the journey durably until THIS user creates a project — or three days pass. The branch afterwards is an if statement, and the stalled path tags the growth team on Discord.",
      tags: ["Durable wait", "Event or timeout", "Branch = if"],
    },
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
    note: {
      title: "A rescue that knows when to stay quiet",
      body: "Most churn simply never comes back for a second session. The email sends only when the return visit doesn't happen — someone who comes back on their own hears nothing.",
      tags: ["Fires on absence", "entryLimit: once", "Silence = feature"],
    },
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
    note: {
      title: "Triggered by a bucket, not a campaign",
      body: "bucket.went_dormant enrolls people the moment the segment catches them, and exitOn ends the sequence the instant they turn active again — even mid-sleep, the offer never lands on someone who already came back.",
      tags: ["Bucket trigger", "exitOn", "Durable sleep"],
    },
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
    note: {
      title: "Branch on usage, not the calendar",
      body: "exitOn drops anyone who subscribes — instantly, wherever they are in the sequence. Day six checks ctx.history for a real report before choosing between the upgrade pitch and the activation nudge.",
      tags: ["exitOn converts", "History check", "Usage branch"],
    },
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
    note: {
      title: "Fed by the Stripe preset",
      body: "invoice.payment_failed arrives through src/webhook-sources/stripe.ts and enrolls this journey like any product event. exitOn cancels it the moment the invoice clears — a customer who pays never sees the final notice.",
      tags: ["Stripe webhook", "exitOn paid", "Grace window"],
    },
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
    note: {
      title: "Email everyone, DM the linked",
      body: "One trigger, two channels: the doors-open email goes to the whole list, and members with a linked Discord get the DM where they'll actually see it in time. once_per_period keeps a repeat event from double-summoning.",
      tags: ["Multi-channel", "Discord DM", "once_per_period"],
    },
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
    note: {
      title: "Lifecycle isn't only customers",
      body: "The people team runs the offer-signed → day-one stretch on the same engine. sleepUntil parks the journey at an absolute date — the day before their start — and the checklist lands exactly then, however far away that is.",
      tags: ["People ops", "sleepUntil", "Absolute date"],
    },
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
    note: {
      title: "A 60-day wait is one line",
      body: "waitForEvent holds durably for up to 60 days for role.reopened, and exitOn ends the journey the moment the candidate is hired. The follow-up only sends when there's a real role to offer.",
      tags: ["60-day wait", "exitOn hired", "Warm bench"],
    },
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

  {
    path: "hogsend/src/journeys/product/experiments.ts",
    lang: "ts",
    note: {
      title: "A/B arms inside the journey",
      body: "ctx.variant picks a deterministic arm per user — recorded on the first pass and replayed verbatim across redeploys. No RNG, no drift, no external experiment tool.",
      tags: ["Deterministic", "Replay-safe", "No RNG"],
    },
    source: `import { defineJourney, sendEmail } from "@hogsend/engine";

export const welcomeExperiment = defineJourney({
  meta: { id: "welcome-experiment", trigger: { event: "user.signed_up" } },
  run: async (user, ctx) => {
    // Deterministic per user — recorded on first pass,
    // replayed verbatim across redeploys. No RNG, no drift.
    const arm = await ctx.variant("welcome-subject", ["setup", "outcome"]);

    await sendEmail({
      to: user.email,
      template: arm === "setup" ? "welcome" : "first-win",
    });
  },
});`,
  },

  /* ---- journeys/lifecycle — the multi-channel reaches --------------------- */
  {
    path: "hogsend/src/journeys/lifecycle/discord-welcome.ts",
    lang: "ts",
    surface: {
      kind: "discord",
      from: "my-app",
      meta: "just now",
      body: "Your seat is ready — see you in #welcome 👋 Reply here any time; a human reads these.",
      trigger: 'sendConnectorAction({ connectorId: "discord" })',
    },
    note: {
      title: "Reach them where they hang out",
      body: "DM on Discord, gated on the member's channel preference. A closed DM is a soft failure (delivered: false), never a crash.",
      tags: ["Discord DM", "Preference-gated", "Soft-fail"],
    },
    source: `import { defineJourney, sendConnectorAction } from "@hogsend/engine";

export const discordWelcome = defineJourney({
  meta: { id: "discord-welcome", trigger: { event: "discord.member_joined" } },
  run: async (user) => {
    // DM them where they actually are — gated on the member's
    // channel preference. A closed DM is a soft failure
    // (delivered: false), never a crash.
    await sendConnectorAction({
      connectorId: "discord",
      action: "dmMember",
      args: {
        member: user.email,
        content: "Your seat is ready — see you in #welcome.",
      },
    });
  },
});`,
  },
  {
    path: "hogsend/src/journeys/lifecycle/telegram-nudge.ts",
    lang: "ts",
    surface: {
      kind: "telegram",
      from: "my-app bot",
      meta: "just now",
      body: "Left something in your cart? It's still yours — tap to pick up where you left off.",
      trigger: 'sendConnectorAction({ connectorId: "telegram" })',
    },
    note: {
      title: "Same helper, Telegram",
      body: "The connector contract is channel-neutral — swap discord for telegram and the journey code is otherwise identical. Both replay-safe under the same key kind.",
      tags: ["Telegram DM", "Channel-neutral", "One contract"],
    },
    source: `import { hours } from "@hogsend/core";
import { defineJourney, sendConnectorAction } from "@hogsend/engine";

export const telegramNudge = defineJourney({
  meta: { id: "telegram-nudge", trigger: { event: "cart.abandoned" } },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: hours(3), label: "cool-off" });

    // Same call shape as Discord — only the connectorId changes.
    await sendConnectorAction({
      connectorId: "telegram",
      action: "dmMember",
      args: {
        member: String(user.properties.telegramChatId),
        content: "Left something in your cart? Tap to pick up where you left off.",
      },
    });
  },
});`,
  },
  {
    path: "hogsend/src/journeys/lifecycle/cart-reminder.ts",
    lang: "ts",
    note: {
      title: "Texts with the same guardrails",
      body: "SMS is additive — no number, no send. Marketing texts fail closed without explicit consent, and the STOP list is checked on every send.",
      tags: ["TCPA consent", "STOP list", "E.164 only"],
    },
    source: `import { defineJourney, sendSms } from "@hogsend/engine";
import { isE164 } from "@hogsend/core";

export const cartReminder = defineJourney({
  meta: { id: "cart-reminder", trigger: { event: "cart.abandoned" } },
  run: async (user) => {
    const phone = String(user.properties.phone ?? "");
    // SMS is additive — no number, no send.
    if (!isE164(phone)) return;

    // Marketing SMS fails closed without explicit consent;
    // the STOP list is checked on every send.
    await sendSms({ to: phone, userId: user.id, template: "cart-reminder" });
  },
});`,
  },
  {
    path: "hogsend/src/journeys/lifecycle/approval-gate.ts",
    lang: "ts",
    surface: {
      kind: "slack",
      from: "Hogsend",
      meta: "#approvals",
      body: "Enterprise trial started: acme.com (42 seats). Approve the white-glove onboarding sequence?",
      actions: ["Approve", "Skip"],
      trigger: "ctx.waitForEvent({ event: 'approval.decided' })",
    },
    note: {
      title: "A human in the loop",
      body: "Post to Slack, then durably wait for the click. The journey parks for as long as it takes — the approval is just another event it waits on.",
      tags: ["Slack approval", "Durable wait", "Human gate"],
    },
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendConnectorAction, sendEmail } from "@hogsend/engine";

export const approvalGate = defineJourney({
  meta: { id: "approval-gate", trigger: { event: "trial.enterprise" } },
  run: async (user, ctx) => {
    await sendConnectorAction({
      connectorId: "slack",
      action: "sendChannelMessage",
      args: { channel: "#approvals", content: \`Approve white-glove for \${user.email}?\` },
    });

    // Park durably until a human clicks Approve — or a day passes.
    const { timedOut } = await ctx.waitForEvent({
      event: "approval.decided",
      timeout: days(1),
    });

    if (!timedOut) await sendEmail({ to: user.email, template: "welcome" });
  },
});`,
  },

  /* ---- buckets, flags, destinations — the standing definitions ------------ */
  {
    path: "hogsend/src/buckets/went-dormant.ts",
    lang: "ts",
    note: {
      title: "Live groups of people",
      body: "A bucket is a saved, always-current segment. Entering or leaving it is an event — so a bucket can trigger a journey the moment someone goes quiet.",
      tags: ["Time-based", "Entry = trigger", "Composable criteria"],
    },
    source: `import { days, defineBucket } from "@hogsend/engine";

export const wentDormant = defineBucket({
  meta: {
    id: "went-dormant",
    enabled: true,
    timeBased: true,
    criteria: (b) =>
      b.all(
        b.event("app.active").exists(),
        b.event("app.active").within(days(7)).notExists(),
      ),
  },
});`,
  },
  {
    path: "hogsend/src/flags.ts",
    lang: "ts",
    note: {
      title: "Flags defined next to the journeys",
      body: "Feature flags live in your repo — typed, reviewed, deployed. The React hook is the same shape as PostHog's, so a typo'd key won't compile.",
      tags: ["Typed keys", "In-repo", "useFlag()"],
    },
    source: `import { defineFlag } from "@hogsend/engine";

// Flags live in your repo — typed, reviewed, deployed.
export const newCheckout = defineFlag({
  key: "new-checkout-flow",
  name: "New checkout flow",
  type: "boolean",
});`,
  },
  {
    path: "hogsend/src/destinations/crm.ts",
    lang: "ts",
    note: {
      title: "Fan events out, durably",
      body: "Every email + lifecycle event can fan out to PostHog, Segment, Slack, or any signed webhook — or your own destination defined in code.",
      tags: ["Signed webhooks", "Durable delivery", "BYO destination"],
    },
    source: `import { defineDestination } from "@hogsend/engine";

// Fan lifecycle events out to your CRM — or PostHog,
// Segment, Slack, any signed webhook.
export const crm = defineDestination({
  meta: { id: "crm", name: "CRM" },
  events: ["contact.created", "contact.updated"],
  transform: (envelope, { endpoint }) => ({
    url: endpoint.url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  }),
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
    note: {
      title: "A preset webhook source",
      body: "The built-in Stripe preset is signature-verified with node:crypto and normalizes events (invoice.payment_failed, subscription.updated) so any of them can trigger a journey.",
      tags: ["Signed", "Normalized events", "One line"],
    },
    source: `import { stripeSource } from "@hogsend/engine";

// The built-in Stripe preset: signature-verified with node:crypto,
// events normalized (invoice.payment_failed, subscription.updated, …)
// so any of them can trigger a journey. Set STRIPE_WEBHOOK_SECRET
// and point Stripe at POST /v1/webhooks/stripe — that's the setup.
export const stripe = stripeSource;`,
  },
  {
    path: "hogsend/src/webhook-sources/billing.ts",
    lang: "ts",
    note: {
      title: "Any webhook becomes a trigger",
      body: "No preset? Define one: declare the auth, validate with a Zod schema, and transform the payload into an event. The result feeds the same pipeline as everything else.",
      tags: ["BYO source", "Zod-validated", "→ any journey"],
    },
    source: `import { defineWebhookSource } from "@hogsend/engine";
import { z } from "zod";

export const billing = defineWebhookSource({
  meta: { id: "billing", name: "Billing" },
  auth: {
    type: "match",
    header: "x-webhook-secret",
    envKey: "BILLING_WEBHOOK_SECRET",
  },
  schema: z.object({
    type: z.string(),
    customer: z.object({ id: z.string(), email: z.string() }),
  }),
  async transform(payload) {
    return {
      userId: payload.customer.id,
      email: payload.customer.email,
      event: payload.type,
    };
  },
});`,
  },

  /* ---- scripts ------------------------------------------------------------ */
  {
    path: "hogsend/scripts/event-qr.sh",
    lang: "bash",
    note: {
      title: "Tracked links that survive the print run",
      body: "The QR encodes the durable link id, never the destination — so 5,000 printed postcards can be re-pointed with one PATCH after they ship.",
      tags: ["Vanity slug", "SVG + PNG QR", "Re-point later"],
    },
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
    note: {
      title: "One durable worker runs it all",
      body: "Every journey is a Hatchet durable task. A seven-day sleep survives deploys, restarts, and crashes — the worker picks up exactly where it left off.",
      tags: ["Hatchet", "Durable", "Survives deploys"],
    },
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
    note: {
      title: "Provider is config, not journey code",
      body: "Swap Resend for Postmark by changing EMAIL_PROVIDER — no journey rewrite. Webhook sources and connectors switch on when their secrets are set, and PostHog is optional and additive.",
      tags: ["One-var swap", "Auto-enable", "PostHog optional"],
    },
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
    note: {
      title: "Backend Node, on the server SDK",
      body: "The secret-key client talks to the engine's data API from any Node backend — one events.track() starts the whole lifecycle, routing to every journey that triggers on it.",
      tags: ["@hogsend/client", "Hono / any Node", "One call → journeys"],
    },
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

  {
    path: "api/src/routes/groups.ts",
    lang: "ts",
    note: {
      title: "Accounts, teams, companies",
      body: "First-class group analytics — write account properties from the server, associate a browser visitor's events from the client. Works with zero analytics provider; an automatic win when PostHog is on.",
      tags: ["Account-level", "Secret-key writes", "PostHog-parity"],
    },
    source: `import { Hogsend } from "@hogsend/client";

const hs = new Hogsend({ apiKey: process.env.HOGSEND_SECRET_KEY });

// Server — write the account and its properties.
export async function upsertAccount(domain: string) {
  await hs.groups.identify({
    groupType: "company",
    groupKey: domain,
    properties: { plan: "pro", seats: 42 },
  });
}
// Browser side just associates: hogsend.group("company", domain).`,
  },
  {
    path: "api/src/campaigns/march-launch.ts",
    lang: "ts",
    note: {
      title: "One-off sends to a list or bucket",
      body: "Broadcasts are the imperative side of the same engine — send to a list or a live bucket, template typed against your registry, scheduled or immediate.",
      tags: ["Lists + buckets", "Typed template", "Scheduled"],
    },
    source: `import { Hogsend } from "@hogsend/client";

const hs = new Hogsend({ apiKey: process.env.HOGSEND_SECRET_KEY });

export async function sendLaunch() {
  const { campaignId, status } = await hs.campaigns.send({
    name: "March launch",
    list: "product-updates", // or a live bucket
    template: "launch-announcement", // typed against your registry
    props: { feature: "Flags" },
    sendAt: "2026-08-01T09:00:00Z", // omit to send now
  });
  return { campaignId, status };
}`,
  },
  {
    path: ".mcp.json",
    lang: "json",
    note: {
      title: "Your agent operates the engine",
      body: "Hogsend ships an MCP server — point Claude or Cursor at it and an agent can read journeys, draft sends, and manage flags through the same typed API you use.",
      tags: ["MCP server", "Agent-native", "Same typed API"],
    },
    source: `{
  "mcpServers": {
    "hogsend": {
      "command": "npx",
      "args": ["-y", "@hogsend/mcp"],
      "env": {
        "HOGSEND_API_URL": "https://api.my-app.com",
        "HOGSEND_ADMIN_KEY": "hsk_..."
      }
    }
  }
}`,
  },

  /* ==== web/ — the product, consuming the client SDK ====================== */
  {
    path: "web/src/app.tsx",
    lang: "tsx",
    note: {
      title: "Anonymous by default, upgrade to identified",
      body: "One provider, one client for the whole tree. pk_ keys are browser-safe and anonymous-only by design — identity is a server-minted userToken, never trusted input.",
      tags: ["One client", "pk_ anon-only", "Server-minted identity"],
    },
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
    note: {
      title: "The same flags, in the browser",
      body: "useFlag reads the flag you defined in hogsend/src/flags.ts — same typed key, same shape as PostHog's hook. capture() sends a first-party event that any journey can trigger on.",
      tags: ["useFlag()", "Typed key", "capture()"],
    },
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
    note: {
      title: "Watch depth as first-class events",
      body: "Milestones fire once, monotonic, the same event shape into Hogsend and PostHog — so a journey can wait for video.milestone_reached like any other event.",
      tags: ["Watch depth", "Fire-once", "→ journey trigger"],
    },
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
