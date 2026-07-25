import { days, defineBucket, refineContact } from "@hogsend/engine";
import { Events } from "../journeys/constants/index.js";

/**
 * Example bucket + enter reaction: REFINEMENT. The moment someone hands you a
 * work email — a signup form, a waitlist, one curl to POST /v1/events with
 * `lead.captured` — this bucket admits them and the reaction below asks an
 * enrichment vendor who they are. The answer lands as flat `refined_*`
 * properties on the contact: open the contact in Studio and the job title,
 * company, and employee count are there.
 *
 * Refinement is OPT-IN and completely inert until a provider is configured.
 * Turning it on is two steps:
 *
 *   pnpm add @hogsend/plugin-apollo    # or scaffold with `--with apollo`
 *   APOLLO_API_KEY=...                 # in .env
 *
 * The package must be a DIRECT dependency of THIS app, not just an engine
 * optionalDependency — the app bundles the engine, so the engine's lazy
 * `import("@hogsend/plugin-apollo")` resolves against the app's own
 * node_modules. With no provider, `refineContact()` returns
 * `{ status: "skipped", reason: "no_provider" }`: nothing happened because
 * nothing is configured, not because something is broken.
 *
 * THIS IS THE ONE EXAMPLE IN THE SCAFFOLD THAT SPENDS MONEY. Every vendor
 * lookup is billable. The engine owns the spend controls (documented in
 * .env.example):
 *   - `ENRICHMENT_MONTHLY_LOOKUPS` — hard monthly cap, fails closed. Defaults
 *     to 0, which means UNCAPPED — set it deliberately wherever a key is set.
 *   - `ENRICHMENT_TTL_DAYS` (90) — answers are cached in the enrichment
 *     ledger, misses included, so you never pay twice for the same dead
 *     address.
 *
 * The criteria are deliberately satisfiable by ONE event — unlike
 * `power-users` (10 events over 30 days), which teaches a behavioural pattern
 * but can't be demonstrated with a single request. A lead capture is a
 * moment, not a pattern. No rolling `within` window, so this bucket is not
 * `timeBased` and the reconcile cron never needs to sweep it.
 *
 * `entryLimit: "once_per_period"` because every entry runs the reaction and
 * can spend a lookup — `unlimited` would let one contact re-enter (and
 * re-spend) on every matching event. The 30-day cooldown is shorter than the
 * 90-day TTL, so a re-entry inside the TTL is a `cached` no-spend anyway.
 */
export const qualifiedLeads = defineBucket({
  meta: {
    id: "qualified-leads",
    name: "Qualified leads",
    description:
      "Captured a lead email — refined with vendor intelligence on entry.",
    enabled: true,
    entryLimit: "once_per_period",
    entryPeriod: days(30),
    criteria: (b) => b.event(Events.LEAD_CAPTURED).exists(),
  },
}).on("enter", async (user, ctx) => {
  // WHY an enter reaction and not a journey: refinement is a one-shot data
  // pull at the moment a contact becomes interesting, not a lifecycle
  // conversation. The reaction inherits the bucket's membership decision, so
  // the rule lives in exactly one place — a journey would need its own
  // trigger plus a duplicate of the criteria above.
  //
  // `ctx.once` is the replay guard. A reaction runs as a durable Hatchet
  // task, and a durable task replays from the top on a worker crash or
  // redeploy — without the guard a replay could spend a SECOND vendor
  // lookup. `once` records the first result on this enrollment's state row
  // and replays it verbatim.
  const result = await ctx.once("refine", () =>
    refineContact({ userId: user.id, email: user.email }),
  );

  // `refineContact` NEVER throws — every outcome is a status. Branch on all
  // of them and checkpoint each: the label lands in
  // `journey_states.currentNodeId`, so the outcome is visible in Studio
  // without reading a log.
  switch (result.status) {
    case "refined":
    case "cached":
      // The `refined_*` traits are already on the contact — `refineContact`
      // lands them through the ingest pipeline itself.
      await ctx.checkpoint(`refined:${result.status}`);
      break;
    case "not_found":
      // The vendor has no record of this person. A miss is a PAID answer and
      // is negatively cached, so it will not be re-asked until the TTL rolls.
      await ctx.checkpoint("refine-not-found");
      break;
    default:
      // `skipped` — reason is no_provider / no_lookup_key / budget_exceeded /
      // provider_error / ingest_failed. On a fresh scaffold with no key this
      // is the normal path (`no_provider`): nothing sent, nothing spent.
      await ctx.checkpoint(`refine-skipped:${result.reason ?? "unknown"}`);
      break;
  }
});
