import {
  emptyTargetingGroup,
  toTargetingGroup,
} from "@/components/condition-builder";
import { Label } from "@/components/ui/label";
import type {
  Flag,
  FlagConditionSet,
  FlagCreateBody,
  FlagTargeting,
  FlagType,
  FlagUpdateBody,
  FlagVariant,
} from "@/lib/admin-api";

/**
 * Shared form state + body-builder for the full-page flag editor (create + edit).
 * Extracted from the retired modal so both the create and edit routes drive one
 * source of truth. The big shift from the modal: a flag now carries an ORDERED
 * ARRAY of condition sets (each a targeting tree + its own rollout), so the form
 * holds `conditionSets` rather than a single targeting+rollout pair. The engine
 * does the authoritative validation — this only catches the obvious mistakes
 * before the round-trip.
 */

/** One editable condition set: a normalized targeting tree + its rollout. */
export type ConditionSetDraft = {
  description?: string;
  /** Always a composite root (normalized from any stored shape) for editing. */
  targeting: FlagTargeting;
  /** Per-set rollout percent (0-100). */
  rollout: number;
};

export type FormState = {
  key: string;
  name: string;
  description: string;
  type: FlagType;
  /** Boolean flags: the served-off value. */
  defaultBool: boolean;
  /** Multivariate flags: the served-off value, as JSON. */
  defaultJson: string;
  /** Multivariate flags: the arms, as JSON (FlagVariant[]). */
  variantsJson: string;
  /** Ordered targeting rules; first matching set wins. Always ≥1. */
  conditionSets: ConditionSetDraft[];
};

/** A fresh condition set — an empty AND group that matches everyone at 100%. */
export function emptyConditionSet(): ConditionSetDraft {
  return { targeting: emptyTargetingGroup(), rollout: 100 };
}

export function initialForm(flag?: Flag): FormState {
  if (!flag) {
    return {
      key: "",
      name: "",
      description: "",
      type: "boolean",
      defaultBool: false,
      defaultJson: "null",
      variantsJson: "[]",
      conditionSets: [emptyConditionSet()],
    };
  }
  // Normalize each stored set's targeting (legacy bare array / lone leaf) into an
  // editable composite root. A flag always serves ≥1 set, but guard the empty
  // case so the editor never renders zero sets.
  const sets: ConditionSetDraft[] =
    flag.conditionSets.length > 0
      ? flag.conditionSets.map((s) => ({
          description: s.description,
          targeting: toTargetingGroup(s.targeting),
          rollout: s.rollout,
        }))
      : [
          {
            targeting: toTargetingGroup(flag.targeting),
            rollout: flag.rollout,
          },
        ];
  return {
    key: flag.key,
    name: flag.name,
    description: flag.description ?? "",
    type: flag.type,
    defaultBool: flag.defaultValue === true,
    defaultJson: JSON.stringify(flag.defaultValue ?? null, null, 2),
    variantsJson: JSON.stringify(flag.variants ?? [], null, 2),
    conditionSets: sets,
  };
}

/**
 * Walk a targeting tree and return a human-readable error for the first leaf
 * that would fail the engine's `.min(1)` id/stage checks, else `undefined`. A
 * bucket / journey / deal-at-stage leaf can be seeded with an empty id when its
 * catalog list is empty or still loading (no option to pick); forwarding that
 * verbatim makes `flagTargetingNodeSchema` 400 with a raw zod error that surfaces
 * as an opaque "Could not save flag". Catching it here yields a clear message.
 */
function firstInvalidLeaf(node: FlagTargeting): string | undefined {
  if (node.type === "composite") {
    for (const child of node.conditions) {
      const err = firstInvalidLeaf(child);
      if (err) return err;
    }
    return undefined;
  }
  if (node.type === "bucket" && node.bucketId.trim() === "") {
    return "Select a bucket for every bucket condition (none is chosen).";
  }
  if (node.type === "journey" && node.journeyId.trim() === "") {
    return "Select a journey for every journey condition (none is chosen).";
  }
  if (
    node.type === "deal" &&
    node.predicate === "stage" &&
    (node.stage ?? "").trim() === ""
  ) {
    return "Select a stage for every deal-at-stage condition.";
  }
  return undefined;
}

function parseJson<T>(raw: string, empty: T): { value?: T; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: empty };
  try {
    return { value: JSON.parse(trimmed) as T };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "invalid JSON" };
  }
}

/**
 * Build the request body from the form, or an error string when a JSON field is
 * malformed / a rollout is out of range. Create needs key+name; edit omits
 * nothing (the key is editable). Emits `conditionSets`, which the engine treats
 * as authoritative (it keeps the legacy `targeting`+`rollout` columns coherent
 * from `conditionSets[0]`).
 */
export function buildBody(
  state: FormState,
  mode: "create" | "edit",
): { body?: FlagCreateBody | FlagUpdateBody; error?: string } {
  const name = state.name.trim();
  if (!name) return { error: "Name is required." };

  const key = state.key.trim();
  if (!key) return { error: "Key is required." };

  if (state.conditionSets.length === 0) {
    return { error: "At least one release condition set is required." };
  }
  for (const set of state.conditionSets) {
    if (
      !Number.isInteger(set.rollout) ||
      set.rollout < 0 ||
      set.rollout > 100
    ) {
      return {
        error: "Each rollout must be a whole number between 0 and 100.",
      };
    }
    const leafError = firstInvalidLeaf(set.targeting);
    if (leafError) return { error: leafError };
  }

  let defaultValue: unknown;
  let variants: FlagVariant[] = [];
  if (state.type === "boolean") {
    defaultValue = state.defaultBool;
  } else {
    const dv = parseJson<unknown>(state.defaultJson, null);
    if (dv.error) return { error: `Default value: ${dv.error}` };
    defaultValue = dv.value;
    const vs = parseJson<FlagVariant[]>(state.variantsJson, []);
    if (vs.error) return { error: `Variants: ${vs.error}` };
    if (!Array.isArray(vs.value)) {
      return { error: "Variants must be a JSON array." };
    }
    variants = vs.value;
  }

  const conditionSets: FlagConditionSet[] = state.conditionSets.map((s) => ({
    ...(s.description ? { description: s.description } : {}),
    targeting: s.targeting,
    rollout: s.rollout,
  }));

  const common: FlagUpdateBody = {
    key,
    name,
    description: state.description.trim() || undefined,
    type: state.type,
    conditionSets,
    defaultValue,
    variants,
  };

  if (mode === "edit") return { body: common };
  return { body: { ...common, key, name, type: state.type } as FlagCreateBody };
}

/** Slugify a name into a stable key: lowercase, non-alphanumerics → hyphens. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A default/variant value in a table cell — scalars render, containers JSON. */
export function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value === "" ? '""' : value;
  return JSON.stringify(value);
}

export function JsonField({
  id,
  label,
  hint,
  value,
  onChange,
  rows,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  rows: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        rows={rows}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex w-full rounded-md border border-hairline-faint bg-white/[0.04] px-3 py-2 font-mono text-white text-xs transition-colors duration-200 hover:border-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <p className="text-white/40 text-xs">{hint}</p>
    </div>
  );
}
