import type { RecipeLander } from "./types";

const TASK_CODE = `// src/workflows/weekly-digest.ts
import { contacts, userEvents } from "@hogsend/db";
import { hatchet } from "@hogsend/engine";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getContainer } from "../container.js";
import { Events, Templates } from "../journeys/constants/index.js";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const weeklyDigestTask = hatchet.task({
  name: "weekly-digest",
  // Mondays at 09:00 UTC — a clock is the trigger, not a user event.
  onCrons: ["0 9 * * 1"],
  retries: 1,
  executionTimeout: "30m",
  fn: async () => {
    const { db, emailService, logger } = getContainer();
    const since = new Date(Date.now() - WINDOW_MS);
    // One key per (user, weekly run): retries and re-runs can't double-send.
    const weekKey = new Date().toISOString().slice(0, 10);

    // One aggregate query — users with no qualifying events never appear,
    // so the empty digest is structurally impossible.
    const activity = await db
      .select({
        userId: userEvents.userId,
        reportsCreated: sql<number>\`count(*) filter (where \${userEvents.event} = \${Events.REPORT_CREATED})\`,
        reportsShared: sql<number>\`count(*) filter (where \${userEvents.event} = \${Events.REPORT_SHARED})\`,
      })
      .from(userEvents)
      .where(
        and(
          gte(userEvents.occurredAt, since),
          inArray(userEvents.event, [
            Events.REPORT_CREATED,
            Events.REPORT_SHARED,
          ]),
        ),
      )
      .groupBy(userEvents.userId);

    let sent = 0;
    let skipped = 0;

    for (const row of activity) {
      // Identity resolved server-side — userId on events is never an email.
      const contact = await db.query.contacts.findFirst({
        where: eq(contacts.externalId, row.userId),
      });
      if (!contact?.email) {
        skipped++;
        continue;
      }

      const result = await emailService.send({
        template: Templates.RETENTION_WEEKLY_DIGEST,
        to: contact.email,
        userId: row.userId,
        subject: "Your week in review",
        props: {
          reportsCreated: Number(row.reportsCreated),
          reportsShared: Number(row.reportsShared),
          weekOf: weekKey,
        },
        // NO skipPreferenceCheck — a digest is exactly the mail that
        // preferences exist to control.
        idempotencyKey: \`digest:\${row.userId}:\${weekKey}\`,
      });

      if (result.status === "sent") sent++;
      else skipped++;
    }

    logger.info("weekly-digest complete", { sent, skipped, weekKey });
    return { sent, skipped, week: weekKey };
  },
});`;

const REGISTER_CODE = `// src/worker.ts — extraWorkflows comes from src/workflows/index.ts,
// which exports [weeklyDigestTask]; the engine's built-ins register themselves.
import { createWorker } from "@hogsend/engine";
import { getContainer } from "./container.js";
import { journeys } from "./journeys/index.js";
import { extraWorkflows } from "./workflows/index.js";

const client = getContainer();
const worker = createWorker({
  container: client,
  journeys,
  extraWorkflows, // NOT \`workflows\`
});
await worker.start();`;

export const weeklyDigest: RecipeLander = {
  slug: "weekly-digest",
  category: "retention",
  title: "Weekly digest",
  metaDescription:
    "A weekly activity digest as a cron Hatchet task in TypeScript: one aggregate query over user_events, per-user idempotency keys so retries never double-send, preference-checked sends, and empty digests structurally skipped.",
  cardDescription:
    "A cron task that aggregates the week, skips empty digests, and survives its own retries.",
  eyebrow: "Recipe — Retention & engagement",
  subhead:
    "One hatchet.task() on a Monday cron sweeps the whole audience: a single GROUP BY decides who has something to read, and digest:<userId>:<week> idempotency keys make a crashed run's retry finish the list instead of re-mailing it.",
  problem: {
    label: "The digest-sender problem",
    statement:
      "Digest senders fail in two boring ways: the cron that dies at recipient 4,000 of 9,000 re-sends the first 4,000 on retry, and the query that returns every user emails the ones with nothing to report. Both are idempotency and audience problems, not template problems — and a scheduler with no send-level dedup key can fix neither.",
  },
  walkthrough: {
    eyebrow: "The task",
    title: "Not a journey — and that's the point",
    subtitle:
      "A journey run is born from one user's event; a digest's trigger is a clock and its audience is a query. One cron Hatchet task in src/workflows/ does what N synthetic enrollments would simulate badly.",
    note: "Journeys also cap a run at 720 hours, so a per-user 'sleep until next Monday, forever' loop terminates after four digests — the cron task has no such loop because each Monday is a fresh run over a fresh query.",
  },
  code: [
    {
      filename: "src/workflows/weekly-digest.ts",
      code: TASK_CODE,
      caption:
        "onCrons replaces onEvents: the clock is the trigger. The aggregate only returns active users, and every send carries a per-user, per-week idempotency key.",
    },
    {
      filename: "src/worker.ts",
      code: REGISTER_CODE,
      caption:
        "Registered via extraWorkflows next to the engine's built-ins — the task resolves db and emailService from the same process-wide container the worker boots.",
    },
  ],
  points: [
    {
      title: "Retries finish the list, they don't restart it",
      body: 'Every send carries idempotencyKey: "digest:<userId>:<weekKey>". A retry (or a manual re-run from the Hatchet dashboard) re-issues the same keys, and the mailer short-circuits already-fulfilled ones to the existing email_sends row — the back half of the list gets sent, the front half no-ops.',
    },
    {
      title: "Empty digests are structurally impossible",
      body: "The recipient list is the GROUP BY result of one aggregate query over user_events scoped to the window — a user with no qualifying activity is never selected, so the 'your week: nothing happened' email cannot be constructed.",
    },
    {
      title: "Preferences are enforced at send time",
      body: "Each send flows through the tracked mailer's preference check: unsubscribed and suppressed contacts come back as a counted status, not a delivery. The task never passes skipPreferenceCheck — a digest is exactly the mail a preference center exists to control.",
    },
    {
      title: "Same worker, same container, same tracking",
      body: "The task registers via extraWorkflows alongside your journeys and resolves emailService from the process-wide container, so digest sends get the full pipeline — email_sends rows, link and open tracking, typed template props — identical to journey sends.",
    },
  ],
  faq: [
    {
      q: "Why is this not a journey?",
      a: "defineJourney() wires its task to onEvents: [trigger.event] — a journey run starts from one user's ingested event. A digest has no triggering event (the trigger is a clock) and no per-user flow (the audience is a query at send time). Forcing it into journeys means a synthetic event per user every Monday, or a per-user infinite sleep loop that the 720-hour journey execution timeout kills after a month.",
    },
    {
      q: "What happens when the task crashes mid-run?",
      a: "retries: 1 re-runs the function. The aggregate re-selects the same audience, the loop re-issues the same idempotency keys, and sends already fulfilled short-circuit to their existing email_sends rows — recipients before the crash get nothing new, recipients after it get their digest.",
    },
    {
      q: "Can the digest land in each user's local morning?",
      a: "Not from one cron — cron expressions evaluate in UTC, so 0 9 * * 1 is the same instant for everyone. Per-recipient local timing is what ctx.when inside a journey is for; see the Timezone-aware scheduling recipe. A digest trades local timing for a single sweep.",
    },
    {
      q: "Why emailService.send instead of the sendEmail() journeys use?",
      a: "sendEmail() is the journey-side wrapper: it hardcodes the journey category and takes no idempotencyKey. The container's emailService.send accepts the idempotency key and lets the template registry's own category apply — while still running the same render, preference-check, and tracking pipeline.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/weekly-digest",
    },
    {
      label: "Custom Hatchet tasks — defining and registering",
      href: "/docs/guides/webhook-sources",
    },
    {
      label: "Email guide — the tracked send pipeline",
      href: "/docs/guides/email",
    },
  ],
  related: ["winback-and-sunset", "nps-survey", "ai-drafted-sends"],
};
