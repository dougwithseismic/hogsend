import { fileURLToPath } from "node:url";
import type { JourneySourceLocation } from "@hogsend/core";
import { normalizeWhere } from "@hogsend/core";
import type {
  JourneyMeta,
  JourneyMetaInput,
  JourneyRunFn,
} from "@hogsend/core/types";
import { hatchet } from "../lib/hatchet.js";
import {
  JOURNEY_EXECUTION_TIMEOUT,
  JOURNEY_SCHEDULE_TIMEOUT,
} from "./constants.js";
import {
  type EventPayloadInput,
  executeJourneyRun,
} from "./execute-journey-run.js";

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
    // The full enrollment + run lifecycle lives in `executeJourneyRun`, shared
    // verbatim with the blueprint interpreter task (spec §6) — code journeys
    // and blueprints execute through the IDENTICAL machinery.
    fn: async (input: EventPayloadInput, hatchetCtx) =>
      executeJourneyRun({
        meta,
        run: options.run,
        input,
        hatchetCtx,
      }),
  });

  return { meta, task, runSource, source };
}
