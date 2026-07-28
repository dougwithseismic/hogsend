import { fileURLToPath } from "node:url";
import type { JourneySourceLocation } from "@hogsend/core";
import { normalizeWhere } from "@hogsend/core";
import type {
  BucketTriggerRef,
  JourneyMeta,
  JourneyMetaInput,
  JourneyRunFn,
} from "@hogsend/core/types";
import {
  createJourneyTask,
  hasJourneyTaskFactory,
  type JourneyTask,
} from "./journey-task-factory.js";
import { computeJourneyVersionHash } from "./journey-version.js";

export interface DefinedJourney {
  meta: JourneyMeta;
  /** Original author function. Testing harnesses execute this directly. */
  run: JourneyRunFn;
  /** Production Hatchet task, materialized eagerly by the runtime or lazily on access. */
  task: JourneyTask;
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

/**
 * The one shape a `trigger.bucket` ref may carry, mirroring the literal type
 * `BucketTriggerRef.entered` declares and the string `defineBucket` derives
 * (`bucket:entered:${meta.id}`). Kept local rather than shared from
 * define-bucket.ts: this module must not take a value import on the bucket
 * layer, which would put the journey seam inside the bucket ESM cycle.
 */
const BUCKET_ENTERED_PREFIX = "bucket:entered:";

/**
 * Collapse the authoring trigger to the ONE plain event string everything
 * downstream understands. A bucket-object trigger is sugar resolved HERE, at
 * the same one-shot seam `normalizeWhere` resolves a builder `where` — before
 * `versionHash` is computed, so a desugared journey hashes byte-identically to
 * a hand-authored one, and before registration, so the registry, Hatchet
 * routing, blueprints, and Studio never learn a second trigger concept.
 *
 * Both forms present, or neither, THROWS: quietly preferring one over the
 * other would reintroduce exactly the silent-miss failure the bucket object
 * exists to eliminate, and a JS caller (or a widened `any`) reaches this
 * function with no type to stop them. A `bucket` whose `entered` is not a
 * `bucket:entered:` ref throws for the same reason.
 *
 * Note what this seam does NOT touch: `trigger.where`. It keeps narrowing on
 * the transition event's own payload (`bucketId`/`userId`/`transition`/
 * `source`/`entryCount`), never the person's properties — see
 * {@link JourneyTriggerInput}.
 */
function resolveTriggerEvent(meta: JourneyMetaInput): string {
  // Widened deliberately: the authoring union already makes the two keys
  // mutually exclusive, which narrows the illegal combination to `never` and
  // would hide it from the guards below. These guards exist for the callers
  // types cannot reach.
  const raw = meta.trigger as {
    event?: string | null;
    bucket?: BucketTriggerRef | null;
  };
  // `null` is folded to `undefined` before the guards run. Without this a
  // `{ bucket: null }` from a JS caller passes `!== undefined` (null is not
  // undefined) and then dereferences `bucket.entered` — crashing with a raw
  // TypeError raised while BUILDING the diagnostic that exists to prevent it.
  const event = raw.event ?? undefined;
  const bucket = raw.bucket ?? undefined;
  if (event !== undefined && bucket !== undefined) {
    throw new Error(
      `defineJourney("${meta.id}"): trigger declares BOTH \`event\` ` +
        `("${event}") and \`bucket\` ("${bucket.entered}"). Declare exactly ` +
        `one — the engine will not pick for you.`,
    );
  }
  if (bucket !== undefined) {
    if (typeof bucket.entered !== "string" || bucket.entered.length === 0) {
      throw new Error(
        `defineJourney("${meta.id}"): trigger.bucket is not a bucket — it ` +
          `has no \`entered\` transition ref. Pass the object defineBucket ` +
          `returned.`,
      );
    }
    // The type demands `bucket:entered:${string}`; this is the same check for
    // the callers types cannot reach. Without it a hand-rolled ref carrying an
    // arbitrary string binds the journey to an event nothing ever emits — the
    // silent miss this key exists to remove, reached through the key itself.
    if (!bucket.entered.startsWith(BUCKET_ENTERED_PREFIX)) {
      throw new Error(
        `defineJourney("${meta.id}"): trigger.bucket is not a bucket — its ` +
          `\`entered\` is "${bucket.entered}", which is not a ` +
          `\`${BUCKET_ENTERED_PREFIX}\` transition ref. Pass the object ` +
          `defineBucket returned.`,
      );
    }
    return bucket.entered;
  }
  if (event !== undefined) return event;
  throw new Error(
    `defineJourney("${meta.id}"): trigger declares neither \`event\` nor ` +
      `\`bucket\`. A journey with no trigger can never enroll anyone.`,
  );
}

export function defineJourney(options: {
  meta: JourneyMetaInput;
  run: JourneyRunFn;
}): DefinedJourney {
  const runSource = safeRunSource(options.run);
  const source = captureCallSite();
  const triggerEvent = resolveTriggerEvent(options.meta);
  const { trigger, exitOn, ...rest } = options.meta;
  const triggerWhere = normalizeWhere(trigger.where);
  const normalized: JourneyMeta = {
    ...rest,
    trigger: {
      event: triggerEvent,
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
  // Impact experiments (Decision A): attach the engine-computed content
  // fingerprint AFTER normalization, so `where` builder fns are already
  // resolved POJOs (the hash input is canonical data, never a function).
  // NEVER authored: the spread overwrites any input value (JourneyMetaInput
  // omits versionHash; JS callers are overridden here). Both the eager task
  // path and the lazy authoring-subpath getter below close over this same
  // meta — executeJourneyRun sees the hash with zero further plumbing.
  const meta: JourneyMeta = {
    ...normalized,
    versionHash: computeJourneyVersionHash({
      meta: normalized,
      body: runSource,
    }),
  };

  const definition = { meta, run: options.run, runSource, source };

  // Main-engine imports install the production task factory before callers can
  // invoke defineJourney, preserving the existing eager task behavior. The
  // environment-free authoring subpath intentionally leaves it uninstalled;
  // its task getter remains dormant in unit tests and materializes after the
  // production runtime is loaded by a worker.
  if (hasJourneyTaskFactory()) {
    return {
      ...definition,
      task: createJourneyTask(meta, options.run),
    };
  }

  let task: JourneyTask | undefined;
  return Object.defineProperty(definition, "task", {
    enumerable: true,
    get: () => {
      task ??= createJourneyTask(meta, options.run);
      return task;
    },
  }) as DefinedJourney;
}
