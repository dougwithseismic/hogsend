import type { Metadata } from "next";
import type { JSX } from "react";
import {
  ClosingCta,
  CodeWalkthrough,
  type FaqItem,
  JourneyRun,
  MoreUseCases,
  PointsGrid,
  ProblemStatement,
  UseCaseFaq,
  UseCaseHero,
} from "../_components/use-case-sections";

export const metadata: Metadata = {
  title: "Community lifecycle with Discord and PostHog",
  description:
    "Treat a Discord server as an event source: link identity to a contact, read a derived last_seen, re-engage quiet members, and classify threads with an agent — all as journeys in your repo.",
};

const READ_CODE = `// contacts.properties.discord.last_seen is a plain ISO string, derived
// first-party from observed events — never read back from Discord.
const meta = (contact.properties?.discord ?? {}) as { last_seen?: string };
const lastSeen = meta.last_seen ? new Date(meta.last_seen) : null;
const quietDays = lastSeen
  ? (Date.now() - lastSeen.getTime()) / 86_400_000
  : Infinity;`;

const JOURNEY_CODE = `import { contacts } from "@hogsend/db";
import { days, defineJourney, getDb, hours, sendEmail } from "@hogsend/engine";
import { eq } from "drizzle-orm";
import { Events, Templates } from "./constants/index.js";

export const reEngageQuietDiscordMembers = defineJourney({
  meta: {
    id: "re-engage-quiet-discord-members",
    name: "Retention — re-engage quiet Discord members",
    enabled: true,
    // Re-evaluate on each presence ping; the entry guard rate-limits re-entry.
    trigger: { event: Events.DISCORD_PRESENCE_ACTIVE }, // "discord.presence_active"
    entryLimit: "once_per_period",
    entryPeriod: days(30),
    suppress: hours(12),
  },

  run: async (user, ctx) => {
    const db = getDb();
    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.id, user.id),
    });

    // No linked email → nothing to send. last_seen is the DERIVED first-party
    // signal (max of observed Discord events), not Discord presence.
    if (!contact?.email) return;

    const meta = (contact.properties?.discord ?? {}) as {
      last_seen?: string;
      username?: string;
    };
    const lastSeen = meta.last_seen ? new Date(meta.last_seen) : null;
    if (!lastSeen) return;

    const quietDays = (Date.now() - lastSeen.getTime()) / 86_400_000;
    if (quietDays < 30) return; // still active enough — no win-back

    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: contact.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.DISCORD_WINBACK, // "discord/winback"
      subject: \`We've missed you in the server, \${meta.username ?? "friend"}\`,
      journeyName: user.journeyName,
    });
  },
});`;

const FAQ_ITEMS: FaqItem[] = [
  {
    q: "How does a Discord member become an emailable contact?",
    a: "A member runs the /link slash command once and confirms. From then on their Discord events and product events resolve to the same contact, stitched through PostHog identity. Until they link, a Discord-only member has no address to send to.",
  },
  {
    q: "Can a journey read what a member actually wrote?",
    a: "Yes. A journey is plain TypeScript, so you can call an LLM inside run and branch on the result — or park on a durable wait and let an out-of-band agent post its verdict back as a single event. Both run as code in your repo.",
  },
  {
    q: "Won't presence pings fire this constantly?",
    a: 'They arrive constantly, but entryLimit: "once_per_period" with entryPeriod: days(30) caps re-entry to once per 30 days, so the firehose is absorbed before any journey state is created. The decision is the last_seen math, not the ping.',
  },
];

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

export default function CommunityUseCasePage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // Static literal defined above — no user input flows in.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
      />

      <UseCaseHero
        eyebrow="Use case: community"
        title="Community lifecycle that reacts to Discord activity"
        subhead="With the Discord plugin wired in, messages, reactions, joins, and presence arrive as events on the same pipeline as PostHog. Once a member links their email, those signals sit on their contact — so a journey reads a quiet stretch or a help thread the way it reads a signup."
      />

      <ProblemStatement label="The disconnect">
        Your community runs in Discord and your product data sits in PostHog,
        and the email tool is wired to neither. Put the Discord identity on the
        same contact as the product events, and a help thread or a two-week
        silence becomes an ordinary event a journey can act on.
      </ProblemStatement>

      <CodeWalkthrough
        eyebrow="The journey"
        title="Working out who's gone quiet"
        subtitle="Discord exposes presence but no last-seen timestamp, and presence is noisy — a member can show online for days without posting. The connector derives last_seen from every inbound event, so a journey computes real inactivity off the contact and emails only members who are linked, subscribed, and genuinely quiet."
        blocks={[
          {
            filename: "reading the derived signal",
            code: READ_CODE,
            caption:
              "last_seen is a plain ISO string, derived first-party from observed events — never read back from Discord. A real message advances it; a background-tab presence dot does not.",
          },
          {
            filename: "src/journeys/re-engage-quiet-discord-members.ts",
            code: JOURNEY_CODE,
            caption:
              "Three gates between trigger and send — a linked email, a last_seen older than 30 days, and a still-subscribed contact — so it never fires for the unlinked, the active, or the unsubscribed.",
          },
        ]}
      />

      <JourneyRun
        title="The same model, executing"
        subtitle="A member joins, their Discord identity becomes one PostHog person, activity keeps last_seen fresh, and a quiet stretch triggers the re-engagement."
        clip="discord-presence"
      />

      <PointsGrid
        eyebrow="In production"
        title="Why it holds up"
        points={[
          {
            title: "One contact, three identities",
            body: "A member's anonymous web session, product account, and Discord handle stitch onto a single PostHog profile, so a community signal arrives with their product history attached.",
          },
          {
            title: <code>last_seen</code>,
            body: "Discord has no last-seen field. The connector stamps contacts.properties.discord.last_seen from every inbound event, so the journey reads a real activity signal, not a presence flag.",
          },
          {
            title: "Reading the thread",
            body: (
              <>
                A journey is an async TypeScript function, so you can call an
                LLM inside <code>run</code> to classify a support thread — bug,
                feature request, or confusion — and branch on the answer.
              </>
            ),
          },
          {
            title: "Bounded re-entry",
            body: (
              <>
                <code>entryLimit: "once_per_period"</code> with{" "}
                <code>entryPeriod: days(30)</code> caps re-entry to once a
                month, and <code>ctx.guard.isSubscribed()</code> gates every
                send, so a noisy trigger never becomes a noisy inbox.
              </>
            ),
          },
        ]}
      />

      <UseCaseFaq
        items={FAQ_ITEMS}
        links={[
          {
            label: "Recipe: re-engage quiet Discord members",
            href: "/docs/recipes/re-engage-quiet-discord-members",
          },
          {
            label: "Recipe: welcome new Discord members",
            href: "/docs/recipes/welcome-new-discord-members",
          },
          {
            label: "Recipe: link a Discord account to an email",
            href: "/docs/recipes/link-discord-to-email",
          },
          { label: "Integration: Discord", href: "/docs/integrations/discord" },
        ]}
      />

      <MoreUseCases current="community" />

      <ClosingCta
        title="Start from the Discord journeys in the scaffold"
        subtitle="The scaffold ships the welcome, the win-back, and the /link loop that puts a Discord handle on a contact. Edit them like any other journey."
      />
    </main>
  );
}
