import { describe, expect, expectTypeOf, it } from "vitest";
import {
  defineEnrichmentProvider,
  type EnrichedCompany,
  type EnrichedPerson,
  type EnrichmentProvider,
  type EnrichmentProviderCapabilities,
  type EnrichmentProviderMeta,
  type EnrichmentQuery,
  type EnrichmentResult,
} from "./enrichment.js";

describe("EnrichmentQuery contract (PRD 01 T1.1 — fixed field set)", () => {
  it("pins the field set (all optional, vendor-neutral)", () => {
    expectTypeOf<EnrichmentQuery["email"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<EnrichmentQuery["domain"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<EnrichmentQuery["firstName"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<EnrichmentQuery["lastName"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<EnrichmentQuery["company"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<keyof EnrichmentQuery>().toEqualTypeOf<
      "email" | "domain" | "firstName" | "lastName" | "company"
    >();
  });
});

describe("EnrichedPerson / EnrichedCompany contracts", () => {
  it("pins the person field set", () => {
    expectTypeOf<keyof EnrichedPerson>().toEqualTypeOf<
      | "firstName"
      | "lastName"
      | "title"
      | "seniority"
      | "department"
      | "linkedinUrl"
      | "city"
      | "country"
    >();
  });

  it("pins the company field set with REAL numbers for numeric traits", () => {
    expectTypeOf<keyof EnrichedCompany>().toEqualTypeOf<
      | "name"
      | "domain"
      | "industry"
      | "employeeCount"
      | "estimatedRevenue"
      | "city"
      | "country"
      | "linkedinUrl"
    >();
    // Numeric traits are real JSON numbers — the condition evaluator does no
    // coercion, so a numeric STRING would silently never match a gte.
    expectTypeOf<EnrichedCompany["employeeCount"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<EnrichedCompany["estimatedRevenue"]>().toEqualTypeOf<
      number | undefined
    >();
  });
});

describe("EnrichmentResult contract", () => {
  it("pins found (required boolean) + raw (required, unknown)", () => {
    expectTypeOf<EnrichmentResult["found"]>().toEqualTypeOf<boolean>();
    expectTypeOf<EnrichmentResult["raw"]>().toEqualTypeOf<unknown>();
    expectTypeOf<EnrichmentResult["person"]>().toEqualTypeOf<
      EnrichedPerson | undefined
    >();
    expectTypeOf<EnrichmentResult["company"]>().toEqualTypeOf<
      EnrichedCompany | undefined
    >();
  });
});

describe("EnrichmentProvider contract", () => {
  it("requires meta (id/name) and both capability flags", () => {
    expectTypeOf<EnrichmentProviderMeta["id"]>().toEqualTypeOf<string>();
    expectTypeOf<EnrichmentProviderMeta["name"]>().toEqualTypeOf<string>();
    expectTypeOf<
      EnrichmentProviderCapabilities["personLookup"]
    >().toEqualTypeOf<boolean>();
    expectTypeOf<
      EnrichmentProviderCapabilities["companyLookup"]
    >().toEqualTypeOf<boolean>();
    expectTypeOf<EnrichmentProviderCapabilities["bulk"]>().toEqualTypeOf<
      boolean | undefined
    >();
  });

  it("a minimal conforming provider type-checks (enrichCompany optional)", async () => {
    // No `as EnrichmentProvider` cast anywhere — this literal must conform.
    const provider = defineEnrichmentProvider({
      meta: { id: "fake", name: "Fake" },
      capabilities: { personLookup: true, companyLookup: false },
      async enrichPerson(query) {
        expectTypeOf(query).toEqualTypeOf<EnrichmentQuery>();
        return { found: false, raw: null };
      },
    });
    const result = await provider.enrichPerson({ email: "a@b.com" });
    expect(result.found).toBe(false);
  });

  it("defineEnrichmentProvider returns its argument unchanged (AC 1)", () => {
    const provider: EnrichmentProvider = {
      meta: { id: "fake", name: "Fake", description: "test double" },
      capabilities: { personLookup: true, companyLookup: true, bulk: false },
      async enrichPerson() {
        return {
          found: true,
          person: { title: "CTO", seniority: "c_suite" },
          company: { domain: "acme.com", employeeCount: 42 },
          raw: { vendor: "verbatim" },
        };
      },
      async enrichCompany() {
        return { found: false, raw: null };
      },
    };
    const defined = defineEnrichmentProvider(provider);
    expect(defined).toBe(provider);
    expectTypeOf(defined).toEqualTypeOf<EnrichmentProvider>();
  });
});
