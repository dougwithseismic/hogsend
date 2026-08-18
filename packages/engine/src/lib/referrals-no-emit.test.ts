import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * THE NO-EMIT LAW for the referral store (PRD 05 §6, mirroring the
 * account-link twin in `account-links-emit.test.ts`). `lib/referrals.ts`
 * returns mutation facts; its callers emit `referral.*` outbound AND re-ingest
 * for journeys, side by side.
 *
 * Both assertions are SOURCE reads, deliberately. A store emit plus an
 * intent-layer emit for the same mutation share a dedupe key, so
 * `emitOutbound`'s `onConflictDoNothing` would silently swallow the duplicate
 * and no behavioural test in this repo could go red - the only symptom would
 * be that nobody can say which layer owns the fact.
 */

const STORE_SOURCE = readFileSync(
  fileURLToPath(new URL("./referrals.ts", import.meta.url)),
  "utf8",
);

/** Every symbol that reaches the outbound spine, the bus, or analytics. */
const EMIT_SYMBOLS = [
  "emitOutbound",
  "ingestEvent",
  "hatchet",
  "Hatchet",
  "capture",
  "emitReferral",
  "ingestReferral",
];

/**
 * The store's permitted RUNTIME imports (`import type` is erased, so it cannot
 * carry a call). Anything else - including a FOURTH emit helper nobody has
 * written yet, under any name - trips this guard, because emitting requires
 * importing something that can emit.
 *
 * KNOWN LIMIT, stated rather than papered over: this reads LITERAL import
 * specifiers and LITERAL symbol names. An emit routed through both a renamed
 * re-export AND a computed `import(someVariable)` would evade it. Every
 * single-step variant is caught; a non-literal `import(...)` in
 * `lib/referrals.ts` is the bypass, not this guard's silence.
 */
const ALLOWED_RUNTIME_IMPORTS = ["@hogsend/core", "@hogsend/db", "drizzle-orm"];

/** STATIC runtime (non-`import type`) module specifiers. */
function staticImports(source: string): string[] {
  const specifiers = new Set<string>();
  for (const m of source.matchAll(
    /^import\s+(?!type\s)(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm,
  )) {
    if (m[1]) specifiers.add(m[1]);
  }
  return [...specifiers];
}

/** DYNAMIC `import("…")` module specifiers. */
function dynamicImports(source: string): string[] {
  const specifiers = new Set<string>();
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
    if (m[1]) specifiers.add(m[1]);
  }
  return [...specifiers];
}

function runtimeImports(source: string): string[] {
  return [...new Set([...staticImports(source), ...dynamicImports(source)])];
}

test("the referral store reaches no emit surface", () => {
  const hits = STORE_SOURCE.split("\n")
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => {
      const trimmed = line.trimStart();
      if (
        trimmed.startsWith("*") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*")
      ) {
        return false;
      }
      return EMIT_SYMBOLS.some((symbol) => line.includes(symbol));
    });

  assert.deepEqual(
    hits,
    [],
    "lib/referrals.ts must reach NEITHER the outbound spine " +
      "(`emitOutbound`) NOR the journey plane (`ingestEvent`, Hatchet) NOR " +
      `analytics (\`capture\`); found: ${JSON.stringify(hits)}`,
  );
});

test("the referral store imports nothing new at runtime", () => {
  // The symbol scan above only catches emit surfaces we already know the name
  // of. This one catches the NEXT one: a store that emits has to import
  // something that emits, so pinning the import list makes any such edge fail
  // here first, whatever it gets called.
  assert.deepEqual(
    runtimeImports(STORE_SOURCE).sort(),
    [...ALLOWED_RUNTIME_IMPORTS].sort(),
    "lib/referrals.ts changed its runtime imports. If the new import cannot " +
      "emit (the store returns facts, its callers emit - PRD 05 §6), add it " +
      "to ALLOWED_RUNTIME_IMPORTS.",
  );
});
