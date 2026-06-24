import { Badge, type BadgeProps } from "@/components/ui/badge";

/**
 * A read-only key/value table for an arbitrary property bag (event properties,
 * contact/person properties), with a per-value type chip — the PostHog-style
 * "properties" panel. Shared by the Events feed and the contact detail drawer.
 */

type DisplayType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "object"
  | "array";

function inferDisplayType(value: unknown): DisplayType {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  return "object";
}

const TYPE_VARIANT: Record<DisplayType, BadgeProps["variant"]> = {
  string: "secondary",
  number: "secondary",
  boolean: "secondary",
  null: "outline",
  object: "outline",
  array: "outline",
};

function renderValue(value: unknown, type: DisplayType): string {
  if (type === "null") return "null";
  // Show an empty string as `""` so the cell isn't a confusing blank.
  if (type === "string") return value === "" ? '""' : (value as string);
  if (type === "object" || type === "array") return JSON.stringify(value);
  return String(value);
}

export function PropertyTable({
  properties,
  emptyLabel = "No properties.",
}: {
  properties: Record<string, unknown> | null | undefined;
  emptyLabel?: string;
}) {
  const entries = properties ? Object.entries(properties) : [];
  if (entries.length === 0) {
    return <p className="text-sm text-white/40">{emptyLabel}</p>;
  }
  return (
    <div className="divide-y divide-white/5 rounded-md border bg-white/[0.015]">
      {entries.map(([key, value]) => {
        const type = inferDisplayType(value);
        return (
          <div key={key} className="flex items-start gap-3 px-3 py-2 text-sm">
            <span
              className="w-40 shrink-0 truncate font-mono text-xs text-white/60"
              title={key}
            >
              {key}
            </span>
            <span className="min-w-0 flex-1 break-words font-mono text-xs text-white/90">
              {renderValue(value, type)}
            </span>
            <Badge
              variant={TYPE_VARIANT[type]}
              className="shrink-0 text-[10px]"
            >
              {type}
            </Badge>
          </div>
        );
      })}
    </div>
  );
}
