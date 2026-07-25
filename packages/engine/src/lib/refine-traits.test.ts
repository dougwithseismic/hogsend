import assert from "node:assert/strict";
import test from "node:test";
import type { EnrichmentResult } from "@hogsend/core";
import { flattenTraits, pickRefinedTraits } from "./refine-traits.js";

const REFINED_AT = new Date("2026-07-25T10:00:00.000Z");
const META = { provider: "fake", refinedAt: REFINED_AT };

test("flattenTraits maps every documented field to a flat refined_* key", () => {
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
    refined_title: "VP of Engineering",
    refined_seniority: "vp",
    refined_department: "engineering",
    refined_linkedin_url: "https://linkedin.com/in/x",
    refined_country: "US",
    refined_company_name: "Acme",
    refined_company_domain: "acme.com",
    refined_company_industry: "software",
    refined_company_employees: 250,
    refined_company_revenue: 12_000_000,
    refined_company_country: "US",
    refined_at: "2026-07-25T10:00:00.000Z",
    refined_provider: "fake",
  });
});

// AC 8 — the numeric traits must be REAL JSON numbers. `conditions/property.ts`
// does no coercion, so a `"250"` would silently never match a `gte(100)`.
test("AC 8: employee count is a real JSON number, and survives JSON round-trip", () => {
  const patch = flattenTraits(
    { found: true, company: { employeeCount: 250 }, raw: {} },
    META,
  );

  assert.equal(typeof patch.refined_company_employees, "number");
  assert.equal(patch.refined_company_employees, 250);
  // jsonb storage is a JSON round-trip — the type must survive it.
  const roundTripped = JSON.parse(JSON.stringify(patch));
  assert.equal(typeof roundTripped.refined_company_employees, "number");
  assert.ok((roundTripped.refined_company_employees as number) >= 100);
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

  assert.equal(patch.refined_company_employees, 250);
  assert.equal(typeof patch.refined_company_employees, "number");
});

// AC 9 — an absent field must be OMITTED, never written as null: the patch is
// wrapped in `jsonb_strip_nulls`, so a null DELETES a previously-good key.
test("AC 9: absent fields are omitted from the patch entirely (never null)", () => {
  const patch = flattenTraits(
    { found: true, person: { title: "CTO" }, raw: {} },
    META,
  );

  assert.deepEqual(Object.keys(patch).sort(), [
    "refined_at",
    "refined_provider",
    "refined_title",
  ]);
  assert.equal("refined_seniority" in patch, false);
  assert.equal("refined_company_name" in patch, false);
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

  assert.deepEqual(Object.keys(patch).sort(), [
    "refined_at",
    "refined_department",
    "refined_provider",
  ]);
});

test("a not-found result still stamps only the two synthetic traits", () => {
  assert.deepEqual(flattenTraits({ found: false, raw: null }, META), {
    refined_at: "2026-07-25T10:00:00.000Z",
    refined_provider: "fake",
  });
});

test("pickRefinedTraits returns only the refined_* subset", () => {
  assert.deepEqual(
    pickRefinedTraits({
      plan: "pro",
      refined_title: "CTO",
      refined_company_employees: 250,
    }),
    { refined_title: "CTO", refined_company_employees: 250 },
  );
  assert.deepEqual(pickRefinedTraits(undefined), {});
});
