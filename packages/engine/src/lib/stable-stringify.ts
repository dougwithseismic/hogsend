/**
 * Deterministic JSON-ish stringify: sorted object keys, `undefined` entries
 * dropped — so key insertion order and optional-field spreading never change
 * the output. Hoisted VERBATIM from workflows/bucket-backfill.ts (impact
 * experiments D1) so the journey version hash
 * (journeys/journey-version.ts) and the bucket criteria hash share ONE
 * byte-identical implementation. `bucket_configs.criteriaHash` values MUST
 * NOT change across this move (no re-eval storm on boot) — locked by the
 * golden-value test in stable-stringify.test.ts.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}
