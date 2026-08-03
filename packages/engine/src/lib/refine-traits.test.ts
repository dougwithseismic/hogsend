import assert from "node:assert/strict";
import test from "node:test";
import type { EnrichmentResult } from "@hogsend/core";
import { canonicalizeStoredTraits, flattenTraits } from "./refine-traits.js";

const REFINED_AT = new Date("2026-07-25T10:00:00.000Z");
const META = { provider: "fake", refinedAt: REFINED_AT };
const ENRICHMENT = { provider: "fake", at: "2026-07-25T10:00:00.000Z" };

test("flattenTraits maps every documented field to a canonical key", () => {
  const result: EnrichmentResult = {
    found: true,
    person: {
      title: "VP of Engineering",
      seniority: "vp",
      department: "engineering",
      linkedinUrl: "https://linkedin.com/in/x",
      country: "US",
    },
    company: {
      name: "Acme",
      domain: "acme.com",
      industry: "software",
      employeeCount: 250,
      estimatedRevenue: 12_000_000,
      country: "US",
    },
    raw: {},
  };

  assert.deepEqual(flattenTraits(result, META), {
    title: "VP of Engineering",
    seniority: "vp",
    department: "engineering",
    linkedin_url: "https://linkedin.com/in/x",
    country: "US",
    company: "Acme",
    company_domain: "acme.com",
    company_industry: "software",
    company_employees: 250,
    company_revenue: 12_000_000,
    company_country: "US",
    enrichment: ENRICHMENT,
  });
});

// The facts are FLAT top-level keys, never nested: `evaluatePropertyConditions`
// does `properties[condition.property]` with no dotted-path traversal, so a
// bucket must be able to author `b.prop("company_industry")` verbatim.
test("facts are flat top-level keys; only provenance nests under `enrichment`", () => {
  const patch = flattenTraits(
    {
      found: true,
      person: { seniority: "vp" },
      company: { industry: "software", employeeCount: 250 },
      raw: {},
    },
    META,
  );

  assert.equal(patch.seniority, "vp");
  assert.equal(patch.company_industry, "software");
  assert.equal(patch.company_employees, 250);
  // No parallel `refined_*` vocabulary, no dotted keys.
  for (const key of Object.keys(patch)) {
    assert.ok(
      !key.startsWith("refined_"),
      `${key} must not be refined_-prefixed`,
    );
    assert.ok(
      key === "enrichment" || !key.includes("."),
      `${key} must be flat`,
    );
  }
  assert.deepEqual(patch.enrichment, ENRICHMENT);
});

// AC 8 — the numeric traits must be REAL JSON numbers. `conditions/property.ts`
// does no coercion, so a `"250"` would silently never match a `gte(100)`.
test("AC 8: employee count is a real JSON number, and survives JSON round-trip", () => {
  const patch = flattenTraits(
    { found: true, company: { employeeCount: 250 }, raw: {} },
    META,
  );

  assert.equal(typeof patch.company_employees, "number");
  assert.equal(patch.company_employees, 250);
  // jsonb storage is a JSON round-trip — the type must survive it.
  const roundTripped = JSON.parse(JSON.stringify(patch));
  assert.equal(typeof roundTripped.company_employees, "number");
  assert.ok((roundTripped.company_employees as number) >= 100);
});

test("AC 8: a numeric STRING from an untyped provider is coerced to a number", () => {
  const patch = flattenTraits(
    {
      found: true,
      // A JS (untyped) provider can hand back a numeric string; writing it
      // verbatim would break every `gte` bucket silently.
      company: { employeeCount: "250" as unknown as number },
      raw: {},
    },
    META,
  );

  assert.equal(patch.company_employees, 250);
  assert.equal(typeof patch.company_employees, "number");
});

// AC 9 — an absent field must be OMITTED, never written as null: the patch is
// wrapped in `jsonb_strip_nulls`, so a null DELETES a previously-good key.
test("AC 9: absent fields are omitted from the patch entirely (never null)", () => {
  const patch = flattenTraits(
    { found: true, person: { title: "CTO" }, raw: {} },
    META,
  );

  assert.deepEqual(Object.keys(patch).sort(), ["enrichment", "title"]);
  assert.equal("seniority" in patch, false);
  assert.equal("company" in patch, false);
  for (const value of Object.values(patch)) {
    assert.notEqual(value, null);
  }
});

test("AC 9: null / empty-string / non-finite fields are omitted, not written", () => {
  const patch = flattenTraits(
    {
      found: true,
      person: {
        title: null as unknown as string,
        seniority: "   ",
        department: "sales",
      },
      company: {
        employeeCount: Number.NaN,
        estimatedRevenue: "not-a-number" as unknown as number,
      },
      raw: {},
    },
    META,
  );

  assert.deepEqual(Object.keys(patch).sort(), ["department", "enrichment"]);
});

test("a not-found result still stamps only the provenance object", () => {
  assert.deepEqual(flattenTraits({ found: false, raw: null }, META), {
    enrichment: ENRICHMENT,
  });
});

test("canonicalizeStoredTraits translates a pre-canonical (refined_*) ledger patch", () => {
  assert.deepEqual(
    canonicalizeStoredTraits({
      refined_title: "CTO",
      refined_company_name: "Acme",
      refined_company_employees: 250,
      refined_at: "2026-01-01T00:00:00.000Z",
      refined_provider: "apollo",
    }),
    { title: "CTO", company: "Acme", company_employees: 250 },
  );
});

test("canonicalizeStoredTraits leaves an already-canonical patch untouched (by reference)", () => {
  const canonical = {
    title: "CTO",
    company_employees: 250,
    enrichment: ENRICHMENT,
  };
  // No legacy key → returns the SAME object, no needless copy.
  assert.equal(canonicalizeStoredTraits(canonical), canonical);
});
