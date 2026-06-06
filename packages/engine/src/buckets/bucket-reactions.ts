import type { DurationObject } from "@hogsend/core";
import { durationToMs } from "@hogsend/core";
import type {
  JourneyContext,
  JourneyMeta,
  JourneyUser,
} from "@hogsend/core/types";
import {
  type DefinedJourney,
  defineJourney,
} from "../journeys/define-journey.js";
import type { DefinedBucket } from "./define-bucket.js";

/**
 * Why a reaction reaches for THIS leave reason. Carried on the emitted
 * `bucket:left:<id>` event properties and surfaced to a `leave` handler as
 * `ctx.reason`. `"manual"` is reserved for a future force-leave path.
 */
export type BucketLeaveReason = "criteria" | "maxDwell" | "manual";

/** `bucket.on("enter", opts?, handler)` options. */
export interface EnterOptions {
  /**
   * Only run the handler on the user's FIRST entry to this bucket (re-entries
   * are skipped). Re-entry is a FILTER, never a separate event — the filter runs
   * inside `run` AFTER enrollment (a filtered-out entry still writes a short
   * active→completed `journeyStates` row).
   */
  firstEntryOnly?: boolean;
}

/** `bucket.on("leave", opts?, handler)` options. */
export interface LeaveOptions {
  /**
   * Only run the handler when the leave matches this reason (or one of these
   * reasons). Filter runs inside `run` AFTER enrollment.
   */
  reason?: BucketLeaveReason | BucketLeaveReason[];
}

/**
 * `bucket.on("dwell", opts, handler)` options — exactly one of `after`/`every`.
 *  - `after`: one-shot, fires once when the member has dwelt continuously for
 *    the duration.
 *  - `every`: recurring, fires (coalescing) once per elapsed interval.
 */
export type DwellOptions =
  | { after: DurationObject; every?: never }
  | { every: DurationObject; after?: never };

/**
 * Reaction-specific read-only extras layered onto the canonical
 * `JourneyContext` for the handler, discriminated by the reaction kind.
 */
export type ReactionExtras<K> = K extends "enter"
  ? { entryCount: number; isFirstEntry: boolean }
  : K extends "leave"
    ? { reason: BucketLeaveReason }
    : { dwellCount: number };

/** The ctx a reaction handler receives: full JourneyContext + kind extras. */
export type BucketReactionCtx<K extends "enter" | "leave" | "dwell"> =
  JourneyContext & ReactionExtras<K>;

/** A bucket-reaction handler — same `(user, ctx)` shape as a journey `run`. */
export type BucketOnHandler<K extends "enter" | "leave" | "dwell"> = (
  user: JourneyUser,
  ctx: BucketReactionCtx<K>,
) => Promise<void>;

/** Coerce a single value or array to an array. */
export function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Stable, schedule-unique label for a dwell reaction: `after-<ms>` / `every-<ms>`.
 * Hatchet keys workflows by `journey-${id}`, so two dwell reactions on one bucket
 * (one `after`, one `every`) get distinct, boot-stable ids/events.
 */
export function dwellLabel(opts: DwellOptions): string {
  return opts.after != null
    ? `after-${durationToMs(opts.after)}`
    : `every-${durationToMs(opts.every)}`;
}

/** The schema persisted on the reaction meta (read by the dwell cron). */
export function parseDwellSchedule(opts: DwellOptions): {
  label: string;
  after?: number;
  every?: number;
} {
  return opts.after != null
    ? { label: dwellLabel(opts), after: durationToMs(opts.after) }
    : { label: dwellLabel(opts), every: durationToMs(opts.every) };
}

/** Derive the generated reaction journey id from the bucket id + kind. */
export function reactionJourneyId(
  bucketId: string,
  kind: "enter" | "leave" | "dwell",
  opts: EnterOptions | LeaveOptions | DwellOptions | undefined,
): string {
  return kind === "dwell"
    ? `bucket-${bucketId}-on-dwell-${dwellLabel(opts as DwellOptions)}`
    : `bucket-${bucketId}-on-${kind}`;
}

/**
 * Discriminate the `(opts?, handler)` overload by argument type: a function in
 * the first slot is the handler (opts undefined); an object in the first slot is
 * opts and the second slot is the handler. For `dwell`, opts is mandatory and
 * must carry exactly one of `after`/`every` — a `TypeError` otherwise.
 */
export function normalizeOnArgs(
  kind: "enter" | "leave" | "dwell",
  a: unknown,
  b?: unknown,
): {
  opts: EnterOptions | LeaveOptions | DwellOptions | undefined;
  handler: BucketOnHandler<"enter" | "leave" | "dwell">;
} {
  let opts: EnterOptions | LeaveOptions | DwellOptions | undefined;
  let handler: BucketOnHandler<"enter" | "leave" | "dwell">;

  if (typeof a === "function") {
    opts = undefined;
    handler = a as BucketOnHandler<"enter" | "leave" | "dwell">;
  } else {
    opts = a as EnterOptions | LeaveOptions | DwellOptions | undefined;
    handler = b as BucketOnHandler<"enter" | "leave" | "dwell">;
  }

  if (typeof handler !== "function") {
    throw new TypeError(`bucket.on("${kind}") requires a handler function`);
  }

  if (kind === "dwell") {
    const dwell = opts as DwellOptions | undefined;
    const hasAfter = dwell?.after != null;
    const hasEvery = dwell?.every != null;
    if (hasAfter === hasEvery) {
      throw new TypeError(
        'bucket.on("dwell") requires exactly one of `after` or `every`',
      );
    }
  }

  return { opts, handler };
}

/**
 * Desugar `bucket.on(kind, opts?, handler)` to a real `defineJourney` output
 * tagged with `sourceBucketId` + `reactionKind`. The reaction IS a journey, so
 * it inherits the entire enrollment guard stack, the active-state dedup, the
 * durable context, and event routing for free.
 *
 * The handler ctx is built by SPREAD (`{ ...ctx, ...extras }`), never by
 * mutating the engine's canonical ctx (which is shared/closed). The
 * `firstEntryOnly`/`reason` filters run inside `run` AFTER enrollment.
 */
export function buildBucketReaction(args: {
  bucket: DefinedBucket;
  kind: "enter" | "leave" | "dwell";
  opts: EnterOptions | LeaveOptions | DwellOptions | undefined;
  handler: BucketOnHandler<"enter" | "leave" | "dwell">;
}): DefinedJourney {
  const { bucket, kind, opts, handler } = args;

  const triggerEvent =
    kind === "enter"
      ? bucket.entered
      : kind === "leave"
        ? bucket.left
        : `bucket:dwell:${bucket.meta.id}:${dwellLabel(opts as DwellOptions)}`;

  const meta: JourneyMeta = {
    id: reactionJourneyId(bucket.meta.id, kind, opts),
    name: `${bucket.meta.name} — on ${kind}`,
    enabled: bucket.meta.enabled,
    trigger: { event: triggerEvent },
    // Re-entry is a FILTER, never gated here.
    entryLimit: "unlimited",
    // Reactions intentionally have no re-entry cool-down.
    suppress: { seconds: 0 },
    sourceBucketId: bucket.meta.id,
    reactionKind: kind,
    ...(kind === "dwell"
      ? { dwellSchedule: parseDwellSchedule(opts as DwellOptions) }
      : {}),
  };

  return defineJourney({
    meta,
    run: async (user, ctx) => {
      const p = user.properties;
      if (kind === "enter") {
        const entryCount = Number(p.entryCount ?? 1);
        const isFirstEntry = entryCount === 1;
        if (
          (opts as EnterOptions | undefined)?.firstEntryOnly &&
          !isFirstEntry
        ) {
          return;
        }
        await (handler as BucketOnHandler<"enter">)(user, {
          ...ctx,
          entryCount,
          isFirstEntry,
        });
      } else if (kind === "leave") {
        const reason = (p.reason as BucketLeaveReason) ?? "criteria";
        const want = (opts as LeaveOptions | undefined)?.reason;
        if (want && !asArray(want).includes(reason)) return;
        await (handler as BucketOnHandler<"leave">)(user, { ...ctx, reason });
      } else {
        const dwellCount = Number(p.dwellCount ?? 1);
        await (handler as BucketOnHandler<"dwell">)(user, {
          ...ctx,
          dwellCount,
        });
      }
    },
  });
}
