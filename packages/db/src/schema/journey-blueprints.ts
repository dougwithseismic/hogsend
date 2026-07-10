import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import {
  journeyBlueprintSourceEnum,
  journeyBlueprintStatusEnum,
  journeyEntryLimitEnum,
} from "./enums.js";

/**
 * Duration shape mirroring @hogsend/core's `DurationObject`. The db package
 * cannot import @hogsend/core (core depends on db), so the tiny stable shape
 * is mirrored structurally here — same convention as `campaigns.steps`.
 */
type DurationShape = {
  hours?: number;
  minutes?: number;
  seconds?: number;
};

/**
 * Journey Blueprints — journeys authored as DATA (a typed JSON graph) instead
 * of code, stored here and executed by the generic interpreter task. The
 * row's trigger/entry/exit/suppress columns mirror `JourneyMeta` 1:1 so the
 * interpreter hands them straight to the SAME enrollment-guard functions
 * `defineJourney` uses (spec §4/§6).
 *
 * `triggerEvent`/`status` are lifted OUT of the graph JSON so ingest dispatch
 * (`checkBlueprintTriggers`, spec §5) can index/filter candidates on every
 * event without deserializing graphs.
 *
 * jsonb columns are typed opaquely: this package cannot import @hogsend/core
 * (core depends on db), so the engine narrows them at read time —
 * `triggerWhere` → `PropertyCondition[]`, `graph` → `BlueprintGraph`
 * (validated by `validateBlueprintGraph` at every write, spec §7/§8).
 */
export const journeyBlueprints = pgTable(
  "journey_blueprints",
  {
    /** Same namespace as JourneyMeta.id — journeyStates.journeyId points here. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    status: journeyBlueprintStatusEnum("status").notNull().default("draft"),
    /**
     * Bumped on every graph edit. In-flight runs pin the version they
     * enrolled under via journeyStates.context.__blueprintVersion (spec §4),
     * so editing a live blueprint never changes runs already in progress.
     */
    version: integer("version").notNull().default(1),

    /** Mirror of JourneyMeta.trigger.event — the dispatch filter key. */
    triggerEvent: text("trigger_event").notNull(),
    /** PropertyCondition[] (engine narrows; opaque here). */
    triggerWhere:
      jsonb("trigger_where").$type<Array<Record<string, unknown>>>(),
    entryLimit: journeyEntryLimitEnum("entry_limit").notNull(),
    /** DurationObject for entryLimit: "once_per_period". */
    entryPeriod: jsonb("entry_period").$type<DurationShape>(),
    /** JourneyMeta["exitOn"]: [{ event, where?: PropertyCondition[] }]. */
    exitOn:
      jsonb("exit_on").$type<
        Array<{ event: string; where?: Array<Record<string, unknown>> }>
      >(),
    /** DurationObject; {} disables — same contract as JourneyMeta.suppress. */
    suppress: jsonb("suppress").$type<DurationShape>().notNull(),

    /**
     * The BlueprintGraph (execution-tier JourneyGraph). NEVER written without
     * passing `validateBlueprintGraph` (@hogsend/core) — the save-time
     * validation is the sandbox boundary of the whole feature (spec §8).
     */
    graph: jsonb("graph")
      .$type<{
        journeyId: string;
        nodes: Array<Record<string, unknown>>;
        edges: Array<Record<string, unknown>>;
        degraded?: boolean;
        warnings?: string[];
      }>()
      .notNull(),

    /** Which surface authored it — provenance for Studio oversight (spec §10). */
    source: journeyBlueprintSourceEnum("source").notNull(),
    /** Actor id/label — which agent/user/MCP session authored it. */
    createdBy: text("created_by"),

    /** Set once promote-to-code (spec §11) lands a real journey; blueprint is then disabled. */
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    promotedToJourneyId: text("promoted_to_journey_id"),

    ...timestamps,
  },
  (table) => [
    // checkBlueprintTriggers runs on EVERY ingested event:
    // WHERE trigger_event = $1 AND status = 'enabled' (spec §5).
    index("journey_blueprints_trigger_event_status_idx").on(
      table.triggerEvent,
      table.status,
    ),
  ],
);
