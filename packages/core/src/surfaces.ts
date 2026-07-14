/**
 * Surfaces — the author API for declaring external touchpoints (docs, the
 * marketing site, a course, the consumer's own server app) as flow-map nodes
 * (control room, issue #485, P3).
 *
 * A surface is DATA, not a function — the same law as {@link JourneyWhere}: the
 * classifier is compiled twice (TS for the live path, SQL for the windowed
 * aggregate) from ONE ordered rule list, and the two compilations must never
 * disagree. There is nothing to disagree about because the match spec carries
 * no code: exact events, event prefixes, ingest source, and a small
 * SQL-compilable `where` over TOP-LEVEL event properties.
 *
 * Precedence inside the classifier's P3 seam (below funnel triggers, above the
 * builtin revenue node): exact events first, then event prefixes (LONGEST
 * prefix wins across all surfaces), then source (+`where`). See
 * `flow-topology.ts` for the full ladder.
 */

/** Lifecycle column a surface node is drawn in — the flow map's x-axis. This
 * is the single source of truth; the engine re-exports it so
 * `import { SurfaceTier } from "@hogsend/engine"` keeps working. */
export const SURFACE_TIERS = [
  "acquisition",
  "activation",
  "retention",
  "revenue",
] as const;

export type SurfaceTier = (typeof SURFACE_TIERS)[number];

/** Operators the `where` refinement supports — the SQL-compilable subset. */
export type SurfaceWhereOperator =
  | "eq"
  | "neq"
  | "exists"
  | "not_exists"
  | "contains";

/**
 * One refinement over a top-level event property. `value` is required for
 * `eq`/`neq`/`contains` and ignored for `exists`/`not_exists`.
 *
 * STRING COMPARISONS ONLY: `eq`/`neq`/`contains` match a property only when its
 * stored value is a JSON string — a number or boolean never matches, in BOTH
 * the live (TS) and windowed (SQL) classifiers. This is deliberate: Postgres
 * prints jsonb numbers canonically (`1e21` → `'1000000000000000000000'`), which
 * a JS `String()` can't reproduce, so numeric comparison could silently drift
 * between the two compilations. Store comparable values as strings. `exists`
 * / `not_exists` are type-agnostic (key presence only; a JSON `null` counts as
 * present).
 */
export interface SurfaceWhereCondition {
  property: string;
  operator: SurfaceWhereOperator;
  /** Required for `eq`/`neq`/`contains` — compared as a string (see above). */
  value?: string;
}

export interface SurfaceMatch {
  /** Exact event names. */
  events?: string[];
  /** Dot-terminated by convention ("docs."). Longest prefix wins across surfaces. */
  eventPrefix?: string | string[];
  /** `user_events.source` values (pipeline provenance — e.g. "api" for the server app). */
  source?: string | string[];
  /** Refinement over TOP-LEVEL event properties, AND-ed with `source`. SQL-compilable subset ONLY. */
  where?: SurfaceWhereCondition[];
}

export interface SurfaceMeta {
  /** Stable id — keys the node (`surface:<id>`). No `:` or whitespace. */
  id: string;
  /** Display label. Defaults to `id`. */
  name?: string;
  tier: SurfaceTier;
  match: SurfaceMatch;
}

export interface DefinedSurface {
  meta: SurfaceMeta;
}

/** The builtin money node's id — reserved, cannot be a surface id. */
const RESERVED_SURFACE_ID = "revenue";
/** Node-id namespaces a surface id may not shadow. */
const RESERVED_ID_PREFIXES = ["journey", "funnel"];

const VALID_OPERATORS = new Set<SurfaceWhereOperator>([
  "eq",
  "neq",
  "exists",
  "not_exists",
  "contains",
]);
/** Operators whose match needs a `value`. */
const VALUE_REQUIRED = new Set<SurfaceWhereOperator>(["eq", "neq", "contains"]);

/** Validate a `string | string[]` match dimension (non-empty, no blank members). */
function validateStringDimension(
  id: string,
  field: string,
  value: string | string[],
): void {
  const arr = Array.isArray(value) ? value : [value];
  if (arr.length === 0) {
    throw new Error(
      `defineSurface("${id}"): \`${field}\` cannot be an empty array`,
    );
  }
  for (const item of arr) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(
        `defineSurface("${id}"): \`${field}\` contains an empty value`,
      );
    }
  }
}

function validateWhere(id: string, where: SurfaceWhereCondition[]): void {
  if (!Array.isArray(where) || where.length === 0) {
    throw new Error(`defineSurface("${id}"): \`where\` cannot be empty`);
  }
  for (const cond of where) {
    if (
      !cond ||
      typeof cond.property !== "string" ||
      cond.property.trim() === ""
    ) {
      throw new Error(
        `defineSurface("${id}"): a \`where\` condition is missing its \`property\``,
      );
    }
    if (!VALID_OPERATORS.has(cond.operator)) {
      throw new Error(
        `defineSurface("${id}"): unknown \`where\` operator "${cond.operator}" on ` +
          `"${cond.property}" — expected one of ${[...VALID_OPERATORS].join(", ")}`,
      );
    }
    if (
      VALUE_REQUIRED.has(cond.operator) &&
      (typeof cond.value !== "string" || cond.value === "")
    ) {
      throw new Error(
        `defineSurface("${id}"): \`where\` operator "${cond.operator}" on ` +
          `"${cond.property}" requires a non-empty \`value\``,
      );
    }
  }
}

function validateMatch(id: string, match: SurfaceMatch): void {
  if (match == null || typeof match !== "object") {
    throw new Error(`defineSurface("${id}"): \`match\` is required`);
  }
  const hasEvents = match.events !== undefined;
  const hasPrefix = match.eventPrefix !== undefined;
  const hasSource = match.source !== undefined;
  const hasWhere = match.where !== undefined;
  if (!hasEvents && !hasPrefix && !hasSource && !hasWhere) {
    throw new Error(
      `defineSurface("${id}"): \`match\` must declare at least one of ` +
        "events, eventPrefix, source, or where",
    );
  }
  if (hasEvents)
    validateStringDimension(id, "events", match.events as string[]);
  if (hasPrefix)
    validateStringDimension(id, "eventPrefix", match.eventPrefix as string[]);
  if (hasSource)
    validateStringDimension(id, "source", match.source as string[]);
  if (hasWhere) validateWhere(id, match.where as SurfaceWhereCondition[]);
}

/**
 * Validating factory — mirrors {@link defineFunnel}: returns its argument
 * pinned to the contract, throwing on any authoring mistake with an actionable
 * message (surfaces are plain-string-typed; this replaces the compiler).
 */
export function defineSurface(meta: SurfaceMeta): DefinedSurface {
  const id = meta?.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("defineSurface: `id` is required and cannot be empty");
  }
  if (/[:\s]/.test(id)) {
    throw new Error(
      `defineSurface("${id}"): id cannot contain ":" or whitespace`,
    );
  }
  if (id === RESERVED_SURFACE_ID) {
    throw new Error(
      `defineSurface("${id}"): "${RESERVED_SURFACE_ID}" is reserved for the builtin money node`,
    );
  }
  for (const prefix of RESERVED_ID_PREFIXES) {
    if (id.startsWith(prefix)) {
      throw new Error(
        `defineSurface("${id}"): id cannot start with "${prefix}" (reserved node namespace)`,
      );
    }
  }
  if (!SURFACE_TIERS.includes(meta.tier)) {
    throw new Error(
      `defineSurface("${id}"): unknown tier "${meta.tier}" — expected one of ${SURFACE_TIERS.join(", ")}`,
    );
  }
  validateMatch(id, meta.match);
  return { meta };
}
