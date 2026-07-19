/* ==========================================================================
 *  What each CLI run writes, keyed by the exact path the terminal
 *  prints. The run emits lines like `+ src/emails/payment-failed.tsx`; the
 *  hero mints a window for that path at the moment the line lands, so this
 *  map has to agree with `PROMPT_SCENARIOS[].output` verbatim.
 *
 *  Journey files carry real engine API (defineJourney + ctx primitives).
 *  Email files carry an illustrative preview of the template — these are
 *  demo journeys, so the copy is representative, not shipped content.
 * ========================================================================== */

export type EmailPreview = {
  subject: string;
  preheader: string;
  heading: string;
  body: string[];
  cta?: { label: string; note?: string };
  footer?: string;
};

/** A non-file artefact a run produces — a Discord DM, a Slack approval, an
 *  in-app notification. These are not written to disk, so they are minted when
 *  the run finishes rather than on a `+ path` line. */
export type SurfacePreview = {
  kind: "discord" | "slack" | "telegram" | "bell";
  from: string;
  meta: string;
  body: string;
  actions?: string[];
  /** the line of journey code that produces it */
  trigger: string;
};

export type MintedFile =
  | { path: string; kind: "code"; source: string }
  | { path: string; kind: "email"; email: EmailPreview }
  | { path: string; kind: "surface"; surface: SurfacePreview };

export const MINTED_FILES: Record<string, MintedFile> = {
  /* ---- winback ---------------------------------------------------------- */
  "src/journeys/winback.ts": {
    path: "src/journeys/winback.ts",
    kind: "code",
    source: `export const winback = defineJourney({
  meta: {
    id: "winback",
    trigger: { event: Buckets.WentDormant },
    exitOn: [{ event: Events.ContactActive }],
  },
  async run(user, ctx) {
    await sendEmail({ to: user.email, template: Templates.WinbackCheckIn });

    await ctx.sleep({ duration: days(7), label: "cool-off" });

    await sendEmail({ to: user.email, template: Templates.WinbackOffer });
  },
});`,
  },
  "src/emails/winback-offer.tsx": {
    path: "src/emails/winback-offer.tsx",
    kind: "email",
    email: {
      subject: "Still thinking it over?",
      preheader: "20% off your next three months — expires Friday.",
      heading: "We kept your workspace warm",
      body: [
        "Everything you set up is still exactly where you left it — journeys, templates, contacts.",
        "If budget was the sticking point, here's 20% off your next three months.",
      ],
      cta: { label: "Reactivate my workspace", note: "Offer expires Friday" },
      footer: "You're getting this because you had an account with us.",
    },
  },

  /* ---- lifecycle-leak --------------------------------------------------- */
  "src/journeys/retention.ts": {
    path: "src/journeys/retention.ts",
    kind: "code",
    source: `export const retention = defineJourney({
  meta: {
    id: "retention",
    trigger: { event: Events.Activated },
    exitOn: [{ event: Events.ProjectCreated }],
  },
  async run(user, ctx) {
    await ctx.sleep({ duration: days(10), label: "pre-dormant" });

    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({ to: user.email, template: Templates.WeekTwoCheckIn });
  },
});`,
  },
  "src/emails/week-two-checkin.tsx": {
    path: "src/emails/week-two-checkin.tsx",
    kind: "email",
    email: {
      subject: "Two weeks in — how's it going?",
      preheader: "Most teams ship their first journey by now.",
      heading: "Stuck on the first journey?",
      body: [
        "You signed up two weeks ago and haven't shipped a journey yet. That's usually one of two things: the trigger event isn't firing, or the template registry isn't wired.",
        "Both take about ten minutes to fix.",
      ],
      cta: { label: "Open the quickstart" },
      footer: "Reply to this email and a human will answer.",
    },
  },

  /* ---- prerelease-discord ----------------------------------------------- */
  "src/journeys/prerelease-discord.ts": {
    path: "src/journeys/prerelease-discord.ts",
    kind: "code",
    source: `export const prereleaseDiscord = defineJourney({
  meta: {
    id: "prerelease-discord",
    trigger: {
      event: Events.DiscordRoleGranted,
      where: (b) => b.prop("role").eq("pre-release"),
    },
  },
  async run(user, ctx) {
    const code = await ctx.once("code", () => mintStripeCode(user.id));

    await sendConnectorAction({
      connector: "discord",
      action: "dm",
      to: user.discordId,
      body: \`Your pre-release code: \${code}\`,
    });

    const used = await ctx.waitForEvent({
      event: Events.CodeRedeemed,
      timeout: days(2),
    });

    if (used.timedOut) {
      await sendEmail({ to: user.email, template: Templates.CodeReminder });
    }
  },
});`,
  },
  "src/emails/code-reminder.tsx": {
    path: "src/emails/code-reminder.tsx",
    kind: "email",
    email: {
      subject: "Your pre-release code expires tomorrow",
      preheader: "One click to redeem it.",
      heading: "Don't leave this on the table",
      body: [
        "You picked up the pre-release role on Discord two days ago and the code that came with it is still unredeemed.",
        "It expires tomorrow at midnight UTC.",
      ],
      cta: { label: "Redeem my code", note: "Applies at checkout" },
      footer: "Sent because you hold the pre-release role.",
    },
  },

  /* ---- payment-recovery -------------------------------------------------- */
  "src/journeys/payment-recovery.ts": {
    path: "src/journeys/payment-recovery.ts",
    kind: "code",
    source: `export const paymentRecovery = defineJourney({
  meta: {
    id: "payment-recovery",
    trigger: { event: Events.ChargeFailed },
    exitOn: [{ event: Events.InvoicePaid }],
  },
  async run(user, ctx) {
    await ctx.trigger({ event: Events.ShowBillingWarning, userId: user.id });

    await ctx.sleep({ duration: hours(6), label: "grace" });

    await sendEmail({ to: user.email, template: Templates.PaymentFailed });
  },
});`,
  },
  "src/emails/payment-failed.tsx": {
    path: "src/emails/payment-failed.tsx",
    kind: "email",
    email: {
      subject: "Your payment didn't go through",
      preheader: "Nothing is switched off yet — you have seven days.",
      heading: "We couldn't charge your card",
      body: [
        "The charge for your monthly plan was declined. Your workspace is still running and nothing has been switched off.",
        "We'll retry automatically in seven days, or you can update the card now.",
      ],
      cta: { label: "Update payment method" },
      footer: "Questions about billing? Just reply.",
    },
  },

  /* ---- proposal-approval ------------------------------------------------- */
  "src/journeys/proposal-approval.ts": {
    path: "src/journeys/proposal-approval.ts",
    kind: "code",
    source: `export const proposalApproval = defineJourney({
  meta: {
    id: "proposal-approval",
    trigger: { event: Events.LeadQualified },
  },
  async run(user, ctx) {
    await sendConnectorAction({
      connector: "slack",
      action: "message",
      to: Channels.Approvals,
      body: \`Proposal ready for \${user.email}\`,
    });

    const gate = await ctx.waitForEvent({
      event: Events.ProposalApproved,
      timeout: days(3),
    });

    if (gate.timedOut) return;

    await sendConnectorAction({
      connector: "telegram",
      action: "dm",
      to: user.telegramId,
      body: "Approved — grab a slot: cal.com/hogsend/intro",
    });
  },
});`,
  },

  /* ---- onboarding -------------------------------------------------------- */
  "src/journeys/onboarding.ts": {
    path: "src/journeys/onboarding.ts",
    kind: "code",
    source: `export const onboarding = defineJourney({
  meta: {
    id: "onboarding",
    trigger: { event: Events.UserSignedUp },
    entryLimit: { type: "once" },
  },
  async run(user, ctx) {
    await sendEmail({ to: user.email, template: Templates.Welcome });

    const created = await ctx.waitForEvent({
      event: Events.ProjectCreated,
      timeout: days(3),
    });

    if (!created.timedOut) return;

    await sendEmail({ to: user.email, template: Templates.Nudge });

    await sendConnectorAction({
      connector: "slack",
      action: "message",
      to: Channels.Sales,
      body: \`No project by day 3: \${user.email}\`,
    });
  },
});`,
  },
  "src/emails/welcome.tsx": {
    path: "src/emails/welcome.tsx",
    kind: "email",
    email: {
      subject: "Welcome — here's the ten-minute version",
      preheader: "Install, wire one event, ship one journey.",
      heading: "Let's get one journey live",
      body: [
        "Three steps and you'll have a real journey running against real events: install the engine, point one event at it, and ship a journey file.",
        "Everything after that is just more of the same.",
      ],
      cta: { label: "Start the quickstart", note: "About ten minutes" },
      footer: "You're getting this because you just signed up.",
    },
  },

  /* ---- voice-lead-qualification ------------------------------------------ */
  "src/journeys/voice-lead-qualification.ts": {
    path: "src/journeys/voice-lead-qualification.ts",
    kind: "code",
    source: `export const voiceLeadQualification = defineJourney({
  meta: {
    id: "voice-lead-qualification",
    trigger: { event: Events.CallbackRequested },
  },
  async run(user, ctx) {
    await placeVoiceCall({ to: user.phone, agent: "deepgram/intake" });

    const call = await ctx.waitForEvent({
      event: Events.CallCompleted,
      timeout: hours(24),
    });

    if (call.timedOut) return;

    await sendEmail({
      to: user.email,
      template: Templates.CallSummary,
      props: { summary: call.properties?.summary },
    });

    await pushToHubspot({ email: user.email, stage: "qualified" });
  },
});`,
  },
};

/* ==========================================================================
 *  Channel surfaces, keyed by scenario id. A journey that DMs on Discord or
 *  gates on a Slack approval does something no code window can show — these
 *  mint when the run reports "journey registered".
 * ========================================================================== */

export const SCENARIO_SURFACES: Record<string, string[]> = {
  "prerelease-discord": ["discord/pre-release-dm"],
  "payment-recovery": ["in-app/billing-warning"],
  "proposal-approval": ["slack/proposal-approval"],
  onboarding: ["slack/sales-ping"],
};

export const SURFACES: Record<string, MintedFile> = {
  "discord/pre-release-dm": {
    path: "discord/pre-release-dm",
    kind: "surface",
    surface: {
      kind: "discord",
      from: "Hogsend",
      meta: "BOT · just now",
      body: "You're in the pre-release. Here's your code — it takes 20% off at checkout:\n\n  PRERELEASE-8F2A-C91D\n\nExpires in 48 hours.",
      actions: ["Redeem now", "Dismiss"],
      trigger: 'sendConnectorAction({ connector: "discord", action: "dm" })',
    },
  },
  "in-app/billing-warning": {
    path: "in-app/billing-warning",
    kind: "surface",
    surface: {
      kind: "bell",
      from: "Billing",
      meta: "now",
      body: "We couldn't charge your card. Nothing has been switched off — update your payment method within 7 days to keep things running.",
      actions: ["Update card"],
      trigger: "ctx.trigger({ event: Events.ShowBillingWarning })",
    },
  },
  "slack/proposal-approval": {
    path: "slack/proposal-approval",
    kind: "surface",
    surface: {
      kind: "slack",
      from: "Hogsend",
      meta: "APP · #approvals",
      body: "Proposal ready for review — dana@northwind.co\nQualified 12 minutes ago · £4,800 / year",
      actions: ["Approve", "Request changes"],
      trigger: "ctx.waitForEvent({ event: Events.ProposalApproved })",
    },
  },
  "slack/sales-ping": {
    path: "slack/sales-ping",
    kind: "surface",
    surface: {
      kind: "slack",
      from: "Hogsend",
      meta: "APP · #sales",
      body: "No project created by day 3 — sam@arcadia.io\nSigned up Monday, opened the welcome email twice, never reached the editor.",
      actions: ["Claim", "Snooze"],
      trigger:
        'sendConnectorAction({ connector: "slack", to: Channels.Sales })',
    },
  },
};

/** Source text for a path, for the Copy button. */
export function fileFor(path: string): MintedFile | undefined {
  return MINTED_FILES[path] ?? SURFACES[path];
}

export function sourceFor(path: string): string {
  const file = fileFor(path);
  if (!file) return "";
  return file.kind === "code" ? file.source : "";
}
