import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type {
  FlagBucketCondition,
  FlagDealCondition,
  FlagEmailEngagementCondition,
  FlagEventCondition,
  FlagJourneyCondition,
  FlagTargeting,
  FlagTargetingComposite,
  FlagTargetingCondition,
  FlagTargetingLeaf,
  TargetingCatalog,
  TargetingOperator,
} from "@/lib/admin-api";
import { eventOptions } from "@/lib/event-options";
import { cn } from "@/lib/utils";

/**
 * A reusable, controlled condition-tree editor. Renders a root AND/OR group of
 * leaf rows with nestable sub-groups; emits the {@link FlagTargeting} tree the
 * flags targeting API accepts. Each row now carries a SOURCE picker — Property,
 * Bucket, Journey, Deal, or Event — and drives its own inputs, so a group can
 * mix leaf kinds freely. Empty state reads "Matches everyone".
 *
 * PURE leaves (property/bucket/journey/deal) evaluate on the browser read; the
 * SERVER-ONLY scan leaves (event/email_engagement) evaluate `false` there and
 * are flagged inline. Controlled: pass a `FlagTargeting` `value` (a composite
 * root — see {@link emptyTargetingGroup}) and an `onChange`; the component never
 * holds internal draft state, so a parent form is the single source of truth.
 * The `catalog` seeds every source's vocabulary (properties + operators, plus
 * the bucket / journey / deal-stage / event pick-lists); without it the builder
 * degrades to free-text + a built-in operator set so it still works before the
 * catalog loads.
 */

/** The 9 property operators, mirrored for use before the catalog loads. */
const FALLBACK_OPERATORS: TargetingOperator[] = [
  { value: "eq", label: "equals", unary: false },
  { value: "neq", label: "does not equal", unary: false },
  { value: "gt", label: "greater than", unary: false },
  { value: "gte", label: "greater than or equal to", unary: false },
  { value: "lt", label: "less than", unary: false },
  { value: "lte", label: "less than or equal to", unary: false },
  { value: "contains", label: "contains", unary: false },
  { value: "exists", label: "is set", unary: true },
  { value: "not_exists", label: "is not set", unary: true },
];

/** A fresh, empty AND group — the default targeting a new flag starts from. */
export function emptyTargetingGroup(): FlagTargetingComposite {
  return { type: "composite", operator: "and", conditions: [] };
}

/**
 * Normalize any stored targeting into a composite root for editing: a legacy
 * bare array becomes an AND group, a lone leaf is wrapped in one, and a
 * composite passes through. Nullish (no targeting) → an empty AND group.
 */
export function toTargetingGroup(
  value: FlagTargeting | FlagTargetingCondition[] | null | undefined,
): FlagTargetingComposite {
  if (value == null) return emptyTargetingGroup();
  if (Array.isArray(value)) {
    return { type: "composite", operator: "and", conditions: value };
  }
  if (value.type === "composite") return value;
  return { type: "composite", operator: "and", conditions: [value] };
}

function isUnary(operator: string, operators: TargetingOperator[]): boolean {
  return operators.find((o) => o.value === operator)?.unary ?? false;
}

/** The numeric-comparison operators — the evaluator requires a number on both
 * sides for these, so a string could never match. */
const NUMERIC_OPERATORS = new Set(["gt", "gte", "lt", "lte"]);

/**
 * Coerce the free-text value input to the scalar the evaluator expects, keyed
 * off the operator. Only the numeric-comparison operators parse to a number;
 * `eq`/`neq`/`contains` keep the RAW string. Coercing a numeric-looking or
 * `true`/`false` string for those would make equality/`contains` against a
 * string-typed contact property silently never match (e.g. `plan eq "2024"`
 * became `2024`, and `"2024" === 2024` is false; `contains` requires a string
 * on both sides in the evaluator).
 */
function coerceValue(raw: string, operator: string): string | number {
  const trimmed = raw.trim();
  if (
    NUMERIC_OPERATORS.has(operator) &&
    trimmed !== "" &&
    Number.isFinite(Number(trimmed))
  ) {
    return Number(trimmed);
  }
  return raw;
}

// --- Sources ---------------------------------------------------------------

/** The leaf kinds a row's source picker offers (email_engagement is display-
 * only — it can arrive from stored data but the picker never creates one). */
const SOURCES = [
  { value: "property", label: "Property" },
  { value: "bucket", label: "Bucket" },
  { value: "journey", label: "Journey" },
  { value: "deal", label: "Deal" },
  { value: "event", label: "Event" },
] as const;

type SourceType = (typeof SOURCES)[number]["value"];

/**
 * True when a source can't produce a savable leaf because its catalog list is
 * loaded-and-empty — `bucket`/`journey` seed an empty id in that case (the
 * the combobox has no options to pick), which the backend's `.min(1)` rejects. While
 * the catalog is still loading (`undefined`) we allow the pick; buildBody
 * backstops the loading race. Other sources are always creatable (property is
 * free-text; deal/event carry their own defaults).
 */
function isSourceUnavailable(
  source: SourceType,
  catalog?: TargetingCatalog,
): boolean {
  if (!catalog) return false;
  if (source === "bucket") return catalog.buckets.length === 0;
  if (source === "journey") return catalog.journeys.length === 0;
  return false;
}

/** True for the SERVER-ONLY scan leaves — they evaluate false on the browser
 * read, so the row shows an inline hint. */
function isServerOnly(type: FlagTargetingLeaf["type"]): boolean {
  return type === "event" || type === "email_engagement";
}

/** A fresh default leaf for a chosen source, seeded from the catalog. */
function newLeafForSource(
  source: SourceType,
  catalog?: TargetingCatalog,
): FlagTargetingLeaf {
  switch (source) {
    case "bucket":
      return { type: "bucket", bucketId: catalog?.buckets[0]?.id ?? "" };
    case "journey":
      return {
        type: "journey",
        journeyId: catalog?.journeys[0]?.id ?? "",
        state: "active",
      };
    case "deal":
      return { type: "deal", predicate: "won" };
    case "event":
      return {
        type: "event",
        eventName: catalog?.events[0]?.name ?? "",
        check: "exists",
      };
    default:
      return newPropertyLeaf(catalog);
  }
}

function newPropertyLeaf(catalog?: TargetingCatalog): FlagTargetingCondition {
  return {
    type: "property",
    property: catalog?.properties[0] ?? "",
    operator: "eq",
    value: "",
  };
}

export function ConditionBuilder({
  value,
  onChange,
  catalog,
}: {
  value: FlagTargeting;
  onChange: (next: FlagTargeting) => void;
  catalog?: TargetingCatalog;
}) {
  const root = toTargetingGroup(value);
  return (
    <GroupEditor group={root} onChange={onChange} catalog={catalog} depth={0} />
  );
}

function GroupEditor({
  group,
  onChange,
  onRemove,
  catalog,
  depth,
}: {
  group: FlagTargetingComposite;
  onChange: (next: FlagTargetingComposite) => void;
  onRemove?: () => void;
  catalog?: TargetingCatalog;
  depth: number;
}) {
  function setConditions(conditions: FlagTargeting[]) {
    onChange({ ...group, conditions });
  }

  function updateChild(index: number, next: FlagTargeting) {
    setConditions(group.conditions.map((c, i) => (i === index ? next : c)));
  }

  function removeChild(index: number) {
    setConditions(group.conditions.filter((_, i) => i !== index));
  }

  const nested = depth > 0;

  return (
    <div
      className={cn(
        "space-y-3 rounded-lg",
        nested && "border border-hairline-faint bg-white/[0.015] p-3",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ConjunctionToggle
            value={group.operator}
            onChange={(operator) => onChange({ ...group, operator })}
          />
          <span className="text-white/40 text-xs">
            {group.operator === "and"
              ? "all conditions match"
              : "any condition matches"}
          </span>
        </div>
        {onRemove ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Remove group"
            onClick={onRemove}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {group.conditions.length === 0 ? (
        <p className="text-white/40 text-xs">Matches everyone</p>
      ) : (
        <div className="space-y-2">
          {group.conditions.map((child, index) => {
            const key = `${depth}-${index}`;
            return child.type === "composite" ? (
              <GroupEditor
                key={key}
                group={child}
                onChange={(next) => updateChild(index, next)}
                onRemove={() => removeChild(index)}
                catalog={catalog}
                depth={depth + 1}
              />
            ) : (
              <LeafRow
                key={key}
                leaf={child}
                catalog={catalog}
                onChange={(next) => updateChild(index, next)}
                onRemove={() => removeChild(index)}
              />
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setConditions([...group.conditions, newPropertyLeaf(catalog)])
          }
        >
          <Plus className="h-3.5 w-3.5" />
          Add condition
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setConditions([...group.conditions, emptyTargetingGroup()])
          }
        >
          <Plus className="h-3.5 w-3.5" />
          Add group
        </Button>
      </div>
    </div>
  );
}

function ConjunctionToggle({
  value,
  onChange,
}: {
  value: "and" | "or";
  onChange: (next: "and" | "or") => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-hairline-faint p-0.5">
      {(["and", "or"] as const).map((op) => (
        <button
          key={op}
          type="button"
          onClick={() => onChange(op)}
          className={cn(
            "rounded px-2.5 py-1 font-medium text-xs uppercase tracking-wide transition-colors duration-200",
            value === op
              ? "bg-white/10 text-white"
              : "text-white/50 hover:text-white/80",
          )}
        >
          {op}
        </button>
      ))}
    </div>
  );
}

// --- Leaf row (source picker + per-source inputs) --------------------------

function LeafRow({
  leaf,
  catalog,
  onChange,
  onRemove,
}: {
  leaf: FlagTargetingLeaf;
  catalog?: TargetingCatalog;
  onChange: (next: FlagTargetingLeaf) => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-1.5 rounded-md border border-hairline-faint bg-white/[0.015] p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Source"
          value={leaf.type}
          onChange={(e) =>
            onChange(newLeafForSource(e.target.value as SourceType, catalog))
          }
          className="w-32"
        >
          {SOURCES.map((s) => {
            // Keep the current source selectable so its leaf renders; only block
            // switching TO a source that can't produce a savable leaf.
            const disabled =
              leaf.type !== s.value && isSourceUnavailable(s.value, catalog);
            return (
              <option key={s.value} value={s.value} disabled={disabled}>
                {disabled ? `${s.label} (none available)` : s.label}
              </option>
            );
          })}
          {/* Existing email_engagement leaves aren't creatable, but stay
              selectable so they round-trip until switched away. */}
          {leaf.type === "email_engagement" ? (
            <option value="email_engagement">Email engagement</option>
          ) : null}
        </Select>

        <LeafInputs leaf={leaf} catalog={catalog} onChange={onChange} />

        <Button
          variant="ghost"
          size="icon"
          aria-label="Remove condition"
          onClick={onRemove}
          className="ml-auto"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {isServerOnly(leaf.type) ? (
        <p className="pl-1 text-[11px] text-white/40">
          Server-side only — evaluates false on the browser read.
        </p>
      ) : null}
    </div>
  );
}

/** Dispatch to the per-source inputs. Each branch narrows `leaf` by `type`. */
function LeafInputs({
  leaf,
  catalog,
  onChange,
}: {
  leaf: FlagTargetingLeaf;
  catalog?: TargetingCatalog;
  onChange: (next: FlagTargetingLeaf) => void;
}) {
  switch (leaf.type) {
    case "bucket":
      return <BucketInputs leaf={leaf} catalog={catalog} onChange={onChange} />;
    case "journey":
      return (
        <JourneyInputs leaf={leaf} catalog={catalog} onChange={onChange} />
      );
    case "deal":
      return <DealInputs leaf={leaf} catalog={catalog} onChange={onChange} />;
    case "event":
      return <EventInputs leaf={leaf} catalog={catalog} onChange={onChange} />;
    case "email_engagement":
      return (
        <EmailEngagementInputs
          leaf={leaf}
          catalog={catalog}
          onChange={onChange}
        />
      );
    default:
      return (
        <PropertyInputs leaf={leaf} catalog={catalog} onChange={onChange} />
      );
  }
}

/** A membership polarity toggle (in / not in, has / has no). */
function NegateSelect({
  negate,
  onChange,
  affirmative,
  negative,
}: {
  negate: boolean;
  onChange: (next: boolean) => void;
  affirmative: string;
  negative: string;
}) {
  return (
    <Select
      aria-label="Polarity"
      value={negate ? "no" : "yes"}
      onChange={(e) => onChange(e.target.value === "no")}
      className="w-28"
    >
      <option value="yes">{affirmative}</option>
      <option value="no">{negative}</option>
    </Select>
  );
}

function PropertyInputs({
  leaf,
  catalog,
  onChange,
}: {
  leaf: FlagTargetingCondition;
  catalog?: TargetingCatalog;
  onChange: (next: FlagTargetingLeaf) => void;
}) {
  const operators = catalog?.operators ?? FALLBACK_OPERATORS;
  const properties = catalog?.properties ?? [];
  const unary = isUnary(leaf.operator, operators);
  const listId = `prop-list-${leaf.property || "new"}`;

  return (
    <>
      <Input
        aria-label="Property"
        list={listId}
        placeholder="property"
        value={leaf.property}
        onChange={(e) => onChange({ ...leaf, property: e.target.value })}
        className="h-9 w-44 font-mono text-xs"
      />
      <datalist id={listId}>
        {properties.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>

      <Select
        aria-label="Operator"
        value={leaf.operator}
        onChange={(e) => {
          const operator = e.target.value;
          const next: FlagTargetingCondition = { ...leaf, operator };
          if (isUnary(operator, operators)) {
            delete next.value;
          } else if (leaf.value !== undefined) {
            next.value = coerceValue(String(leaf.value), operator);
          }
          onChange(next);
        }}
        className="w-52"
      >
        {operators.map((op) => (
          <option key={op.value} value={op.value}>
            {op.label}
          </option>
        ))}
      </Select>

      {unary ? null : (
        <Input
          aria-label="Value"
          placeholder="value"
          value={leaf.value === undefined ? "" : String(leaf.value)}
          onChange={(e) =>
            onChange({
              ...leaf,
              value: coerceValue(e.target.value, leaf.operator),
            })
          }
          className="h-9 w-40 text-xs"
        />
      )}
    </>
  );
}

function BucketInputs({
  leaf,
  catalog,
  onChange,
}: {
  leaf: FlagBucketCondition;
  catalog?: TargetingCatalog;
  onChange: (next: FlagTargetingLeaf) => void;
}) {
  return (
    <>
      <NegateSelect
        negate={leaf.negate ?? false}
        onChange={(negate) => onChange({ ...leaf, negate })}
        affirmative="is in"
        negative="is not in"
      />
      <Combobox
        ariaLabel="Bucket"
        value={leaf.bucketId}
        placeholder="Select a bucket"
        options={(catalog?.buckets ?? []).map((b) => ({
          value: b.id,
          label: b.name,
        }))}
        onChange={(bucketId) => onChange({ ...leaf, bucketId })}
        className="w-56"
      />
    </>
  );
}

function JourneyInputs({
  leaf,
  catalog,
  onChange,
}: {
  leaf: FlagJourneyCondition;
  catalog?: TargetingCatalog;
  onChange: (next: FlagTargetingLeaf) => void;
}) {
  return (
    <>
      <NegateSelect
        negate={leaf.negate ?? false}
        onChange={(negate) => onChange({ ...leaf, negate })}
        affirmative="is"
        negative="is not"
      />
      <Select
        aria-label="Journey state"
        value={leaf.state}
        onChange={(e) =>
          onChange({
            ...leaf,
            state: e.target.value as FlagJourneyCondition["state"],
          })
        }
        className="w-40"
      >
        <option value="active">enrolled in</option>
        <option value="completed">completed</option>
      </Select>
      <Combobox
        ariaLabel="Journey"
        value={leaf.journeyId}
        placeholder="Select a journey"
        options={(catalog?.journeys ?? []).map((j) => ({
          value: j.id,
          label: j.name,
        }))}
        onChange={(journeyId) => onChange({ ...leaf, journeyId })}
        className="w-52"
      />
    </>
  );
}

function DealInputs({
  leaf,
  catalog,
  onChange,
}: {
  leaf: FlagDealCondition;
  catalog?: TargetingCatalog;
  onChange: (next: FlagTargetingLeaf) => void;
}) {
  const stages = catalog?.dealStages ?? [];
  // With no stages loaded, the stage predicate would seed an empty `stage` the
  // backend rejects — block switching to it until the (constant) list arrives.
  const stageUnavailable = leaf.predicate !== "stage" && stages.length === 0;
  return (
    <>
      <NegateSelect
        negate={leaf.negate ?? false}
        onChange={(negate) => onChange({ ...leaf, negate })}
        affirmative="has"
        negative="has no"
      />
      <Select
        aria-label="Deal predicate"
        value={leaf.predicate}
        onChange={(e) => {
          const predicate = e.target.value as FlagDealCondition["predicate"];
          const next: FlagDealCondition = { ...leaf, predicate };
          // `stage` only belongs to the `stage` predicate; seed / drop it.
          if (predicate === "stage") {
            next.stage = leaf.stage ?? stages[0] ?? "";
          } else {
            delete next.stage;
          }
          onChange(next);
        }}
        className="w-44"
      >
        <option value="won">won deal</option>
        <option value="open">open deal</option>
        <option value="stage" disabled={stageUnavailable}>
          deal at stage{stageUnavailable ? " (none available)" : ""}
        </option>
      </Select>
      {leaf.predicate === "stage" ? (
        <Combobox
          ariaLabel="Deal stage"
          value={leaf.stage ?? ""}
          placeholder="Select a stage"
          options={stages.map((s) => ({ value: s, label: s }))}
          onChange={(stage) => onChange({ ...leaf, stage })}
          className="w-44"
        />
      ) : null}
    </>
  );
}

/** Read the single unit a `within` window uses (best-effort — the UI writes at
 * most one key; a stored multi-key window reads its first present unit). */
const WITHIN_UNITS = ["hours", "minutes", "seconds"] as const;
type WithinUnit = (typeof WITHIN_UNITS)[number];

function readWithin(within: FlagEventCondition["within"]): {
  amount: string;
  unit: WithinUnit;
} {
  if (!within) return { amount: "", unit: "hours" };
  for (const unit of WITHIN_UNITS) {
    const v = within[unit];
    if (v !== undefined) return { amount: String(v), unit };
  }
  return { amount: "", unit: "hours" };
}

function EventInputs({
  leaf,
  catalog,
  onChange,
}: {
  leaf: FlagEventCondition;
  catalog?: TargetingCatalog;
  onChange: (next: FlagTargetingLeaf) => void;
}) {
  const { amount, unit } = readWithin(leaf.within);

  function setWithin(nextAmount: string, nextUnit: WithinUnit) {
    const n = Number(nextAmount);
    if (nextAmount.trim() === "" || !Number.isFinite(n) || n <= 0) {
      const { within: _drop, ...rest } = leaf;
      onChange(rest);
    } else {
      onChange({ ...leaf, within: { [nextUnit]: n } });
    }
  }

  return (
    <>
      <Combobox
        ariaLabel="Event"
        value={leaf.eventName}
        placeholder="Select an event"
        options={eventOptions(catalog?.events ?? [])}
        onChange={(eventName) => onChange({ ...leaf, eventName })}
        className="w-52 font-mono text-xs"
      />
      <Select
        aria-label="Event check"
        value={leaf.check}
        onChange={(e) => {
          const check = e.target.value as FlagEventCondition["check"];
          const next: FlagEventCondition = { ...leaf, check };
          if (check === "count") {
            next.operator = leaf.operator ?? "gte";
            next.value = leaf.value ?? 1;
          } else {
            delete next.operator;
            delete next.value;
          }
          onChange(next);
        }}
        className="w-36"
      >
        <option value="exists">happened</option>
        <option value="not_exists">did not happen</option>
        <option value="count">count</option>
      </Select>

      {leaf.check === "count" ? (
        <>
          <Select
            aria-label="Count operator"
            value={leaf.operator ?? "gte"}
            onChange={(e) =>
              onChange({
                ...leaf,
                operator: e.target.value as NonNullable<
                  FlagEventCondition["operator"]
                >,
              })
            }
            className="w-40"
          >
            <option value="gte">at least</option>
            <option value="gt">more than</option>
            <option value="eq">exactly</option>
            <option value="lt">fewer than</option>
            <option value="lte">at most</option>
          </Select>
          <Input
            aria-label="Count value"
            type="number"
            min={0}
            placeholder="times"
            value={leaf.value ?? ""}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({
                ...leaf,
                value: Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0,
              });
            }}
            className="h-9 w-24 text-xs"
          />
        </>
      ) : null}

      <span className="text-white/40 text-xs">within</span>
      <Input
        aria-label="Within amount"
        type="number"
        min={0}
        placeholder="any time"
        value={amount}
        onChange={(e) => setWithin(e.target.value, unit)}
        className="h-9 w-24 text-xs"
      />
      <Select
        aria-label="Within unit"
        value={unit}
        onChange={(e) => setWithin(amount, e.target.value as WithinUnit)}
        className="w-28"
      >
        <option value="hours">hours</option>
        <option value="minutes">minutes</option>
        <option value="seconds">seconds</option>
      </Select>
    </>
  );
}

function EmailEngagementInputs({
  leaf,
  catalog,
  onChange,
}: {
  leaf: FlagEmailEngagementCondition;
  catalog?: TargetingCatalog;
  onChange: (next: FlagTargetingLeaf) => void;
}) {
  return (
    <>
      <Combobox
        ariaLabel="Template key"
        value={leaf.templateKey}
        placeholder="Select a template"
        options={(catalog?.templates ?? []).map((key) => ({
          value: key,
          label: key,
        }))}
        onChange={(templateKey) => onChange({ ...leaf, templateKey })}
        className="w-52 font-mono text-xs"
      />
      <Select
        aria-label="Engagement check"
        value={leaf.check}
        onChange={(e) =>
          onChange({
            ...leaf,
            check: e.target.value as FlagEmailEngagementCondition["check"],
          })
        }
        className="w-40"
      >
        <option value="opened">opened</option>
        <option value="not_opened">did not open</option>
        <option value="clicked">clicked</option>
        <option value="not_clicked">did not click</option>
      </Select>
    </>
  );
}
