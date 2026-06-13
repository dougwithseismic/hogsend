import type { RecipeLander } from "./types";

const SURFACES_CODE = `// src/lists/index.ts — membership is code-defined
export const waitlist = defineList({
  id: "waitlist",
  name: "Waitlist",
  defaultOptIn: false, // opt-in: only an explicit join counts
});

// your form handler — contact + membership + confirmation
await hs.contacts.upsert({
  email: form.email,
  properties: { company: form.company, source: form.source },
  lists: { waitlist: true },
});
await hs.emails.send({
  to: form.email,
  template: "waitlist/confirmation",
  props: { position: queuePosition },
});

// launch day — one idempotent broadcast to every subscribed member
const { campaignId } = await hs.campaigns.send({
  list: "waitlist",
  template: "waitlist/launch",
  props: { inviteUrl: "https://app.example.com/claim" },
  subject: "You're in — claim your account",
  idempotencyKey: "waitlist-launch-v1",
});

// as you grant access, one event per member starts the chase journey
await hs.events.send({
  name: "launch.access_granted",
  email: member.email,
  userId: member.userId,
  eventProperties: { invite_url: member.inviteUrl },
  idempotencyKey: \`access-granted-\${member.userId}\`,
});`;

const JOURNEY_CODE = `export const launchChase = defineJourney({
  meta: {
    id: "launch-chase",
    name: "Waitlist — launch chase",
    enabled: true,
    trigger: { event: Events.LAUNCH_ACCESS_GRANTED },
    entryLimit: "once",
    suppress: hours(24),
    exitOn: [{ event: Events.USER_SIGNED_UP }],
  },

  run: async (user, ctx) => {
    const inviteUrl = String(user.properties.invite_url ?? "");

    // Two days to redeem the invite on their own.
    const first = await ctx.waitForEvent({
      event: Events.USER_SIGNED_UP,
      timeout: days(2),
    });
    if (!first.timedOut) return; // they're in — nothing to chase

    if (!(await ctx.guard.isSubscribed())) return;
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.WAITLIST_INVITE_REMINDER,
      subject: "Your invite is waiting",
      journeyName: user.journeyName,
      props: { inviteUrl },
    });

    // Four more days, then one last call.
    const second = await ctx.waitForEvent({
      event: Events.USER_SIGNED_UP,
      timeout: days(4),
    });
    if (!second.timedOut) return;

    if (!(await ctx.guard.isSubscribed())) return;
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.WAITLIST_LAST_CALL,
      subject: "Last call — your invite expires this week",
      journeyName: user.journeyName,
      props: { inviteUrl },
    });
  },
});`;

export const waitlistLaunch: RecipeLander = {
  slug: "waitlist-launch",
  category: "onboarding",
  title: "Waitlist to launch",
  metaDescription:
    "A waitlist end to end in TypeScript: defineList membership, an upsert with a lists bag plus confirmation send, an idempotent campaign broadcast on launch day, and a journey that chases everyone who got access but never signed up.",
  cardDescription:
    "Code-defined membership, an idempotent launch broadcast, and a chase journey for non-activators.",
  eyebrow: "Recipe — Onboarding & activation",
  subhead:
    "List, campaign, and journey share one contact record and one event stream — the opt-outs the launch broadcast respects are the same opt-outs the chase journey respects.",
  problem: {
    label: "The launch-day problem",
    statement:
      "The usual waitlist is a spreadsheet or a form-tool export, broadcast through a separate email product on launch day. The export drifts from opt-outs collected after it was taken, a send script that crashes halfway re-runs from the top and double-emails the first half, and 'who got access but never signed up' becomes a manual join between three systems.",
  },
  walkthrough: {
    eyebrow: "The flow",
    title: "Three surfaces, one identity",
    subtitle:
      "Membership is a defineList, the announcement is a campaign with an idempotencyKey, and the follow-through is a journey on launch.access_granted that exits on user.signed_up.",
    note: "The campaign row is committed before the worker broadcasts, so a crash after the call can't lose the launch — and a retried run with the same idempotencyKey resolves to the existing campaign instead of sending twice.",
  },
  code: [
    {
      filename: "list, form handler, launch script",
      code: SURFACES_CODE,
      caption:
        "Join, confirm, broadcast, grant — four calls against one contact record. The events carry the userId the chase journey will wait on.",
    },
    {
      filename: "src/journeys/launch-chase.ts",
      code: JOURNEY_CODE,
      caption:
        "waitForEvent is the branch (did they sign up yet?); exitOn is the guarantee (a signup at any point ends the run before the next reminder).",
    },
  ],
  points: [
    {
      title: "Launch day is safe to retry",
      body: "campaigns.send commits the campaign row before enqueueing the broadcast, and an idempotencyKey makes a retried call resolve to the existing campaign — a network blip on the biggest send of the quarter cannot double-email the list.",
    },
    {
      title: "Recipients and the preference center can't disagree",
      body: 'With defaultOptIn: false, a recipient is a contact with an exact categories["waitlist"] === true. The broadcast\'s recipient resolution and the preference center read the same rule, and late opt-outs land in skippedCount, not the inbox.',
    },
    {
      title: "The chase stops the instant they sign up",
      body: "user.signed_up is in exitOn, so a signup mid-wait marks the run exited and cancels the durable Hatchet run — nobody who claimed their account receives an invite reminder.",
    },
    {
      title: "One chase per member, however access is granted",
      body: 'entryLimit: "once" plus the idempotencyKey on launch.access_granted means a retried grant batch can\'t enroll anyone twice, and suppress: hours(24) floors the send rate inside a run.',
    },
  ],
  faq: [
    {
      q: "What happens if the launch script crashes halfway?",
      a: "Nothing is lost and nothing doubles. The campaign row is committed before the worker starts sending, and re-running the script with the same idempotencyKey resolves to the existing campaign. Poll hs.campaigns.get(campaignId) for sentCount and skippedCount.",
    },
    {
      q: "Who actually receives the launch broadcast?",
      a: 'Every contact with categories["waitlist"] === true at send time — the list is opt-in (defaultOptIn: false), so only explicit joins count, and anyone who unsubscribed after joining is skipped and counted in skippedCount.',
    },
    {
      q: "How does the chase journey know they signed up?",
      a: "It waits on user.signed_up scoped to the enrolled user, so the signup event must carry the same userId as launch.access_granted. Mint the id when you grant access and carry it through the claim URL.",
    },
    {
      q: "Can people join the waitlist after launch?",
      a: "Yes — the list persists, and granting access later fires the same launch.access_granted event, which enrolls them in the same chase journey. The launch campaign itself is one broadcast; later joiners get the per-member grant flow.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/waitlist-launch",
    },
    { label: "Lists guide — polarity and wiring", href: "/docs/guides/lists" },
    {
      label: "Marketing campaigns — the broadcast guarantees",
      href: "/docs/recipes/marketing-campaigns",
    },
  ],
  related: ["welcome-series", "verification-chase", "back-in-stock"],
};
