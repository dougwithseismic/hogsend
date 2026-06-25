/**
 * In-house class-name joiner (~15 lines) — no clsx, no cva, no tailwind-merge.
 * Components style via `--hs-*` vars + `data-*` state, so all we need is to
 * concatenate truthy class fragments.
 */

/** A class-name fragment: string, falsy, or a record of `class → enabled`. */
export type ClassValue =
  | string
  | number
  | false
  | null
  | undefined
  | Record<string, boolean | null | undefined>;

/** Join truthy class fragments into a single space-separated string. */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (typeof value === "string" || typeof value === "number") {
      out.push(String(value));
    } else {
      for (const [key, enabled] of Object.entries(value)) {
        if (enabled) out.push(key);
      }
    }
  }
  return out.join(" ");
}
