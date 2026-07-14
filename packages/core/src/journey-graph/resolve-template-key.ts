/**
 * Resolve the real email-template registry key for a `send` node from the const
 * NAME the graph builder recovered from the AST (`Templates.DOCS_WELCOME` → the
 * identifier text `DOCS_WELCOME`). This is STATIC — it needs no send data, so a
 * journey that has never sent still previews its templates in Studio.
 *
 * The const name is always UPPER_SNAKE, but a registry key can use ANY separator
 * convention (`docs/welcome`, `docs-welcome`, `docs_welcome`) — and even MIX them
 * (`docs/setup-offer`). So the match is done on SEGMENTS: each name/key split on
 * any run of `/`, `_`, or `-`, lowercased. The separator style never matters.
 *
 *   (1) exact — the const name's segments equal a key's segments, in order.
 *   (2) else the single LONGEST key whose segments are a prefix of the const
 *       name's (`ACTIVATION_NUDGE_SERIES` → `activation-nudge`).
 *
 * A tie at either stage returns `undefined` — a wrong preview is worse than none,
 * so an ambiguous name stays unresolved.
 */
function segmentsOf(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[/_-]+/)
    .filter(Boolean);
}

export function resolveTemplateKeyFromConst(
  constName: string,
  registryKeys: readonly string[],
): string | undefined {
  const nameSegs = segmentsOf(constName);
  if (nameSegs.length === 0) return undefined;

  // An exact match is just the LONGEST possible segment-prefix of the const
  // name, so both stages are one search: the unique longest registry key whose
  // segments prefix the const name's. A tie at that longest length is ambiguous
  // → unresolved (a wrong preview is worse than none).
  const isPrefix = (segs: string[]) =>
    segs.length <= nameSegs.length &&
    segs.every((seg, i) => seg === nameSegs[i]);

  let best: string | undefined;
  let bestLen = -1;
  let ambiguous = false;
  for (const key of registryKeys) {
    const segs = segmentsOf(key);
    if (!isPrefix(segs)) continue;
    if (segs.length > bestLen) {
      best = key;
      bestLen = segs.length;
      ambiguous = false;
    } else if (segs.length === bestLen) {
      ambiguous = true;
    }
  }
  return ambiguous ? undefined : best;
}
