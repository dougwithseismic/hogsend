import { fileURLToPath } from "node:url";
import type { JourneySourceLocation } from "@hogsend/core";
import { normalizeWhere } from "@hogsend/core";
import type {
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

export function defineJourney(options: {
  meta: JourneyMetaInput;
  run: JourneyRunFn;
}): DefinedJourney {
  const runSource = safeRunSource(options.run);
  const source = captureCallSite();
  const { trigger, exitOn, ...rest } = options.meta;
  const triggerWhere = normalizeWhere(trigger.where);
  const normalized: JourneyMeta = {
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
