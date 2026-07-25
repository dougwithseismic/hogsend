import { days } from "@hogsend/core";
import { defineBucket, refineContact } from "@hogsend/engine";
import { Events } from "../journeys/constants/index.js";

/**
 * Behavioural intent — repeated key actions in the last 30 days PLUS at least
 * one commercial signal (a paid feature hit a gate, or the product delivered
 * something the account can put a number on). That pairing is what a GTM
 * engineer recognises as "worth a human"; usage alone is not.
 *
 * Time-based (rolling 30-day window) so the reconcile cron sweeps a contact back
 * out when the window decays — the same shape as `power-users`.
 *
 * `entryLimit: "once_per_period"` with a 30-day `entryPeriod` is the defensible
 * choice because EVERY entry can spend a vendor lookup. `unlimited` would let a
 * contact flapping around the threshold re-enter (and re-spend) on every ingest.
 * `once` would be too tight: a contact who went quiet for a year and came back
 * hot is worth re-refining, because their title and company almost certainly
 * moved. 30 days is far shorter than the enrichment TTL (`ENRICHMENT_TTL_DAYS`,
 * 90 by default), so a re-entry inside the TTL is a `cached` no-spend anyway —
 * the cooldown is bounding REACTION RUNS, and the ledger bounds the money.
 */
export const gtmHighIntent = defineBucket({
  meta: {
    id: "gtm-high-intent",
    name: "GTM high intent",
    description:
      "5+ key actions in the last 30 days plus a commercial signal (paid-feature gate or delivered value).",
    enabled: true,
    timeBased: true,
    entryLimit: "once_per_period",
    entryPeriod: days(30),
    criteria: (b) =>
      b.all(
        b.event(Events.KEY_ACTION).within(days(30)).atLeast(5),
        b.any(
          b.event(Events.PAID_FEATURE_ATTEMPTED).within(days(30)).atLeast(1),
          b.event(Events.VALUE_DELIVERED).within(days(30)).atLeast(1),
        ),
      ),
  },
}).on("enter", async (user, ctx) => {
  // WHY a bucket enter reaction and not a journey:
  //
  // Refinement is not a lifecycle conversation, it is a one-shot data pull that
  // must happen at the exact instant a contact becomes commercially interesting.
  // A journey would need its own trigger event, its own entry guards, and its
  // own duplicate of this bucket's criteria — three copies of one rule. The
  // reaction inherits the bucket's membership decision, so the criteria live in
  // exactly one place, and the enter transition is already the moment we mean.
  //
  // A reaction handler still runs inside a real, replayable journey run: `ctx`
  // is a full `JourneyContext`, so `ctx.once` is available and the durable
  // primitives behave exactly as they do in a hand-written journey.
  //
  // `ctx.once` is the replay guard (PRD 07 AC 1). A Hatchet run replays from the
  // top on a worker crash / OOM / redeploy; without it, a replay would re-enter
  // this handler and could spend a second vendor lookup. `once` records the
  // FIRST result under `journey_states.context.__once__` and replays it verbatim
  // for the life of this enrollment. The key is a plain literal because the once
  // bag is already scoped to this enrollment's state row.
  const result = await ctx.once("refine", () =>
    refineContact({ userId: user.id, email: user.email }),
  );

  // `refineContact` NEVER throws — every failure mode comes back as a status.
  // Branch on it rather than assuming a payload: a `skipped` (no provider,
  // budget cap, vendor 5xx) or a `not_found` is a normal outcome, and letting it
  // fall through unhandled would poison a run that has nothing wrong with it.
  switch (result.status) {
    case "refined":
    case "cached":
      // The traits are already on `contacts.properties` — `refineContact` wrote
      // them through `ingestEvent`, which re-ran `checkBucketMembership`. There
      // is nothing to write here; the next hop of the loop is the nightly score.
      await ctx.checkpoint(`refined:${result.status}`);
      break;
    case "not_found":
      // The vendor has no record of this person. The negative result is cached
      // in the ledger, so we will not pay to ask again until it expires.
      await ctx.checkpoint("refine-not-found");
      break;
    default:
      // `skipped` — reason is one of no_provider / no_lookup_key /
      // budget_exceeded / provider_error / ingest_failed. Observability only;
      // the contact stays in the bucket and a later entry can retry.
      await ctx.checkpoint(`refine-skipped:${result.reason ?? "unknown"}`);
      break;
  }
});
