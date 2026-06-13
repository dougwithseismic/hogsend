import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const verificationChase = defineJourney({
  meta: {
    id: "verification-chase",
    name: "Onboarding — verification chase",
    enabled: true,
    trigger: { event: Events.USER_SIGNED_UP },
    entryLimit: "once",
    suppress: hours(12),
    exitOn: [
      { event: Events.EMAIL_VERIFIED },
      { event: Events.USER_DELETED },
    ],
  },

  run: async (user, ctx) => {
    const verifyUrl = String(user.properties.verify_url ?? "");
    const firstName = String(user.properties.first_name ?? "");

    // The signup handler already sent the first verify-email. The lookback
    // catches a user who verified while this run was enrolling.
    const first = await ctx.waitForEvent({
      event: Events.EMAIL_VERIFIED,
      timeout: hours(24),
      lookback: minutes(30),
    });
    if (!first.timedOut) return; // verified — done

    // Re-send 1, after a day.
    if (!(await ctx.guard.isSubscribed())) return;
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.TRANSACTIONAL_VERIFY_EMAIL,
      subject: "Reminder: verify your email address",
      journeyName: user.journeyName,
      props: { firstName, verifyUrl },
    });

    const second = await ctx.waitForEvent({
      event: Events.EMAIL_VERIFIED,
      timeout: days(2),
    });
    if (!second.timedOut) return;

    // Re-send 2 — the last one.
    if (!(await ctx.guard.isSubscribed())) return;
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.TRANSACTIONAL_VERIFY_EMAIL,
      subject: "Last reminder — your account isn't active yet",
      journeyName: user.journeyName,
      props: { firstName, verifyUrl },
    });
  },
});`;

const TRIGGER_CODE = `// your signup handler — first send is transactional
await hs.emails.send({
  to: user.email,
  template: "transactional/verify-email",
  props: {
    firstName: user.firstName,
    verifyUrl: \`https://app.example.com/verify?token=\${token}\`,
  },
});

// the same handler starts the chase
await hs.events.send({
  name: "user.signed_up",
  email: user.email,
  userId: user.id,
  eventProperties: {
    first_name: user.firstName,
    // a re-link endpoint that mints a fresh token on click
    verify_url: \`https://app.example.com/verify/resend?u=\${user.id}\`,
  },
  idempotencyKey: \`signed-up-\${user.id}\`,
});

// your verify endpoint — resolves the wait AND exits the journey
await hs.events.send({
  name: "user.email_verified",
  userId: user.id,
  idempotencyKey: \`email-verified-\${user.id}\`,
});`;

export const verificationChase: RecipeLander = {
  slug: "verification-chase",
  category: "onboarding",
  title: "Verification chase",
  metaDescription:
    "Verify-email as a transactional send plus a chase journey in TypeScript: wait 24 hours for user.email_verified, re-send at most twice, exit the instant the token is redeemed. No cron, no skipPreferenceCheck.",
  cardDescription:
    "Send the verify-email transactionally, then chase it with two re-sends that stop the instant the token is redeemed.",
  eyebrow: "Recipe — Onboarding & activation",
  subhead:
    "The first send is transactional from your signup handler; the chase is a journey that waits on user.email_verified, re-sends at most twice with escalating subjects, and exits even mid-wait when verification lands.",
  problem: {
    label: "The unverified-signup problem",
    statement:
      "The default implementation is a cron that scans for unverified accounts and re-mails them. The scan races the verification that happened a minute ago, the re-send count lives in a column someone has to remember to increment, and the re-sent link carries the original token, which has often expired by the second attempt.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "Verification is detected, not polled",
    subtitle:
      "ctx.waitForEvent resolves the moment user.email_verified is ingested or when the window closes — the timeout is the re-send signal, and exitOn guarantees no mail after redemption.",
    note: "Both re-sends reuse the canonical transactional/verify-email template with subject overrides — one template, three sends, and the whole schedule (24 hours, two days, stop) is readable in the diff.",
  },
  code: [
    {
      filename: "src/journeys/verification-chase.ts",
      code: JOURNEY_CODE,
      caption:
        "The success branch is a bare return, so waiting on the same event exitOn covers is safe: either path ends the run with zero further sends.",
    },
    {
      filename: "your signup + verify handlers",
      code: TRIGGER_CODE,
      caption:
        "Three calls wire the whole flow: the transactional first send, the signup event that enrolls the chase, and the verified event that ends it.",
    },
  ],
  points: [
    {
      title: "No cron scanning for unverified users",
      body: "The chase starts on user.signed_up and waits on user.email_verified with a timeout — the timeout is the re-send signal. The lookback window covers a user who verifies seconds after signup, before the durable wait is established.",
    },
    {
      title: "Verification ends the run mid-anything",
      body: "user.email_verified is in exitOn, so redeeming the token during a wait marks the run exited and cancels the durable Hatchet run. The race that plagues cron-based chasing — verify at 8:59, reminder at 9:00 — structurally can't happen.",
    },
    {
      title: "The chase respects preferences; the reset flow doesn't have to",
      body: "skipPreferenceCheck is for mail the user just asked for (password reset, security) and needs a full-admin key. A verification re-send is mail you want them to act on, so the enrollment guard and ctx.guard.isSubscribed() apply on every send.",
    },
    {
      title: "At most two re-sends, structurally",
      body: 'The journey is linear code with exactly two sendEmail calls and entryLimit: "once" — there is no retry counter to mis-increment and no replayed signup event that can restart the chase.',
    },
  ],
  faq: [
    {
      q: "What if the user verifies seconds after signing up?",
      a: "The first wait carries lookback: minutes(30), which checks recent user_events before the durable wait is established — an already-landed user.email_verified resolves it immediately and the run ends with zero re-sends.",
    },
    {
      q: "Why is the event called user.email_verified and not email.verified?",
      a: "The email. namespace is reserved for engine-emitted events like email.opened and email.link_clicked. App events must stay out of the reserved namespaces (email., journey., bucket., contact.).",
    },
    {
      q: "Shouldn't verification email bypass unsubscribe like a password reset?",
      a: "No — the distinction is who initiated the send. A password reset answers a request the user made seconds ago; a verification chase is outreach you initiated, so it runs under normal preference rules. The first verify-email needs no bypass either: a brand-new signup has no preference state yet.",
    },
    {
      q: "Doesn't the verify link expire before the second re-send?",
      a: "The re-sends deliberately use a verify_url pointing at a re-link endpoint that mints a fresh token on click, carried as an event property on user.signed_up — not the signup-time token, which is often dead by day three.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/verification-chase",
    },
    {
      label: "Transactional emails — skipPreferenceCheck rules",
      href: "/docs/recipes/transactional-emails",
    },
    {
      label: "Journeys guide — waitForEvent and exitOn",
      href: "/docs/guides/journeys",
    },
  ],
  related: ["welcome-series", "waitlist-launch", "activation-milestones"],
};
