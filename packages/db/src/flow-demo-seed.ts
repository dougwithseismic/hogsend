/**
 * Flow-map demo seed — a COHERENT lifecycle story for the control room
 * (#485/#499), replacing ad-hoc random event soup that drew every node into
 * every other node.
 *
 * The flow map draws an edge A→B when one contact's CONSECUTIVE classified
 * events move A then B — so this seed writes ordered timelines per cohort,
 * never random picks:
 *
 *   campaign.arrived ─▶ site ─▶ docs ─▶ course ─▶ checkout ─▶ revenue
 *        referral ────▶ site        demo ↗            │
 *                                                     ▼ (abandoned)
 *                                     conversion-abandoned-checkout journey
 *                                                     │ (email brings back)
 *                                                     ▶ checkout ─▶ revenue
 *
 * plus a small, SEPARATE B2B lane (site ─▶ Commercial · Enquiry ─▶ Contract
 * signed) so the funnel-stage nodes demo without polluting the SaaS story.
 *
 * Everything is scoped to a `flow_` userId prefix and idempotent. It does NOT
 * wipe other data — bin the tables first if you want a clean slate:
 *
 *   DATABASE_URL=... pnpm --filter @hogsend/db exec tsx src/flow-demo-seed.ts
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

// Deterministic PRNG — the same map every run.
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
const rand = mulberry32(20260715);
const int = (min: number, max: number) =>
  Math.floor(rand() * (max - min + 1)) + min;
const chance = (p: number) => rand() < p;
const pick = <T>(arr: readonly T[]): T =>
  arr[Math.floor(rand() * arr.length)] as T;

const NOW = Date.now();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

const FIRST = [
  "ada",
  "lin",
  "marco",
  "priya",
  "sofia",
  "noah",
  "elena",
  "kai",
  "mia",
  "jonas",
  "aiko",
  "tariq",
  "greta",
  "sam",
  "leila",
  "owen",
  "nina",
  "raj",
  "june",
  "theo",
];
const DOMAIN = [
  "acme.com",
  "globex.io",
  "initech.dev",
  "umbra.co",
  "hooli.xyz",
  "stark.app",
];

type EV = typeof schema.userEvents.$inferInsert;
type JS = typeof schema.journeyStates.$inferInsert;

interface Person {
  id: string;
  email: string;
  /** A strictly-increasing event clock, ms. */
  clock: number;
  events: EV[];
}

let seq = 0;
function person(startMsAgo: number): Person {
  seq += 1;
  const name = pick(FIRST);
  return {
    id: `flow_${String(seq).padStart(3, "0")}`,
    email: `${name}${seq}@${pick(DOMAIN)}`,
    clock: NOW - startMsAgo,
    events: [],
  };
}

/** Append an event `gapMin..gapMax` minutes after the previous one. */
function emit(
  p: Person,
  event: string,
  opts: {
    gap?: [number, number];
    properties?: Record<string, unknown>;
    value?: number;
    currency?: string;
  } = {},
) {
  const [lo, hi] = opts.gap ?? [2, 40];
  p.clock = Math.min(p.clock + int(lo, hi) * MIN, NOW - MIN);
  p.events.push({
    userId: p.id,
    event,
    properties: opts.properties ?? null,
    value: opts.value,
    currency: opts.currency,
    source: "seed",
    occurredAt: new Date(p.clock),
  });
}

const people: Person[] = [];
const journeyStates: JS[] = [];

function journeyState(
  p: Person,
  journeyId: string,
  status: "active" | "waiting" | "completed",
  enteredMsAgo: number,
) {
  const createdAt = new Date(NOW - enteredMsAgo);
  journeyStates.push({
    userId: p.id,
    userEmail: p.email,
    journeyId,
    status,
    currentNodeId:
      status === "completed"
        ? "journey-complete"
        : status === "waiting"
          ? "sleeping"
          : "nudge-decision",
    context: { source: "flow-seed" },
    entryCount: 1,
    completedAt:
      status === "completed" ? new Date(NOW - enteredMsAgo / 2) : null,
    createdAt,
    updatedAt: new Date(NOW - enteredMsAgo / 3),
  });
}

// --- Shared journeys through the product -----------------------------------

/** site → (pricing) → docs → deeper docs. Returns how deep they got. */
function browse(p: Person): "site" | "docs" {
  emit(p, "site.visited");
  if (chance(0.5)) emit(p, "site.pricing_viewed", { gap: [1, 6] });
  if (chance(0.65)) {
    emit(p, "docs.opened", { gap: [3, 30] });
    const pages = int(1, 3);
    for (let i = 0; i < pages; i++) {
      emit(p, "docs.page_viewed", { gap: [1, 8] });
    }
    return "docs";
  }
  return "site";
}

/** course.enrolled → lessons; the activation-welcome journey nudges between. */
function activate(p: Person, withWelcomeJourney: boolean) {
  emit(p, "course.enrolled", { gap: [30, 300] });
  if (withWelcomeJourney) {
    emit(p, "email.opened", {
      gap: [60, 600],
      properties: {
        journeyId: "activation-welcome",
        templateKey: "activation-quickstart",
      },
    });
    journeyState(
      p,
      "activation-welcome",
      pick(["active", "completed"]),
      3 * DAY,
    );
  }
  const lessons = int(1, 3);
  for (let i = 0; i < lessons; i++) {
    emit(p, "course.lesson_completed", { gap: [45, 400] });
  }
}

/** checkout.started → completed(+value) → subscription.activated (revenue). */
function buy(p: Person) {
  emit(p, "checkout.started", { gap: [10, 120] });
  const amount = pick([49, 99, 249] as const);
  emit(p, "checkout.completed", {
    gap: [2, 15],
    value: amount,
    currency: "USD",
  });
  // The server-side conversion — no surface prefix claims it, positive value
  // → the builtin revenue node. This is the checkout ─▶ revenue rail.
  emit(p, "subscription.activated", {
    gap: [1, 4],
    value: amount,
    currency: "USD",
  });
}

// --- Cohort A: paid campaign arrivals (two lanes) ---------------------------
for (let i = 0; i < 38; i++) {
  const p = person(int(0, 6) * DAY + int(1, 20) * HOUR);
  const lane = i % 5 < 3 ? "ph-launch" : "launch-week";
  emit(p, "campaign.arrived", {
    gap: [0, 1],
    properties: { utm_campaign: lane, utm_source: "posthog" },
  });
  const depth = browse(p);
  if (depth === "docs" && chance(0.5)) {
    activate(p, chance(0.6));
    if (chance(0.45)) buy(p);
  }
  people.push(p);
}

// --- Cohort B: organic discovery --------------------------------------------
for (let i = 0; i < 46; i++) {
  const p = person(int(0, 6) * DAY + int(1, 20) * HOUR);
  if (chance(0.3)) {
    // Straight into the docs (search landing).
    emit(p, "docs.opened", { gap: [0, 1] });
    emit(p, "docs.page_viewed", { gap: [1, 10] });
    if (chance(0.4)) emit(p, "site.visited", { gap: [5, 60] });
  } else {
    browse(p);
  }
  if (chance(0.3)) {
    emit(p, "demo.opened", { gap: [5, 90] });
    if (chance(0.7)) emit(p, "demo.answered", { gap: [1, 10] });
  }
  people.push(p);
}

// --- Cohort C: referral arrivals ---------------------------------------------
for (let i = 0; i < 9; i++) {
  const p = person(int(0, 5) * DAY + int(1, 20) * HOUR);
  emit(p, "referral.visited", { gap: [0, 1] });
  emit(p, "site.visited", { gap: [1, 5] });
  if (chance(0.5)) emit(p, "docs.opened", { gap: [5, 40] });
  people.push(p);
}

// --- Cohort D: committed buyers (docs → course → checkout → revenue) --------
for (let i = 0; i < 14; i++) {
  const p = person(int(2, 6) * DAY + int(1, 20) * HOUR);
  browse(p);
  activate(p, chance(0.5));
  buy(p);
  people.push(p);
}

// --- Cohort E: abandoned checkout + the rescue journey -----------------------
for (let i = 0; i < 12; i++) {
  // Started days ago and stalled at checkout — the "N stuck" pile-up.
  const p = person(int(3, 6) * DAY + int(1, 12) * HOUR);
  browse(p);
  activate(p, false);
  emit(p, "checkout.started", { gap: [10, 120] });
  if (i < 8) {
    // The abandoned-checkout journey emailed them…
    emit(p, "email.opened", {
      gap: [12 * 60, 30 * 60],
      properties: {
        journeyId: "conversion-abandoned-checkout",
        templateKey: "conversion-winback-offer",
      },
    });
    if (i < 4) {
      // …and it worked: back to checkout, purchase lands.
      const amount = pick([49, 99] as const);
      emit(p, "checkout.completed", {
        gap: [10, 90],
        value: amount,
        currency: "USD",
      });
      emit(p, "subscription.activated", {
        gap: [1, 4],
        value: amount,
        currency: "USD",
      });
      journeyState(p, "conversion-abandoned-checkout", "completed", 2 * DAY);
    } else {
      journeyState(
        p,
        "conversion-abandoned-checkout",
        pick(["active", "waiting"]),
        2 * DAY,
      );
    }
  }
  people.push(p);
}

// --- Cohort F: the B2B lane (separate contacts, separate rail) --------------
for (let i = 0; i < 6; i++) {
  const p = person(int(1, 6) * DAY + int(1, 20) * HOUR);
  emit(p, "site.visited", { gap: [0, 1] });
  emit(p, "commercial.enquiry_received", { gap: [60, 600] });
  if (i < 3) {
    emit(p, "commercial.contract_signed", {
      gap: [24 * 60, 72 * 60],
      value: 6_900,
      currency: "EUR",
    });
  }
  people.push(p);
}

// --- Write ------------------------------------------------------------------
async function chunkInsert<T>(
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>,
  size = 200,
) {
  for (let i = 0; i < rows.length; i += size) {
    await insert(rows.slice(i, i + size));
  }
}

async function main() {
  const events = people.flatMap((p) => p.events);
  console.log(
    `Flow seed — ${people.length} contacts, ${events.length} events, ` +
      `${journeyStates.length} journey states.`,
  );

  await db
    .delete(schema.journeyStates)
    .where(like(schema.journeyStates.userId, "flow_%"));
  await db
    .delete(schema.userEvents)
    .where(like(schema.userEvents.userId, "flow_%"));
  await db
    .delete(schema.contacts)
    .where(like(schema.contacts.externalId, "flow_%"));

  await chunkInsert(people, (batch) =>
    db.insert(schema.contacts).values(
      batch.map((p) => ({
        externalId: p.id,
        email: p.email,
        firstSeenAt: p.events[0]?.occurredAt ?? new Date(NOW),
        lastSeenAt: p.events[p.events.length - 1]?.occurredAt ?? new Date(NOW),
      })),
    ),
  );
  await chunkInsert(events, (batch) =>
    db.insert(schema.userEvents).values(batch),
  );
  if (journeyStates.length > 0) {
    await chunkInsert(journeyStates, (batch) =>
      db.insert(schema.journeyStates).values(batch),
    );
  }

  console.log("Done.");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
