import assert from "node:assert/strict";
import test from "node:test";
import { deriveJourneyKey, type JourneyKeyKind } from "./journey-boundary.js";

const ANCHOR = "run-anchor-1";
const SITE = "wait-event:nps-answer";
const DISCRIMINANT = "welcome";

test('the "refine" key kind is prefixed journeyRefine:', () => {
  const key = deriveJourneyKey({
    kind: "refine",
    anchor: ANCHOR,
    site: SITE,
    discriminant: DISCRIMINANT,
  });

  assert.ok(
    key.startsWith("journeyRefine:"),
    `expected a journeyRefine: prefix, got "${key}"`,
  );
  assert.equal(key, `journeyRefine:${ANCHOR}:${SITE}:${DISCRIMINANT}`);
});

test('"refine" keys are disjoint from every other kind for identical inputs', () => {
  // A collision here would make a refineContact() lookup dedupe against an
  // unrelated email/SMS send sharing the same nearest wait label — the lookup
  // would be silently dropped (or the send suppressed), with no error.
  const kinds: JourneyKeyKind[] = [
    "send",
    "smsSend",
    "trigger",
    "connector",
    "refine",
  ];

  const keys = kinds.map((kind) =>
    deriveJourneyKey({
      kind,
      anchor: ANCHOR,
      site: SITE,
      discriminant: DISCRIMINANT,
    }),
  );

  assert.equal(
    new Set(keys).size,
    kinds.length,
    `expected ${kinds.length} distinct keys, got ${JSON.stringify(keys)}`,
  );

  const refineKey = deriveJourneyKey({
    kind: "refine",
    anchor: ANCHOR,
    site: SITE,
    discriminant: DISCRIMINANT,
  });
  for (const kind of kinds) {
    if (kind === "refine") continue;
    assert.notEqual(
      refineKey,
      deriveJourneyKey({
        kind,
        anchor: ANCHOR,
        site: SITE,
        discriminant: DISCRIMINANT,
      }),
      `"refine" collided with "${kind}"`,
    );
  }
});
