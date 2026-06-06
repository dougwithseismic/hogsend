import { defineBucket } from "@hogsend/engine";
import { Events } from "../journeys/constants/index.js";

/**
 * Example bucket — a real-time, code-defined group of users (the peer of a
 * journey). A user JOINS the moment their data satisfies `criteria` and LEAVES
 * when it stops; each transition fires `bucket:entered:<id>` / `bucket:left:<id>`
 * through the same ingestion spine a journey trigger binds to.
 *
 * Anatomy of a bucket:
 *   - `meta.id`         the bucket id (also the alias suffix, e.g.
 *                       `bucket:entered:power-users`)
 *   - `meta.enabled`    static load-time on/off (mirrors a journey's `enabled`)
 *   - `meta.criteria`   the membership predicate — the same `ConditionEval` tree
 *                       a journey enrollment/exit condition uses
 *   - `meta.timeBased`  set when criteria use a rolling `within` window so a
 *                       clock change (not an event) can flip membership — the
 *                       reconcile cron then owns the absence leave
 *   - `meta.entryLimit`    "once" | "once_per_period" | "unlimited" — controls when
 *                       a re-join re-emits `bucket:entered`
 *
 * Buckets are observe-only in Studio — there is no visual builder; they live in
 * code, exactly like journeys.
 *
 * Copy this file to add your own buckets, then register them in
 * `src/buckets/index.ts`.
 */
export const powerUsers = defineBucket({
  meta: {
    id: "power-users",
    name: "Power users",
    description: "Used the key feature 10+ times in the last 30 days.",
    enabled: true,
    // Rolling 30-day window → time-based: the reconcile cron sweeps the leave
    // when the window rolls past, since no event signals it.
    timeBased: true,
    entryLimit: "once_per_period",
    entryPeriod: { hours: 24 * 7 },
    criteria: {
      type: "event",
      eventName: Events.FEATURE_USED,
      check: "count",
      operator: "gte",
      value: 10,
      within: { hours: 24 * 30 }, // days(30)
    },
  },
});

// ---------------------------------------------------------------------------
// Reacting to a bucket — colocated `.on()` handlers + member access.
//
// A bucket isn't just a group: each membership change fires a first-class event,
// and `bucket.on(...)` attaches behavior that desugars to a real durable journey
// (full JourneyContext: sleep / when / waitForEvent / guard / history). Uncomment
// to use — a fresh app ships these OFF so it doesn't email power users by default.
//
//   import { days, sendEmail } from "@hogsend/engine";
//   import { Templates } from "../journeys/constants/index.js";
//
//   powerUsers
//     // when they JOIN — ctx.entryCount / ctx.isFirstEntry distinguish re-joins
//     .on("enter", async (user, ctx) => {
//       if (!ctx.isFirstEntry) return;
//       await sendEmail({
//         to: user.email,
//         userId: user.id,
//         journeyStateId: user.stateId,
//         template: Templates.WELCOME, // your template key
//         subject: "You're flying — here's a power tip",
//         journeyName: user.journeyName,
//       });
//     })
//     // every 7 continuous days in the bucket — driven by the reconcile cron
//     .on("dwell", { every: days(7) }, async (user) => {
//       /* weekly power-user digest — ctx.dwellCount = the interval ordinal */
//     })
//     // when they LEAVE — ctx.reason is "criteria" | "maxDwell" | "manual"
//     .on("leave", async (_user, ctx) => {
//       if (ctx.reason === "criteria") {
//         /* they cooled off */
//       }
//     });
//
// Bind another journey to this bucket with the TYPED refs (no string helpers):
//   defineJourney({ meta: { trigger: { event: powerUsers.entered },
//                           exitOn: [{ event: powerUsers.left }] }, run });
//
// Query members anywhere (never an unbounded array):
//   const { data: total } = await powerUsers.count();
//   const { data: isMember } = await powerUsers.has(userId);
//   const page = await powerUsers.members({ limit: 50 }); // { data, cursor, ... }
