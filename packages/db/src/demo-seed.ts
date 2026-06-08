/**
 * Demo seed — populates the local database with a realistic dataset for
 * Hogsend Studio screenshots / demos. Everything it writes is scoped to a
 * `demo_` userId prefix so it is fully idempotent and never touches real data.
 *
 * It writes directly to the tables (contacts, journey_states, email_sends,
 * email_preferences, user_events) — it does NOT run any journeys, so no real
 * emails are ever sent through Resend.
 *
 *   DATABASE_URL=... pnpm --filter @hogsend/db exec tsx src/demo-seed.ts
 */
import { like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client, { schema });

// --- Deterministic PRNG so the dataset is stable across runs ---
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260602);
const pick = <T>(arr: readonly T[]): T =>
  arr[Math.floor(rand() * arr.length)] as T;
const int = (min: number, max: number) =>
  Math.floor(rand() * (max - min + 1)) + min;
const chance = (p: number) => rand() < p;

const NOW = Date.now();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const at = (ms: number) => new Date(Math.min(ms, NOW - MIN));
const daysAgo = (d: number, jitterH = 12) =>
  NOW - d * DAY - int(0, jitterH) * HOUR;

// --- People ---
const FIRST = [
  "Ada",
  "Lin",
  "Marco",
  "Priya",
  "Sofia",
  "Noah",
  "Elena",
  "Diego",
  "Yuki",
  "Omar",
  "Hana",
  "Theo",
  "Maya",
  "Ivan",
  "Zoe",
  "Liam",
  "Nina",
  "Caleb",
  "Aria",
  "Ravi",
  "Mila",
  "Felix",
  "Sara",
  "Jonas",
  "Lena",
  "Kofi",
  "Amara",
  "Tom",
  "Grace",
  "Bo",
  "Iris",
  "Sami",
  "Otto",
  "Vera",
  "Hugo",
  "Nadia",
  "Pablo",
  "Esme",
  "Karl",
  "Tara",
  "Leo",
  "Wren",
  "Cyrus",
  "Dahlia",
  "Jude",
  "Anya",
  "Reza",
  "Cleo",
  "Milo",
  "Freya",
  "Said",
  "Tess",
  "Niko",
  "Ines",
  "Bram",
  "Yara",
  "Emil",
  "Lucia",
  "Arlo",
  "Devi",
  "Soren",
  "Nora",
  "Idris",
  "Beatriz",
] as const;
const LAST = [
  "Okafor",
  "Reyes",
  "Nguyen",
  "Costa",
  "Haddad",
  "Lindqvist",
  "Moreno",
  "Petrov",
  "Kim",
  "Bauer",
  "Silva",
  "Novak",
  "Adeyemi",
  "Rossi",
  "Mbeki",
  "Kowalski",
  "Tan",
  "Fischer",
  "Abate",
  "Singh",
  "Larsen",
  "Mensah",
  "Vasquez",
  "Holm",
  "Dubois",
  "Bianchi",
  "Sato",
  "Walsh",
  "Cohen",
  "Park",
] as const;
const DOMAINS = [
  "lumen.io",
  "northstar.dev",
  "kettle.app",
  "fathom.co",
  "peat.io",
  "mosaic.so",
  "driftly.com",
  "corewave.io",
  "pinely.app",
  "brightloop.dev",
  "tideline.io",
  "quill.so",
] as const;
const PLANS = ["free", "trial", "pro", "growth"] as const;
const TZS = [
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Singapore",
  "Australia/Sydney",
  "America/Sao_Paulo",
] as const;

const USER_COUNT = 64;
const usedEmails = new Set<string>();
const users = Array.from({ length: USER_COUNT }, (_, i) => {
  const first = FIRST[i % FIRST.length] as string;
  const last = pick(LAST);
  let email = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, "");
  const domain = pick(DOMAINS);
  let candidate = `${email}@${domain}`;
  let n = 2;
  while (usedEmails.has(candidate)) {
    candidate = `${email}${n}@${domain}`;
    n += 1;
  }
  usedEmails.add(candidate);
  email = candidate;
  return {
    id: `demo_u${String(i + 1).padStart(3, "0")}`,
    name: `${first} ${last}`,
    email,
    plan: pick(PLANS),
    timezone: pick(TZS),
  };
});

// --- Templates (mirrors apps/api/src/emails/registry.ts) ---
const TEMPLATES: { key: string; subject: string; category: string }[] = [
  { key: "welcome", subject: "Welcome to Hogsend", category: "transactional" },
  {
    key: "password-reset",
    subject: "Reset your password",
    category: "transactional",
  },
  {
    key: "activation-quickstart",
    subject: "Your Hogsend setup guide",
    category: "journey",
  },
  {
    key: "activation-feature-highlight",
    subject: "Journeys are just TypeScript",
    category: "journey",
  },
  {
    key: "activation-community",
    subject: "See what other teams are shipping",
    category: "journey",
  },
  {
    key: "activation-nudge",
    subject: "We haven't seen any events yet",
    category: "journey",
  },
  {
    key: "conversion-usage-milestone",
    subject: "You've hit a Hogsend milestone",
    category: "journey",
  },
  {
    key: "conversion-trial-expiring",
    subject: "Your Hogsend Cloud trial is ending soon",
    category: "journey",
  },
  {
    key: "conversion-winback-offer",
    subject: "A little something to come back",
    category: "journey",
  },
  {
    key: "retention-achievement",
    subject: "You hit a milestone 🎉",
    category: "journey",
  },
  {
    key: "retention-weekly-digest",
    subject: "Your Hogsend week",
    category: "journey",
  },
  {
    key: "reactivation-checkin",
    subject: "Your project's gone quiet",
    category: "journey",
  },
  {
    key: "reactivation-final-nudge",
    subject: "One last note from Hogsend",
    category: "journey",
  },
  {
    key: "feedback-nps-survey",
    subject: "Quick question — how are we doing?",
    category: "journey",
  },
  {
    key: "churn-payment-failed",
    subject: "Your payment didn't go through",
    category: "transactional",
  },
];
const tpl = (key: string): { key: string; subject: string; category: string } =>
  TEMPLATES.find((t) => t.key === key) ?? {
    key,
    subject: key,
    category: "journey",
  };

// --- Journeys (id/name mirror apps/api/src/journeys) with funnel targets and
//     the templates each one sends. ---
type Counts = {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  exited: number;
};
const JOURNEYS: {
  id: string;
  templates: string[];
  counts: Counts;
}[] = [
  {
    id: "activation-welcome",
    templates: ["activation-quickstart", "activation-nudge"],
    counts: { active: 8, waiting: 5, completed: 22, failed: 1, exited: 3 },
  },
  {
    id: "activation-nudge-series",
    templates: [
      "activation-feature-highlight",
      "activation-community",
      "activation-nudge",
    ],
    counts: { active: 6, waiting: 4, completed: 14, failed: 1, exited: 2 },
  },
  {
    id: "conversion-trial-upgrade",
    templates: ["conversion-trial-expiring", "conversion-usage-milestone"],
    counts: { active: 5, waiting: 3, completed: 9, failed: 2, exited: 4 },
  },
  {
    id: "conversion-abandoned-checkout",
    templates: ["conversion-usage-milestone", "conversion-winback-offer"],
    counts: { active: 4, waiting: 2, completed: 7, failed: 0, exited: 6 },
  },
  {
    id: "churn-prevention",
    templates: ["churn-payment-failed"],
    counts: { active: 3, waiting: 2, completed: 5, failed: 1, exited: 8 },
  },
  {
    id: "reactivation-dormancy",
    templates: ["reactivation-checkin", "reactivation-final-nudge"],
    counts: { active: 5, waiting: 6, completed: 4, failed: 0, exited: 3 },
  },
  {
    id: "retention-milestone",
    templates: ["retention-achievement", "retention-weekly-digest"],
    counts: { active: 4, waiting: 0, completed: 12, failed: 0, exited: 0 },
  },
  {
    id: "feedback-nps",
    templates: ["feedback-nps-survey"],
    counts: { active: 2, waiting: 1, completed: 9, failed: 0, exited: 1 },
  },
  {
    id: "referral-invite",
    templates: ["retention-achievement"],
    counts: { active: 3, waiting: 0, completed: 6, failed: 0, exited: 1 },
  },
  {
    id: "test-onboarding",
    templates: ["welcome"],
    counts: { active: 1, waiting: 0, completed: 2, failed: 0, exited: 0 },
  },
];

const ERRORS = [
  "Resend API timeout after 3 retries",
  "Template render failed: missing prop `name`",
  "Recipient hard-bounced mid-journey",
  "Hatchet task exceeded max duration",
];

type JS = typeof schema.journeyStates.$inferInsert;
type ES = typeof schema.emailSends.$inferInsert;
type EV = typeof schema.userEvents.$inferInsert;

const journeyStateRows: JS[] = [];
// Track (stateLocalId) -> meta so we can attach sends after insert returns ids.
const stateMeta: {
  localKey: string;
  journeyId: string;
  templates: string[];
  user: (typeof users)[number];
  status: string;
  createdMs: number;
}[] = [];

let cursor = 0;
const nextUser = () => users[cursor++ % users.length] as (typeof users)[number];

for (const j of JOURNEYS) {
  cursor = JOURNEYS.indexOf(j) * 7; // rotate the starting user per journey
  const seenInJourney = new Set<string>();
  const take = (): (typeof users)[number] => {
    let u = nextUser();
    let guard = 0;
    while (seenInJourney.has(u.id) && guard < users.length) {
      u = nextUser();
      guard += 1;
    }
    seenInJourney.add(u.id);
    return u;
  };

  const emit = (status: keyof Counts, n: number) => {
    for (let i = 0; i < n; i++) {
      const u = take();
      let createdMs: number;
      let currentNodeId: string;
      let completedAt: Date | null = null;
      let exitedAt: Date | null = null;
      let errorMessage: string | null = null;
      let updatedMs: number;

      if (status === "active") {
        createdMs = daysAgo(int(0, 6));
        currentNodeId = pick([
          "welcome-sent",
          "wait-2d",
          "check-feature-used",
          "nudge-decision",
        ]);
        updatedMs = createdMs + int(1, 40) * HOUR;
      } else if (status === "waiting") {
        createdMs = daysAgo(int(1, 9));
        currentNodeId = "sleeping";
        updatedMs = createdMs + int(2, 30) * HOUR;
      } else if (status === "completed") {
        createdMs = daysAgo(int(5, 29));
        const dur = int(1, 6) * DAY + int(0, 20) * HOUR;
        completedAt = at(createdMs + dur);
        currentNodeId = "journey-complete";
        updatedMs = completedAt.getTime();
      } else if (status === "failed") {
        createdMs = daysAgo(int(2, 20));
        errorMessage = pick(ERRORS);
        currentNodeId = "send-email";
        updatedMs = createdMs + int(1, 24) * HOUR;
      } else {
        createdMs = daysAgo(int(3, 25));
        exitedAt = at(createdMs + int(0, 4) * DAY + int(1, 20) * HOUR);
        currentNodeId = "exit-on-event";
        updatedMs = exitedAt.getTime();
      }

      const localKey = `${j.id}:${status}:${i}:${u.id}`;
      journeyStateRows.push({
        userId: u.id,
        userEmail: u.email,
        journeyId: j.id,
        currentNodeId,
        status,
        context: { plan: u.plan, source: "demo" },
        errorMessage,
        entryCount: 1,
        completedAt,
        exitedAt,
        createdAt: at(createdMs),
        updatedAt: at(updatedMs),
      });
      stateMeta.push({
        localKey,
        journeyId: j.id,
        templates: j.templates,
        user: u,
        status,
        createdMs,
      });
    }
  };

  emit("active", j.counts.active);
  emit("waiting", j.counts.waiting);
  emit("completed", j.counts.completed);
  emit("failed", j.counts.failed);
  emit("exited", j.counts.exited);
}

// --- Build email_sends. One outcome funnel per send. ---
function buildSend(opts: {
  templateKey: string;
  user: (typeof users)[number];
  journeyStateId: string | null;
  baseMs: number;
}): ES {
  const t = tpl(opts.templateKey);
  const createdMs = opts.baseMs + int(0, 90) * MIN;
  let status:
    | "queued"
    | "sent"
    | "delivered"
    | "opened"
    | "clicked"
    | "bounced"
    | "complained"
    | "failed" = "delivered";
  let sentAt: Date | null = null;
  let deliveredAt: Date | null = null;
  let openedAt: Date | null = null;
  let clickedAt: Date | null = null;
  let bouncedAt: Date | null = null;
  let complainedAt: Date | null = null;
  let bounceType: string | null = null;
  let bounceReason: string | null = null;

  const r = rand();
  if (r < 0.03) {
    status = "queued";
  } else if (r < 0.05) {
    status = "failed";
    sentAt = at(createdMs + int(1, 8) * MIN);
  } else if (r < 0.075) {
    status = "bounced";
    sentAt = at(createdMs + int(1, 5) * MIN);
    bouncedAt = at(sentAt.getTime() + int(1, 30) * MIN);
    bounceType = pick(["hard", "soft", "transient"]);
    bounceReason = pick([
      "Mailbox does not exist",
      "Mailbox full",
      "Message rejected by recipient server",
    ]);
  } else if (r < 0.085) {
    status = "complained";
    sentAt = at(createdMs + int(1, 5) * MIN);
    deliveredAt = at(sentAt.getTime() + int(1, 20) * MIN);
    complainedAt = at(deliveredAt.getTime() + int(2, 40) * HOUR);
  } else {
    // delivered, then maybe opened, then maybe clicked
    sentAt = at(createdMs + int(1, 6) * MIN);
    deliveredAt = at(sentAt.getTime() + int(1, 15) * MIN);
    status = "delivered";
    if (chance(0.52)) {
      openedAt = at(deliveredAt.getTime() + int(5, 60 * 36) * MIN);
      status = "opened";
      if (chance(0.3)) {
        clickedAt = at(openedAt.getTime() + int(1, 360) * MIN);
        status = "clicked";
      }
    }
  }

  return {
    journeyStateId: opts.journeyStateId,
    userId: opts.user.id,
    userEmail: opts.user.email,
    templateKey: t.key,
    fromEmail: "noreply@hogsend.com",
    toEmail: opts.user.email,
    subject: t.subject,
    category: t.category,
    status,
    sentAt,
    deliveredAt,
    openedAt,
    clickedAt,
    bouncedAt,
    complainedAt,
    bounceType,
    bounceReason,
    messageId:
      status === "queued"
        ? null
        : `re_${Math.floor(rand() * 1e16).toString(36)}`,
    createdAt: at(createdMs),
    updatedAt: at(
      clickedAt?.getTime() ??
        openedAt?.getTime() ??
        deliveredAt?.getTime() ??
        bouncedAt?.getTime() ??
        complainedAt?.getTime() ??
        sentAt?.getTime() ??
        createdMs,
    ),
  };
}

// --- email_preferences (drives the Suppressions view) ---
type EP = typeof schema.emailPreferences.$inferInsert;
const prefRows: EP[] = users.map((u, i) => {
  // ~8% unsubscribed, ~6% bounced-suppressed, ~3% complained-suppressed
  const roll = rand();
  if (i < 5) {
    // unsubscribed
    return {
      userId: u.id,
      email: u.email,
      unsubscribedAll: true,
      suppressed: true,
      bounceCount: 0,
      categories: {},
      suppressedAt: at(daysAgo(int(1, 20))),
    };
  }
  if (i >= 5 && i < 9) {
    // bounced
    const lb = at(daysAgo(int(0, 14)));
    return {
      userId: u.id,
      email: u.email,
      unsubscribedAll: false,
      suppressed: true,
      bounceCount: int(1, 4),
      categories: {},
      suppressedAt: lb,
      lastBounceAt: lb,
    };
  }
  if (i >= 9 && i < 11) {
    // complained
    return {
      userId: u.id,
      email: u.email,
      unsubscribedAll: false,
      suppressed: true,
      bounceCount: 0,
      categories: {},
      suppressedAt: at(daysAgo(int(0, 10))),
    };
  }
  const categories: Record<string, boolean> =
    roll < 0.1 ? { marketing: false } : {};
  return {
    userId: u.id,
    email: u.email,
    unsubscribedAll: roll < 0.04,
    suppressed: false,
    bounceCount: 0,
    categories,
  };
});

// --- user_events (event volume + contact timelines) ---
const EVENT_NAMES = [
  "user.created",
  "feature.used",
  "checkout.started",
  "checkout.completed",
  "plan.upgraded",
  "login",
  "project.connected",
  "invite.sent",
] as const;
const eventRows: EV[] = [];
for (const u of users) {
  const nEvents = int(1, 6);
  for (let i = 0; i < nEvents; i++) {
    eventRows.push({
      userId: u.id,
      event: i === 0 ? "user.created" : pick(EVENT_NAMES),
      properties: { plan: u.plan, source: "demo" },
      occurredAt: at(daysAgo(int(0, 29))),
    });
  }
}

async function chunkInsert<T>(
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>,
  size = 100,
) {
  for (let i = 0; i < rows.length; i += size) {
    await insert(rows.slice(i, i + size));
  }
}

async function main() {
  console.log(
    `Demo seed — ${users.length} contacts, ${journeyStateRows.length} journey states.`,
  );

  // 1) Clean any prior demo rows (FK-safe order).
  await db
    .delete(schema.emailSends)
    .where(like(schema.emailSends.userId, "demo_%"));
  await db
    .delete(schema.journeyStates)
    .where(like(schema.journeyStates.userId, "demo_%"));
  await db
    .delete(schema.emailPreferences)
    .where(like(schema.emailPreferences.userId, "demo_%"));
  await db
    .delete(schema.userEvents)
    .where(like(schema.userEvents.userId, "demo_%"));
  await db
    .delete(schema.contacts)
    .where(like(schema.contacts.externalId, "demo_%"));

  // 2) Contacts
  await chunkInsert(users, (batch) =>
    db.insert(schema.contacts).values(
      batch.map((u) => ({
        externalId: u.id,
        email: u.email,
        timezone: u.timezone,
        properties: { name: u.name, plan: u.plan },
        firstSeenAt: at(daysAgo(int(15, 60))),
        lastSeenAt: at(daysAgo(int(0, 10))),
      })),
    ),
  );

  // 3) Email preferences
  await chunkInsert(prefRows, (batch) =>
    db.insert(schema.emailPreferences).values(batch),
  );

  // 4) Journey states (capture ids)
  const insertedStates: { id: string }[] = [];
  for (let i = 0; i < journeyStateRows.length; i += 100) {
    const batch = journeyStateRows.slice(i, i + 100);
    const ret = await db
      .insert(schema.journeyStates)
      .values(batch)
      .returning({ id: schema.journeyStates.id });
    insertedStates.push(...ret);
  }

  // 5) Email sends — tie ~85% to a journey state, plus standalone transactional.
  const sendRows: ES[] = [];
  insertedStates.forEach((st, idx) => {
    const meta = stateMeta[idx];
    if (!meta) return;
    // queued/failed states rarely have a send; others usually send 1-2.
    const nSends =
      meta.status === "completed"
        ? int(1, Math.min(2, meta.templates.length))
        : meta.status === "exited"
          ? int(0, 1)
          : meta.status === "failed"
            ? chance(0.6)
              ? 1
              : 0
            : int(0, 1);
    for (let k = 0; k < nSends; k++) {
      sendRows.push(
        buildSend({
          templateKey: meta.templates[k % meta.templates.length] as string,
          user: meta.user,
          journeyStateId: st.id,
          baseMs: meta.createdMs + k * int(1, 3) * DAY,
        }),
      );
    }
  });
  // Standalone transactional sends (no journey linkage)
  for (let i = 0; i < 46; i++) {
    const u = pick(users);
    sendRows.push(
      buildSend({
        templateKey: pick([
          "welcome",
          "password-reset",
          "churn-payment-failed",
        ]),
        user: u,
        journeyStateId: null,
        baseMs: daysAgo(int(0, 29)),
      }),
    );
  }
  await chunkInsert(sendRows, (batch) =>
    db.insert(schema.emailSends).values(batch),
  );

  // 6) User events
  await chunkInsert(eventRows, (batch) =>
    db.insert(schema.userEvents).values(batch),
  );

  console.log(
    `Inserted: ${users.length} contacts, ${insertedStates.length} journey states, ${sendRows.length} email sends, ${prefRows.length} prefs, ${eventRows.length} events.`,
  );
  console.log("Demo seed complete.");
}

await main();
await client.end();
process.exit(0);
