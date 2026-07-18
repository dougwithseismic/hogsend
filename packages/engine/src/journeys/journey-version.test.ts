import assert from "node:assert/strict";
import test from "node:test";
import type { JourneyMeta, JourneyMetaInput } from "@hogsend/core/types";
import { stableStringify } from "../lib/stable-stringify.js";
import { defineJourney } from "./define-journey.js";
import {
  computeJourneyVersionHash,
  normalizeRunSource,
} from "./journey-version.js";

const GOLDEN_META: JourneyMeta = {
  id: "golden-journey",
  name: "Golden Journey",
  enabled: true,
  trigger: { event: "user.created" },
  entryLimit: "once",
  suppress: { hours: 24 },
};

const GOLDEN_BODY =
  'async (user, ctx) => {\n  // welcome\n  await sendEmail({ to: user.email, template: "welcome" });\n}';

test("golden values — frozen compatibility contract (hsv1)", () => {
  // Changing normalizeRunSource, stableStringify, the meta exclusion list,
  // or HASH_INPUT_VERSION forks every live cohort exactly once. These
  // literals are the lock: a failing golden means you are knowingly
  // reforking and must bump HASH_INPUT_VERSION instead.
  assert.equal(
    computeJourneyVersionHash({ meta: GOLDEN_META, body: GOLDEN_BODY }),
    "8996a5ccc0e7",
  );
  assert.equal(
    computeJourneyVersionHash({ meta: GOLDEN_META }),
    "8823399b83eb",
  );
});

test("12-hex determinism", () => {
  const h1 = computeJourneyVersionHash({
    meta: GOLDEN_META,
    body: GOLDEN_BODY,
  });
  const h2 = computeJourneyVersionHash({
    meta: GOLDEN_META,
    body: GOLDEN_BODY,
  });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{12}$/);
});

test("whitespace- and comment-only edits do not fork the hash", () => {
  const a = "async (user) => { /* v1 */ await go(user); }";
  const b = "async (user) => {\n  // v2 comment\n  await   go(user);\n}";
  assert.equal(normalizeRunSource(a), "async (user) => { await go(user); }");
  assert.equal(normalizeRunSource(a), normalizeRunSource(b));
  assert.equal(
    computeJourneyVersionHash({ meta: GOLDEN_META, body: a }),
    computeJourneyVersionHash({ meta: GOLDEN_META, body: b }),
  );
});

test("// inside string literals is NOT stripped", () => {
  assert.equal(
    normalizeRunSource('const u = "https://x.dev//a"; // trailing'),
    'const u = "https://x.dev//a";',
  );
  const withEscapes = 'const s = "a\\"//b"; return s;';
  assert.equal(normalizeRunSource(withEscapes), withEscapes);
});

test("hash forks on every behavior-bearing meta field and on the body", () => {
  const h = (meta: JourneyMeta, body?: string) =>
    computeJourneyVersionHash({ meta, body });
  const H0 = h(GOLDEN_META, GOLDEN_BODY);
  const forks: JourneyMeta[] = [
    { ...GOLDEN_META, trigger: { event: "user.signup" } },
    {
      ...GOLDEN_META,
      trigger: {
        event: "user.created",
        where: [
          { type: "property", property: "plan", operator: "eq", value: "pro" },
        ],
      },
    },
    { ...GOLDEN_META, entryLimit: "unlimited" },
    { ...GOLDEN_META, exitOn: [{ event: "user.churned" }] },
    { ...GOLDEN_META, suppress: { hours: 48 } },
    { ...GOLDEN_META, holdout: { percent: 10 } },
    { ...GOLDEN_META, category: "onboarding" },
    { ...GOLDEN_META, goal: "revenue" },
  ];
  for (const meta of forks) {
    assert.notEqual(h(meta, GOLDEN_BODY), H0);
  }
  assert.notEqual(h(GOLDEN_META, "async () => { await other(); }"), H0);
});

test("display/toggle fields never fork: enabled, name, description, version label", () => {
  const H0 = computeJourneyVersionHash({
    meta: GOLDEN_META,
    body: GOLDEN_BODY,
  });
  const same: JourneyMeta[] = [
    { ...GOLDEN_META, enabled: false },
    { ...GOLDEN_META, name: "Renamed" },
    { ...GOLDEN_META, description: "New copy" },
    { ...GOLDEN_META, version: "v2-label-only" },
    { ...GOLDEN_META, versionHash: "aaaaaaaaaaaa" },
  ];
  for (const meta of same) {
    assert.equal(computeJourneyVersionHash({ meta, body: GOLDEN_BODY }), H0);
  }
});

test("meta key order never forks the hash", () => {
  const reordered = {
    suppress: { hours: 24 },
    entryLimit: "once",
    trigger: { event: "user.created" },
    enabled: true,
    name: "Golden Journey",
    id: "golden-journey",
  } as JourneyMeta;
  assert.equal(
    computeJourneyVersionHash({ meta: reordered, body: GOLDEN_BODY }),
    computeJourneyVersionHash({ meta: GOLDEN_META, body: GOLDEN_BODY }),
  );
});

test("normalizeRunSource never throws and stays deterministic on pathological input", () => {
  // Known limits (spec D1): a // inside a regex literal is misread as a
  // comment start; the scanner exits `template` state at the first
  // backtick, so nested templates / strings / comments inside ${...} are
  // misclassified. In every case the output is a PURE function of the
  // input — determinism is what these assertions lock.
  const cases = [
    'const s = "unterminated',
    "/* never closed",
    "const t = `a${`b`}c`;",
    'const t = `x${ /* c */ "y" }z`;',
    "const re = /a//; more();",
    "",
  ];
  for (const input of cases) {
    const once = normalizeRunSource(input);
    assert.equal(normalizeRunSource(input), once);
    assert.equal(typeof once, "string");
  }
  assert.equal(normalizeRunSource(""), "");
});

test("blueprint graph bodies (URLs, escaped quotes) hash stably", () => {
  const graph = {
    journeyId: "bp-golden",
    nodes: [
      {
        id: "start",
        type: "start",
        title: "start",
        meta: { url: "https://example.com/a//b", note: 'she said "hi"' },
      },
    ],
    edges: [],
  };
  const body = stableStringify(graph);
  // The string-aware scanner protects // inside double-quoted JSON string
  // values, including \" escapes.
  assert.ok(normalizeRunSource(body).includes("https://example.com/a//b"));
  const meta: JourneyMeta = {
    id: "bp-golden",
    name: "Blueprint bp-golden",
    enabled: true,
    trigger: { event: "bp.enroll" },
    entryLimit: "unlimited",
    suppress: {},
  };
  const h1 = computeJourneyVersionHash({ meta, body });
  // jsonb round-trip key reordering cannot fork: stableStringify sorts.
  const reorderedGraph = {
    edges: [],
    nodes: [
      {
        meta: { note: 'she said "hi"', url: "https://example.com/a//b" },
        title: "start",
        type: "start",
        id: "start",
      },
    ],
    journeyId: "bp-golden",
  };
  assert.equal(
    computeJourneyVersionHash({ meta, body: stableStringify(reorderedGraph) }),
    h1,
  );
  assert.equal(h1, "858e91668b94");
});

test("defineJourney attaches the content hash and overwrites any authored value", () => {
  const base: JourneyMetaInput = {
    id: "jv-attach",
    name: "Attach",
    enabled: true,
    trigger: { event: "jv.test" },
    entryLimit: "once",
    suppress: {},
    version: "v1",
  };
  const run = async () => {};
  const j1 = defineJourney({ meta: base, run });
  assert.match(j1.meta.versionHash ?? "", /^[0-9a-f]{12}$/);
  // Self-consistent: recomputing over the attached meta + captured source
  // reproduces the hash (versionHash and version are excluded inputs).
  assert.equal(
    computeJourneyVersionHash({ meta: j1.meta, body: j1.runSource }),
    j1.meta.versionHash,
  );
  // Label-only change: same content hash, new label.
  const j2 = defineJourney({ meta: { ...base, version: "v2" }, run });
  assert.equal(j2.meta.versionHash, j1.meta.versionHash);
  assert.equal(j2.meta.version, "v2");
  // An authored versionHash (JS caller — the type omits it) is overwritten.
  const j3 = defineJourney({
    meta: { ...base, versionHash: "aaaaaaaaaaaa" } as JourneyMetaInput,
    run,
  });
  assert.equal(j3.meta.versionHash, j1.meta.versionHash);
  // A body change forks.
  const j4 = defineJourney({
    meta: base,
    run: async () => {
      return;
    },
  });
  assert.notEqual(j4.meta.versionHash, j1.meta.versionHash);
});
