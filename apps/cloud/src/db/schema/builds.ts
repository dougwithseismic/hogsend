import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { environments } from "./environments";
import { stacks } from "./stacks";

/**
 * One publish attempt: an uploaded tarball walked from `queued` to a deployed
 * image (PRD 08).
 *
 * `status` is `text`, not a Postgres enum, unlike `stacks.status`. The build
 * machine is a PIPELINE and its stage list is expected to grow as task 3 lands
 * (a cache-restore stage, a scan stage); a `text` column takes a new stage with
 * no `ALTER TYPE` and no migration ordering hazard, and the vocabulary is still
 * fixed in one place — `BUILD_STATUSES` in `services/builds.ts`, which the
 * `$type` below binds this column to.
 *
 * Status is written ONLY by `BuildService.transition()` (the same law
 * `StackService` holds for stacks): the legal-edge table and the audit row must
 * not be able to come apart.
 */
export const builds = cloud.table(
  "builds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /**
     * The stack this build deploys onto, when there is one. Nullable and
     * `set null` on delete: a build is a record of what a tenant PUBLISHED, and
     * it must outlive a stack that was later destroyed and re-provisioned.
     */
    stackId: uuid("stack_id").references(() => stacks.id, {
      onDelete: "set null",
    }),
    status: text("status")
      .$type<
        | "queued"
        | "building"
        | "preflight"
        | "pushing"
        | "deploying"
        | "succeeded"
        | "failed"
      >()
      .default("queued")
      .notNull(),
    /** From the upload manifest; copied onto the stack at success. */
    engineVersion: text("engine_version"),
    /** `sha256:…` of the pushed image. Set at the push stage. */
    imageDigest: text("image_digest"),
    /**
     * Where the uploaded tarball lives, as a key RELATIVE to
     * `CLOUD_ARTIFACTS_DIR` (`<environmentId>/<buildId>.tar.gz`) rather than an
     * absolute path — the row must stay valid when the volume is remounted
     * somewhere else. `lib/artifacts.ts` owns the one place it is resolved.
     */
    artifactPath: text("artifact_path").notNull(),
    /** The validated upload manifest, verbatim. Carries no secret. */
    manifest: jsonb("manifest")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    /**
     * The LAST ~64KB of build output, not the whole log. A build log is
     * unbounded (docker layer chatter); the tail is what a failure diagnosis
     * actually reads, and bounding it in the UPDATE (`right(… , 65536)`) keeps
     * one runaway build from making the row — and the dashboard — unusable.
     */
    logTail: text("log_tail"),
    /** Why it failed. Set with the terminal `failed` transition. */
    error: text("error"),
    /** When work actually began — null while queued. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** When it reached `succeeded` or `failed`. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // The build-history read: one environment, newest first.
    index("builds_environment_created_at_idx").on(
      table.environmentId,
      sql`${table.createdAt} desc`,
    ),
    /**
     * SINGLE-FLIGHT, in the DATABASE: at most one RUNNING build per
     * environment. Two workers claiming the same environment cannot both move a
     * build out of `queued` — the loser takes a 23505 and leaves its build
     * queued. Nothing about this depends on application-level locking, so a
     * second control-plane replica changes nothing.
     *
     * `queued` is EXCLUDED from the predicate on purpose, and that exclusion is
     * the queue: PRD 08 requires that "a second publish to a busy environment
     * SHALL queue, never race", so waiting rows must be able to exist. What may
     * not exist twice is a build that is actually working — the four middle
     * statuses — because that is what would race one stack.
     *
     * The predicate names the statuses that are NOT running (the two terminal
     * ones, plus `queued`) and negates them, rather than listing the running
     * ones. That way a stage added later to the middle of the pipeline is
     * covered automatically; the failure mode of the other spelling is a
     * silently disabled single-flight, which is the one this index prevents.
     */
    uniqueIndex("builds_environment_running_unique_idx")
      .on(table.environmentId)
      .where(sql`${table.status} not in ('queued', 'succeeded', 'failed')`),
  ],
);
