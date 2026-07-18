import { createHash } from "node:crypto";
import type { JourneyMeta } from "@hogsend/core/types";
import { stableStringify } from "../lib/stable-stringify.js";

/**
 * Bump when normalization/hash-input rules change. Forks every hash exactly
 * once on upgrade (a global, labeled refork — honest and self-documenting).
 * FROZEN COMPATIBILITY CONTRACT (replay law) locked by the golden-value
 * tests in journey-version.test.ts.
 */
const HASH_INPUT_VERSION = "hsv1";

type ScanState =
  | "code"
  | "single"
  | "double"
  | "template"
  | "lineComment"
  | "blockComment";

/**
 * Deterministic, dependency-free normalization of a Function.prototype
 * .toString() capture, so formatting- and comment-only edits do not fork a
 * version cohort:
 *  1. strip // line and block comments with a string-aware single-pass
 *     scanner (states: code | single | double | template | lineComment |
 *     blockComment; a \ inside any string state consumes the next char;
 *     each stripped comment is replaced by one space),
 *  2. collapse every whitespace run to a single space, trim.
 * KNOWN LIMITS (documented, deterministic): (a) a // inside a regex literal
 * is misread as a comment start and mangles the rest of that line; (b) the
 * scanner exits `template` state at the first backtick, so a nested
 * template or a string/comment inside ${...} is misclassified. In both
 * cases the output is still a pure function of the input, so the hash
 * stays stable — the only cost is fork-detection fidelity on those lines.
 * Never throws; empty input → "".
 */
export function normalizeRunSource(source: string): string {
  let out = "";
  let state: ScanState = "code";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] as string;
    const next = source[i + 1];
    switch (state) {
      case "code":
        if (ch === "/" && next === "/") {
          state = "lineComment";
          i++;
        } else if (ch === "/" && next === "*") {
          state = "blockComment";
          i++;
        } else {
          out += ch;
          if (ch === "'") state = "single";
          else if (ch === '"') state = "double";
          else if (ch === "`") state = "template";
        }
        break;
      case "single":
      case "double":
      case "template":
        out += ch;
        if (ch === "\\") {
          if (next !== undefined) {
            out += next;
            i++;
          }
        } else if (
          (state === "single" && ch === "'") ||
          (state === "double" && ch === '"') ||
          (state === "template" && ch === "`")
        ) {
          state = "code";
        }
        break;
      case "lineComment":
        if (ch === "\n") {
          out += " ";
          state = "code";
        }
        break;
      case "blockComment":
        if (ch === "*" && next === "/") {
          out += " ";
          state = "code";
          i++;
        }
        break;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Content fingerprint of one journey version: sha256, first 12 hex chars
 * (48 bits — per-journey version counts are tiny; collision negligible).
 * Input = HASH_INPUT_VERSION + "\n" + normalizeRunSource(body ?? "") +
 * "\n" + stableStringify(hashable meta).
 *
 * Hashable meta = the meta MINUS `enabled` (toggling — including the
 * journey_configs admin override — is not a content change), `version`
 * (display label), `versionHash` (self), `name`, `description` (display
 * only — display fields don't fork cohorts; this exclusion list is FROZEN
 * at first release, since changing it later reforks every journey once).
 * Everything else is included BY DEFAULT via rest-destructuring — id,
 * trigger, entryLimit, entryPeriod, exitOn, category, suppress, holdout,
 * goal, sourceBucketId, reactionKind, dwellSchedule, and any FUTURE meta
 * field — because missing a real behavior change is worse than a spurious
 * fork.
 *
 * For blueprints, `body` is stableStringify(row.graph), which ALSO passes
 * through normalizeRunSource. Safe: stableStringify emits no whitespace or
 * comments outside JSON strings, and // inside double-quoted string values
 * (URLs in graph node config) is protected by the string-aware scanner,
 * including \" escapes.
 *
 * ACCEPTED HASH CHURN ACROSS BUILD MODES: runSource is captured from the
 * RUNNING artifact (define-journey.ts) — tsx dev output differs from the
 * consumer tsup bundle, and esbuild identifier aliasing / toolchain-bump
 * emit drift can fork a prod cohort once with zero content change.
 * Accepted: forks are append-only cohort noise; labels give continuity.
 * All readout/digest consumers MUST treat a new hash as "possible new
 * version", never proof of change.
 *
 * TEMPLATE EDITS ARE NOT IN THE HASH: email template components (the
 * consumer's src/emails/*.tsx) are referenced by registry KEY, and that
 * key is all the run source carries — rewriting template copy forks NO
 * cohort. Documented operator practice: bump `meta.version` (the display
 * label) when you rework a template; the impact digest reports a label
 * change as a first-class shipped signal (change: "new_label"). The real
 * fix — folding a rendered-template-registry hash into the body input —
 * is an explicit out-of-scope follow-up.
 *
 * Determinism: `where` builder fns are resolved ONCE into POJOs by
 * normalizeWhere at defineJourney time, so the hashed meta is canonical
 * data, never a function; stableStringify sorts keys and drops undefined,
 * so key order and optional-field spreading cannot churn the hash. NO RNG,
 * NO clock (the replay law).
 */
export function computeJourneyVersionHash(opts: {
  meta: JourneyMeta;
  /** runSource for code journeys; stableStringify(graph) for blueprints. */
  body?: string;
}): string {
  const {
    enabled: _e,
    version: _v,
    versionHash: _h,
    name: _n,
    description: _d,
    ...hashable
  } = opts.meta;
  const body = opts.body ? normalizeRunSource(opts.body) : "";
  return createHash("sha256")
    .update(`${HASH_INPUT_VERSION}\n${body}\n${stableStringify(hashable)}`)
    .digest("hex")
    .slice(0, 12);
}
