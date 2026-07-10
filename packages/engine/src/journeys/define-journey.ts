import { fileURLToPath } from "node:url";
import type { JsonValue } from "@hatchet-dev/typescript-sdk/v1/types.js";
import {
  durationToMs,
  evaluatePropertyConditions,
  type JourneySourceLocation,
  normalizeWhere,
} from "@hogsend/core";
import type {
  JourneyMeta,
  JourneyMetaInput,
  JourneyRunFn,
  JourneyUser,
} from "@hogsend/core/types";
import {
  contacts,
  type Database,
  journeyConfigs,
  journeyStates,
} from "@hogsend/db";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getAnalytics } from "../lib/analytics-singleton.js";
import { getDb } from "../lib/db.js";
import {
  checkEmailPreferences,
  checkEntryLimit,
} from "../lib/enrollment-guards.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger } from "../lib/logger.js";
import { emitOutbound } from "../lib/outbound.js";
import { resolveTimezoneWithSource } from "../lib/timezone.js";
import { getClientScheduleDefaults } from "./client-defaults-singleton.js";
import {
  JOURNEY_EXECUTION_TIMEOUT,
  JOURNEY_SCHEDULE_TIMEOUT,
} from "./constants.js";
import { JourneyExitedError } from "./errors.js";
import {
  createMemoize,
  type JourneyBoundary,
  runWithJourneyBoundary,
  supportsEviction,
} from "./journey-boundary.js";
import { createJourneyContext, TERMINAL_STATUSES } from "./journey-context.js";
import { logTransition } from "./journey-log.js";
import { getJourneyRegistrySingleton } from "./registry-singleton.js";

const logger = createLogger(process.env.LOG_LEVEL);

/**
 * Log whether Hatchet's durable `memo` (Layer-1 fast path) is actually durable
 * on this engine — ONCE per worker process. `supportsEviction === false`
 * (hatchet-lite < v0.80.0) means `memo` silently no-ops, so Layer 2 (the
 * Postgres `email_sends`/`user_events` unique-index dedup) is the sole live
 * guarantee. Surfaced at boot so the team knows which layer is carrying the load.
 */
let evictionSupportLogged = false;
function logEvictionSupportOnce(hatchetCtx: unknown): void {
  if (evictionSupportLogged) return;
  evictionSupportLogged = true;
  const live = supportsEviction(hatchetCtx);
  logger.info(
    live
      ? "journey replay-safety: Layer-1 memo fast path is LIVE (engine supports eviction)"
      : "journey replay-safety: Layer-1 memo is INERT (engine < v0.80.0); " +
          "exactly-once relies on the Layer-2 Postgres unique-index dedup",
  );
}

interface EventPayloadInput {
  userId: JsonValue;
  userEmail: JsonValue;
  properties: JsonValue;
  [key: string]: JsonValue;
}

export interface DefinedJourney {
  meta: JourneyMeta;
  task: ReturnType<typeof hatchet.durableTask>;
  /**
   * The journey's `run` function serialized via `Function.prototype.toString()`,
   * captured at definition time. This is the substrate the Studio journey-graph
   * extractor parses (with acorn) to derive a visual workflow. The bundler never
   * minifies (see `tsup` config), so the string is standard, non-minified JS.
   *
   * Best-effort: `undefined` if serialization throws (some exotic runtimes
   * disallow `.toString()`); the extractor degrades to a meta-only graph. Capture
   * is side-effect-free and must NEVER change execution semantics.
   */
  runSource?: string;
  /**
   * Absolute file path + 1-based line of the consumer's `defineJourney(...)`
   * call, captured from the stack at definition time (for the Studio "open in
   * editor" affordance). Best-effort: `undefined` when unavailable. Capture is
   * side-effect-free and must NEVER change execution semantics.
   */
  source?: JourneySourceLocation;
}

/**
 * Serialize a function to source, never throwing. Some engines can refuse
 * `Function.prototype.toString()` (e.g. bound/native shims); a failure here must
 * degrade to `undefined`, not break `defineJourney`.
 */
function safeRunSource(fn: JourneyRunFn): string | undefined {
  try {
    return fn.toString();
  } catch {
    return undefined;
  }
}

/**
 * Absolute path of THIS module, resolved once. Every stack frame inside
 * define-journey (the capture helper AND `defineJourney` itself) resolves to
 * this path, so the call-site parser skips them and returns the FIRST external
 * frame — the consumer's `defineJourney(...)` site. Works whether the engine
 * runs as `.ts` source (tsx dev, the local dogfood path) or compiled `.js`
 * (dist): self and frames are captured in the same representation.
 */
const SELF_FILE = fileURLToPath(import.meta.url);

/**
 * Capture the consumer's `defineJourney` call-site `{ path, line }` from a fresh
 * stack, so the Studio can deep-link an editor (`cursor://file/<path>:<line>`).
 * Best-effort + side-effect-free: returns `undefined` if the stack is missing
 * or unparseable. NEVER throws and NEVER changes execution semantics.
 *
 * Handles both frame shapes V8 emits:
 *   `at fn (/abs/file.ts:LINE:COL)`   (named — tsx source-mapped, bare path)
 *   `at file:///abs/file.js:LINE:COL` (anonymous top-level — `file://`, no parens)
 * `fileURLToPath` also URL-decodes `file://` paths (spaces, etc). Skips node
 * internals, node_modules, and every frame inside this module (SELF_FILE).
 */
function captureCallSite(): JourneySourceLocation | undefined {
  const original = Error.stackTraceLimit;
  // Default is 10; the external frame sits ~3 deep. Widen defensively for deep
  // re-export/barrel chains, then restore so we don't perturb global behavior.
  Error.stackTraceLimit = 30;
  const stack = new Error().stack;
  Error.stackTraceLimit = original;
  if (!stack) return undefined;

  for (const rawLine of stack.split("\n").slice(1)) {
    const line = rawLine.trim();
    if (!line.startsWith("at ")) continue;

    // Location token = the parenthesized group when present, else the text
    // right after "at " (anonymous frames carry no parens).
    const paren = line.match(/\(([^)]+)\)\s*$/);
    const token = paren?.[1] ?? line.slice(3).trim();

    // Strip the trailing ":line:col" (col optional) to isolate the file part.
    const m =
      token.match(/^(.*?):(\d+):(\d+)$/) ?? token.match(/^(.*?):(\d+)$/);
    const filePart = m?.[1];
    const lineNo = m?.[2];
    if (!filePart || !lineNo) continue;

    let file = filePart;
    if (file.startsWith("file://")) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }

    // First frame that clears all three is the consumer's call site.
    if (file.startsWith("node:")) continue;
    if (file.includes("node_modules")) continue;
    if (file === SELF_FILE) continue;

    return { path: file, line: Number(lineNo) };
  }
  return undefined;
}

/** The `journey_states` row an enrollment insert returns. */
export type JourneyStateRow = typeof journeyStates.$inferSelect;

/**
 * Insert the enrollment row, tolerating the partial-unique-index race between
 * concurrent first events for the same user and journey.
 */
export async function insertEnrollment(opts: {
  db: Database;
  userId: string;
  userEmail: string;
  journeyId: string;
  context: Record<string, unknown>;
  hatchetRunId?: string;
}): Promise<JourneyStateRow | undefined> {
  const [row] = await opts.db
    .insert(journeyStates)
    .values({
      userId: opts.userId,
      userEmail: opts.userEmail,
      journeyId: opts.journeyId,
      currentNodeId: "start",
      status: "active",
      context: opts.context,
      hatchetRunId: opts.hatchetRunId,
    })
    .onConflictDoNothing({
      target: [journeyStates.userId, journeyStates.journeyId],
      where: sql`status IN ('active', 'waiting')`,
    })
    .returning();
  return row;
}

export function defineJourney(options: {
  meta: JourneyMetaInput;
  run: JourneyRunFn;
}): DefinedJourney {
  const runSource = safeRunSource(options.run);
  const source = captureCallSite();
  const { trigger, exitOn, ...rest } = options.meta;
  const triggerWhere = normalizeWhere(trigger.where);
  const meta: JourneyMeta = {
    ...rest,
    trigger: {
      event: trigger.event,
      ...(triggerWhere ? { where: triggerWhere } : {}),
    },
    ...(exitOn
      ? {
          exitOn: exitOn.map((exit) => {
            const exitWhere = normalizeWhere(exit.where);
            return {
              event: exit.event,
              ...(exitWhere ? { where: exitWhere } : {}),
            };
          }),
        }
      : {}),
  };

  const task = hatchet.durableTask({
    name: `journey-${meta.id}`,
    onEvents: [meta.trigger.event],
    executionTimeout: JOURNEY_EXECUTION_TIMEOUT,
    // retries STAYS 0 — deliberately. A retry replays `run()` from the top, and
    // the tracked mailer / connector machinery is "missed > doubled": a `queued`
    // row is RE-DRIVEN and a failed send NULLs its idempotency key (tracked.ts
    // ~150-176, 496-514). That is safe only while nothing re-invokes a run whose
    // `provider.send()` already delivered but whose durable status flip didn't
    // commit — turning retries on would re-deliver that email/connector message
    // (a DUPLICATE). Enabling retries requires making sends provider-idempotent
    // first (Resend/Postmark `Idempotency-Key`); tracked as a follow-up.
    retries: 0,
    // `scheduleTimeout` widens the queue-wait ceiling (SDK default ~5m) so a
    // durable-wait RESUME re-queued during a redeploy's slot saturation reclaims
    // a slot instead of being cancelled (which strands the enrollment). Unlike
    // retries this adds NO replay — it is pure head-room, so it is safe on its own.
    scheduleTimeout: JOURNEY_SCHEDULE_TIMEOUT,
    fn: (input: EventPayloadInput, hatchetCtx) =>
      executeJourneyRun({ meta, run: options.run, input, hatchetCtx }),
  });

  return { meta, task, runSource, source };
}

type DurableTaskFn = NonNullable<
  Parameters<typeof hatchet.durableTask>[0]["fn"]
>;
type HatchetDurableCtx = Parameters<DurableTaskFn>[1];

export type JourneyRunResult =
  | { status: string; reason?: string }
  | { stateId: string; status: string };

/**
 * The journey durable-task body, factored out of {@link defineJourney} so it can
 * be driven by TWO entry points with byte-identical semantics:
 *   1. a per-journey Hatchet task (code journeys + code-array specs), via
 *      `defineJourney` above — dispatched by static `onEvents`;
 *   2. the ONE generic `journeySpecRunner` task (DB-stored specs, Slice 2),
 *      dispatched imperatively by `ingestEvent` with a `meta`/`run` resolved from
 *      the spec at run time.
 *
 * Both paths get the SAME enrollment guards, replay recovery (by the
 * replay-stable Hatchet run id), `journeyStates` lifecycle, exactly-once
 * boundary, and terminal handling — so a DB spec is not a second-class citizen,
 * it is the exact same machine with its `run` supplied from data.
 */
export async function executeJourneyRun(params: {
  meta: JourneyMeta;
  run: JourneyRunFn;
  input: EventPayloadInput;
  hatchetCtx: HatchetDurableCtx;
}): Promise<JourneyRunResult> {
  const { meta, run, input, hatchetCtx } = params;
  const db = getDb();
  const userId = input.userId as string;
  const userEmail = input.userEmail as string;
  const properties = (input.properties ?? {}) as Record<
    string,
    string | number | boolean | null
  >;

  // The replay-stable anchor for this enrollment: the Hatchet run id is
  // preserved across replays of the SAME logical durable run (crash / OOM /
  // eviction / redeploy mid-run), whereas a freshly-minted journeyStates.id
  // is not. Both dedup-key derivation AND the enrollment-recovery below key
  // on it so a replay re-derives the SAME stateId and the SAME keys.
  const workflowRunId = hatchetCtx.workflowRunId();

  // REPLAY RECOVERY — must run BEFORE the enrollment guards below. An
  // eviction-capable Hatchet engine (hatchet-lite >= v0.80.0) replays `fn`
  // from the top on every durable-wait resume, so every statement above the
  // first durable primitive re-runs on each resume. The enrollment guards
  // (entryLimit / preferences / trigger conditions / enabled / active-state)
  // are ENTRY gates: re-running them on a resume is wrong. In particular a
  // `once` journey's own entry-limit guard would find the row it created on
  // first entry and skip EVERY resume, stranding the journey in `waiting` and
  // silently dropping all sends after the first. Recovering by the run-stable
  // id first lets a resume reuse its enrollment and bypass the entry gates (a
  // resume is not an entry). It also keeps the original purpose: a journey
  // whose prior enrollment reached a TERMINAL status (unlimited /
  // once_per_period) recovers the SAME stateId so derived keys still collide.
  const recovered = workflowRunId
    ? await db.query.journeyStates.findFirst({
        where: and(
          eq(journeyStates.hatchetRunId, workflowRunId),
          eq(journeyStates.journeyId, meta.id),
        ),
      })
    : undefined;

  let state = recovered;

  // FIRST ENTRY ONLY — the enrollment guards gate ENTRY, not resume. A
  // recovered enrollment already passed them on first entry, so it skips
  // straight to resuming the run. (Sends inside `run` still re-check
  // subscription via `ctx.guard.isSubscribed()` after every wait, so
  // bypassing the entry-time preference gate never emails an unsubscriber.)
  if (!state) {
    if (!meta.enabled) {
      return { status: "skipped", reason: "journey_disabled" };
    }

    const configOverride = await db.query.journeyConfigs.findFirst({
      where: eq(journeyConfigs.journeyId, meta.id),
    });
    if (configOverride && !configOverride.enabled) {
      return { status: "skipped", reason: "journey_disabled_by_admin" };
    }

    if (meta.trigger.where?.length) {
      if (
        !evaluatePropertyConditions({
          conditions: meta.trigger.where,
          properties,
        })
      ) {
        return { status: "skipped", reason: "trigger_conditions_not_met" };
      }
    }

    const entryAllowed = await checkEntryLimit({
      db,
      journey: meta,
      userId,
    });
    if (!entryAllowed.allowed) {
      return { status: "skipped", reason: entryAllowed.reason };
    }

    const prefs = await checkEmailPreferences({ db, userId });
    if (prefs.unsubscribed) {
      return { status: "skipped", reason: "user_unsubscribed" };
    }

    const activeState = await db.query.journeyStates.findFirst({
      where: and(
        eq(journeyStates.userId, userId),
        eq(journeyStates.journeyId, meta.id),
        inArray(journeyStates.status, ["active", "waiting"]),
      ),
    });
    if (activeState) {
      return { status: "skipped", reason: "already_active" };
    }

    state = await insertEnrollment({
      db,
      userId,
      userEmail,
      journeyId: meta.id,
      context: properties,
      hatchetRunId: workflowRunId,
    });
    if (!state) {
      return { status: "skipped", reason: "already_active" };
    }
  }

  const stateId = state.id;

  // Fire-and-forget enrollment transition (FRESH entry only — a replay
  // recovers `state` by run id above and must NOT re-log an entry). Writes
  // `journey_logs` best-effort; never throws into / alters execution.
  if (!recovered) {
    logTransition({
      db,
      journeyStateId: stateId,
      from: null,
      to: "start",
      action: "entered",
    });
  }

  // The replay-stable key anchor: prefer the run id (constant across replays
  // of this run), fall back to stateId when the engine has no run id.
  const runAnchor = workflowRunId || stateId;

  const user: JourneyUser = {
    id: userId,
    email: userEmail,
    properties,
    stateId,
    journeyId: meta.id,
    journeyName: meta.name,
  };

  // The injected analytics instance (set by createHogsendClient). Same
  // object as container.analytics; undefined when POSTHOG_API_KEY is unset.
  const posthog = getAnalytics();
  const scheduleDefaults = getClientScheduleDefaults();

  // Resolve the user's timezone via the precedence chain (explicit is N/A
  // at enrollment; PostHog person props → contacts row → client default →
  // UTC). Best-effort: failures fall through to the client default tz.
  // Independent I/O — fetch the contact row and PostHog person props
  // concurrently. PostHog failures fall through to undefined.
  const [contact, posthogProperties] = await Promise.all([
    // Both legs are best-effort tz inputs: a failure here must fall through
    // to the client-default tz, never reject the `Promise.all` and throw out
    // of `fn` BEFORE the try/catch below (which would strand the row —
    // already inserted "active" — outside the failure handling). The PostHog
    // leg already `.catch`es; mirror it on the contact read.
    db.query.contacts
      .findFirst({ where: eq(contacts.externalId, userId) })
      .catch(() => undefined),
    posthog?.getPersonProperties(userId).catch(() => undefined),
  ]);

  const tz = resolveTimezoneWithSource({
    posthogProperties,
    contactTimezone: contact?.timezone ?? null,
    contactProperties: contact?.properties ?? null,
    defaultTimezone: scheduleDefaults.timezone,
    logger,
  });

  // Opportunistic cache write: when the tz came from a PostHog source and
  // the contacts.timezone column is empty, persist it (fire-and-forget;
  // PostHog/JSONB remain authoritative so nothing blocks on the column).
  if (
    (tz.source === "posthog_timezone" || tz.source === "posthog_geoip") &&
    contact &&
    !contact.timezone
  ) {
    db.update(contacts)
      .set({ timezone: tz.timezone, updatedAt: new Date() })
      .where(eq(contacts.id, contact.id))
      .catch(() => {
        // best-effort cache write; never block the journey
      });
  }

  const ctx = createJourneyContext({
    db,
    hatchet,
    // The real DurableContext structurally satisfies the (widened) config —
    // it exposes `sleepFor`/`waitFor` AND a replay-memoized `now()` (SDK
    // 1.22.3). Forwarding it whole lets ctx clock reads (ctx.when,
    // sleepUntil delta, lookback, ctx.now) read the memoized clock on an
    // eviction-capable engine, falling back to the live clock pre-eviction.
    hatchetCtx,
    registry: getJourneyRegistrySingleton(),
    logger,
    stateId,
    userId,
    userEmail,
    journeyContext: { ...properties },
    resolvedTimezone: tz.timezone,
    defaultSendWindow: scheduleDefaults.sendWindow,
    triggerEvent: meta.trigger.event,
    ...(meta.trigger.where ? { triggerWhere: meta.trigger.where } : {}),
    journeyId: meta.id,
    entryLimit: meta.entryLimit,
    ...(meta.entryPeriod ? { entryPeriod: meta.entryPeriod } : {}),
  });

  // The journey boundary makes journey side effects (sendEmail, ctx.trigger)
  // EXACTLY-ONCE across a durable replay WITHOUT any change to journey
  // authoring. It is established once around `run()`: a replay-from-top
  // re-enters this scope from the top. Its `runAnchor` is the replay-stable
  // Hatchet run id (recovered above so the SAME stateId is reused on replay),
  // so the derived keys collide across a replay of the same run even if the
  // enrollment row had to be recovered rather than freshly inserted.
  // `memoize` is the Layer-1 fast path (durable only when the engine supports
  // eviction); the auto-derived `email_sends`/`user_events` idempotency keys
  // (anchored on `runAnchor`) are the version-independent Layer-2 guarantee.
  logEvictionSupportOnce(hatchetCtx);
  const boundary: JourneyBoundary = {
    stateId,
    runAnchor,
    currentLabel: undefined,
    seenKeys: new Set<string>(),
    seenRecordLabels: new Set<string>(),
    memoize: createMemoize(hatchetCtx),
    journeyId: meta.id,
    suppressMs: meta.suppress ? durationToMs(meta.suppress) : 0,
  };

  // Seed the context's memoized-clock snapshot ONCE before run() so a
  // `ctx.when` chain used BEFORE the first durable step reads a replay-stable
  // instant (on an eviction engine) instead of the construction-time
  // `new Date()` seed. Best-effort: on a pre-eviction engine this reads the
  // live clock, same as before.
  await ctx.now();

  try {
    await runWithJourneyBoundary(boundary, () => run(user, ctx));

    const completedAt = new Date();
    await db
      .update(journeyStates)
      .set({
        status: "completed",
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(journeyStates.id, stateId));

    // Fire-and-forget completion transition (best-effort; never throws).
    logTransition({
      db,
      journeyStateId: stateId,
      from: boundary.currentLabel ?? null,
      to: "end-completed",
      action: "completed",
    });

    await hatchet.events.push("journey:completed", {
      journeyId: meta.id,
      stateId,
      userId,
    });

    // OUTBOUND `journey.completed` — fired alongside the internal
    // `journey:completed` push. Runs in the WORKER (this durable task), so it
    // uses the engine `db`/`hatchet`/`logger` singletons. `dedupeKey` =
    // `journey.completed:<stateId>`: a Hatchet re-execution recomputes the
    // identical key and the unique `(endpointId, dedupeKey)` index absorbs the
    // duplicate (risk 3). `journey:failed` is NOT in the catalog → no emit.
    void emitOutbound({
      db,
      hatchet,
      logger,
      event: "journey.completed",
      dedupeKey: `journey.completed:${stateId}`,
      payload: {
        journeyId: meta.id,
        journeyName: meta.name,
        stateId,
        userId,
        userEmail,
        completedAt: completedAt.toISOString(),
      },
    }).catch(logger.warn);

    return { stateId, status: "completed" };
  } catch (err) {
    // The journey reached a terminal state (exitOn / cancel) while suspended
    // in a durable wait. The state row is already terminal — stop gracefully
    // without marking it "failed" or re-pushing a journey:failed event.
    if (err instanceof JourneyExitedError) {
      return { stateId, status: "exited" };
    }

    const isAbort =
      (err instanceof Error &&
        (err.name === "AbortError" ||
          (err as { code?: string }).code === "ABORT_ERR")) ||
      (
        hatchetCtx as {
          abortController?: { signal?: { aborted?: boolean } };
        }
      ).abortController?.signal?.aborted === true;

    if (isAbort) {
      const current = await db.query.journeyStates.findFirst({
        where: eq(journeyStates.id, stateId),
        columns: { status: true },
      });
      const status = current?.status;
      if (status && (TERMINAL_STATUSES as readonly string[]).includes(status)) {
        return { stateId, status: "exited" };
      }
      logger.info(
        "journey run released mid-wait (worker shutdown/reassignment); " +
          "enrollment left intact for re-dispatch",
        { journeyId: meta.id, stateId, status },
      );
      throw err;
    }

    const message =
      err instanceof Error ? err.message : "Unknown error during journey";

    // Mark "failed" ONLY if the row isn't already terminal. A run cancelled
    // by exitOn (ingestEvent sets "exited" then `runs.cancel`) or by the
    // admin route surfaces here as a Hatchet AbortError thrown from the
    // suspended waitFor/sleepFor — NOT a JourneyExitedError. Guarding on a
    // non-terminal status prevents clobbering that "exited" row to "failed"
    // and emitting a spurious journey:failed event.
    const [failed] = await db
      .update(journeyStates)
      .set({
        status: "failed",
        errorMessage: message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(journeyStates.id, stateId),
          notInArray(journeyStates.status, [...TERMINAL_STATUSES]),
        ),
      )
      .returning({ id: journeyStates.id });

    if (!failed) {
      // Already terminal (cancelled after exit) — swallow the cancellation
      // so the run doesn't double-report as failed.
      return { stateId, status: "exited" };
    }

    logger.error("Journey run failed", {
      journeyId: meta.id,
      journeyName: meta.name,
      stateId,
      userId,
      error: message,
    });

    // Fire-and-forget failure transition — only reached when a row was
    // actually flipped to "failed" (the guard above). `to` is the best-effort
    // last durable node (approximate — see plan Guardrails). Never throws.
    logTransition({
      db,
      journeyStateId: stateId,
      from: null,
      to: boundary.currentLabel ?? state.currentNodeId ?? null,
      action: "failed",
      detail: { error: message },
    });

    await hatchet.events.push("journey:failed", {
      journeyId: meta.id,
      stateId,
      userId,
      error: message,
    });

    throw err;
  }
}
