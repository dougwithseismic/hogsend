import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type {
  FlagTargeting,
  FlagTargetingComposite,
  FlagTargetingCondition,
  TargetingCatalog,
  TargetingOperator,
} from "@/lib/admin-api";
import { cn } from "@/lib/utils";

/**
 * A reusable, controlled condition-tree editor. Renders a root AND/OR group of
 * PROPERTY-leaf rows (property combobox + operator select + value input) with
 * nestable sub-groups; emits the {@link FlagTargeting} tree the flags targeting
 * API accepts. Phase-1: property + composite only (no event/bucket/journey
 * leaves). Empty state reads "Matches everyone".
 *
 * Controlled: pass a `FlagTargeting` `value` (a composite root — see
 * {@link emptyTargetingGroup}) and an `onChange`; the component never holds
 * internal draft state, so a parent form is the single source of truth. The
 * `catalog` seeds the property combobox + operator vocabulary; without it the
 * builder falls back to a built-in operator set and free-text properties, so it
 * still works before the catalog loads.
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
 * bare array becomes an AND group, a lone property leaf is wrapped in one, and a
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

function newCondition(catalog?: TargetingCatalog): FlagTargetingCondition {
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
  const operators = catalog?.operators ?? FALLBACK_OPERATORS;

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
              <ConditionRow
                key={key}
                condition={child}
                operators={operators}
                properties={catalog?.properties ?? []}
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
            setConditions([...group.conditions, newCondition(catalog)])
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

function ConditionRow({
  condition,
  operators,
  properties,
  onChange,
  onRemove,
}: {
  condition: FlagTargetingCondition;
  operators: TargetingOperator[];
  properties: string[];
  onChange: (next: FlagTargetingCondition) => void;
  onRemove: () => void;
}) {
  const unary = isUnary(condition.operator, operators);
  const listId = `prop-list-${condition.property || "new"}`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label="Property"
        list={listId}
        placeholder="property"
        value={condition.property}
        onChange={(e) => onChange({ ...condition, property: e.target.value })}
        className="h-9 w-44 font-mono text-xs"
      />
      <datalist id={listId}>
        {properties.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>

      <Select
        aria-label="Operator"
        value={condition.operator}
        onChange={(e) => {
          const operator = e.target.value;
          const next: FlagTargetingCondition = { ...condition, operator };
          // Unary operators (`exists`/`not_exists`) carry no value.
          if (isUnary(operator, operators)) {
            delete next.value;
          } else if (condition.value !== undefined) {
            // Re-coerce the existing value for the new operator (e.g. switching
            // to a numeric comparison must parse a still-string value).
            next.value = coerceValue(String(condition.value), operator);
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
          value={condition.value === undefined ? "" : String(condition.value)}
          onChange={(e) =>
            onChange({
              ...condition,
              value: coerceValue(e.target.value, condition.operator),
            })
          }
          className="h-9 w-40 text-xs"
        />
      )}

      <Button
        variant="ghost"
        size="icon"
        aria-label="Remove condition"
        onClick={onRemove}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
