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
