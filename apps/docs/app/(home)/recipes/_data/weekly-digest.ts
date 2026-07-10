import type { RecipeLander } from "./types";

const JOURNEY_CODE = `// src/journeys/weekly-digest.ts
import { days, defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

export const weeklyDigest = defineJourney({
  meta: {
    id: "weekly-digest",
    name: "Retention — Weekly activity digest",
    enabled: true,
    // Any report activity opens a window; the rest of the week folds in.
    trigger: { event: Events.REPORT_CREATED },
    entryLimit: "unlimited", // rolling: a fresh window opens after each flush
    // ctx.digest already collapses the week into one send — a non-zero
    // suppress would gap out each new window's email against the previous.
    suppress: days(0),
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    // First report enrolls; every report.created in the next 7 days is
    // absorbed by the enrollment guard and returned here at flush. One
    // execution, one email — not one per report.
    const digest = await ctx.digest({ window: days(7), label: "weekly" });

    // A 7-day window is a long wait; unsubscribe doesn't exit the journey.
    if (!(await ctx.guard.isSubscribed())) return;

    // The "batch" recipe: ctx.digest collects the window, grouping is plain
    // TypeScript over digest.events.
    const byProject = Object.groupBy(
      digest.events,
      (e) => String(e.properties?.projectId ?? "unknown"),
    );
    const projects = Object.entries(byProject).map(([projectId, events]) => ({
      projectId,
      count: events?.length ?? 0,
    }));

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.RETENTION_WEEKLY_DIGEST,
      subject: "Your week in review",
      journeyName: user.journeyName,
      props: { totalReports: digest.count, projects },
    });
  },
});`;

const TASK_CODE = `// src/workflows/weekly-digest.ts — the fixed-day alternative
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

export const weeklyDigest: RecipeLander = {
  slug: "weekly-digest",
  category: "retention",
  title: "Weekly digest",
  metaDescription:
    "A per-user weekly activity digest as one defineJourney() + ctx.digest: a rolling 7-day window that collapses a burst of activity into one replay-safe email, the Object.groupBy batch recipe, and the cron fan-out as the fixed-day alternative.",
  cardDescription:
    "One ctx.digest() call collapses a week of activity into one email — replay-safe, no idempotency bookkeeping.",
  eyebrow: "Recipe — Retention & engagement",
  subhead:
    "ctx.digest() opens a 7-day window on a user's first activity, absorbs every event that week into one execution, and records the flush — so a busy user gets one email instead of forty, and a replay re-sends nothing. The cron sweep stays for a fixed Monday cadence.",
  problem: {
    label: "The digest-sender problem",
    statement:
      "A hand-rolled digest fails in two boring ways: the process that fires on every activity event mails forty times for a busy week, and the retry after a mid-run crash re-sends the front half of the list. Both are aggregation-and-dedup problems — ctx.digest solves both structurally, collapsing the window into one recorded execution whose send is auto-keyed against replay.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "One primitive, not a cron and a weekKey",
    subtitle:
      "ctx.digest sleeps the window out durably, scans the user's events once, and records the result. The first event enrolls; the rest of the week is absorbed by the enrollment guard and returned at flush.",
    note: "Rolling and per-user: entryLimit 'unlimited' opens a fresh window after each flush, so an active user is digested roughly weekly and a silent one never is — the window counts from their own activity, not a server clock.",
  },
  code: [
    {
      filename: "src/journeys/weekly-digest.ts",
      code: JOURNEY_CODE,
      caption:
        "ctx.digest collapses the week into one execution; Object.groupBy over digest.events is the whole 'batch' step. No aggregate SQL, no contact lookup, no weekKey.",
    },
    {
      filename: "src/workflows/weekly-digest.ts",
      code: TASK_CODE,
      caption:
        "The alternative: when every user should get the digest at the same fixed UTC instant, a cron task sweeps the audience in one query and carries an explicit per-user, per-week idempotency key.",
    },
  ],
  points: [
    {
      title: "A burst collapses into one execution",
      body: "The first event enrolls the journey; every later event of the same name that week is absorbed by the active-enrollment guard — spawning no new run — and collected when the window flushes. Forty report.created events become one email, not forty.",
    },
    {
      title: "Replay-safe with nothing to author",
      body: "The flush scan runs once and its result is recorded in the state row, so a replay-from-top returns the verbatim-same set instead of rescanning. The post-digest send is auto-keyed to the digest site, so a replay short-circuits to the existing email_sends row — no weekKey, no manual idempotency key.",
    },
    {
      title: "The batch is plain TypeScript",
      body: "ctx.digest only collects and dedups the window; digest.events is a flat chronological array. Object.groupBy (or a reduce) turns it into whatever sections the template wants — there is deliberately no batch primitive to learn.",
    },
    {
      title: "Windows are never tier-gated",
      body: "A digest window has no plan ceiling other than the journey execution limit (720h / 30 days). suppress: days(0) keeps the per-journey min-gap from fighting the rolling re-enrollment, and ctx.guard.isSubscribed() re-checks the long wait before the send.",
    },
  ],
  faq: [
    {
      q: "When should I use the cron task instead of ctx.digest?",
      a: "Use ctx.digest for a rolling, per-user digest — each user's window opens on their own activity, so timing is per person and there's no fixed day. Use the cron task when you want every active user to get the digest at the same fixed instant (a Monday-morning newsletter cadence). The cron fires in UTC for everyone; per-recipient local timing is only possible in the journey.",
    },
    {
      q: "How does a busy user not get one email per event?",
      a: "The first event enrolls and opens the window; every subsequent event of the same name is folded into the active enrollment by the guard rather than starting a new run, and is returned in digest.events at flush. The journey executes exactly once per window, so it sends exactly once.",
    },
    {
      q: "What happens on a worker crash mid-window?",
      a: "The window deadline is recorded set-once, so a replay-from-top reuses it instead of extending the window. The flush result is recorded too, so a replay returns the same set without rescanning, and the auto-keyed send short-circuits to the existing email_sends row. Nothing double-sends.",
    },
    {
      q: "Does an event that arrives right as the digest sends get lost?",
      a: "No — it's absorbed by the enrollment guard. It just isn't included in the digest that's flushing; it counts toward the next window instead. This straggler band is an accepted caveat that matches Novu's digest semantics.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/weekly-digest",
    },
    {
      label: "ctx.digest — window, replay, and batch semantics",
      href: "/docs/guides/journeys#ctxdigest",
    },
    {
      label: "Email guide — the tracked send pipeline",
      href: "/docs/guides/email",
    },
  ],
  related: ["winback-and-sunset", "nps-survey", "ai-drafted-sends"],
};
