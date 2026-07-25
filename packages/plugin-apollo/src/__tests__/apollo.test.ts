import { describe, expect, it } from "vitest";
import { createApolloProvider } from "../index.js";

const API_KEY = "apollo-test-secret-key-XYZZY";

// ---------------------------------------------------------------------------
// Fixtures — hand-authored with the PROBED shape (2026-07-25) and synthetic
// values. The raw probe response is a real person's contact data and is
// deliberately NOT committed.
// ---------------------------------------------------------------------------

/**
 * A full match, exercising all three probe-confirmed traps:
 * - `departments` is an ARRAY (two entries, so a raw assignment is
 *   distinguishable from mapping the first element)
 * - `organization.website_url` is a full URL alongside `primary_domain`
 * - `person.linkedin_url` is NULL while `organization.linkedin_url` is set
 */
const MATCH_RESPONSE = {
  person: {
    id: "p_fixture_1",
    first_name: "Avery",
    last_name: "Quinn",
    title: "VP of Engineering",
    seniority: "vp",
    departments: ["engineering", "information_technology"],
    linkedin_url: null,
    city: "Lisbon",
    state: "Lisbon",
    country: "Portugal",
    email: "avery.quinn@acme-rockets.test",
    organization_id: "o_fixture_1",
    organization: {
      id: "o_fixture_1",
      name: "Acme Rockets",
      website_url: "https://www.acme-rockets.test",
      primary_domain: "acme-rockets.test",
      industry: "aerospace",
      estimated_num_employees: 250,
      annual_revenue: 12500000,
      city: "Lisbon",
      country: "Portugal",
      linkedin_url: "https://www.linkedin.com/company/acme-rockets",
    },
  },
  request_id: "req_fixture_match",
};

/** Same shape with the numeric fields as STRINGS (AC 6's defensive guard). */
const STRINGY_NUMBERS_RESPONSE = {
  person: {
    id: "p_fixture_2",
    first_name: "Noa",
    last_name: "Reyes",
    departments: ["marketing"],
    organization: {
      name: "Beacon Analytics",
      primary_domain: "beacon-analytics.test",
      estimated_num_employees: "480",
      annual_revenue: "9600000",
    },
  },
  request_id: "req_fixture_stringy",
};

const NO_MATCH_RESPONSE = {
  person: null,
  request_id: "req_fixture_nomatch",
};

const COMPANY_MATCH_RESPONSE = {
  organization: {
    id: "o_fixture_3",
    name: "Cobalt Freight",
    website_url: "https://cobalt-freight.test/home",
    primary_domain: "cobalt-freight.test",
    industry: "logistics",
    estimated_num_employees: 1200,
    annual_revenue: 88000000,
    city: "Rotterdam",
    country: "Netherlands",
    linkedin_url: "https://www.linkedin.com/company/cobalt-freight",
  },
};

const COMPANY_NO_MATCH_RESPONSE = { organization: null };

// ---------------------------------------------------------------------------
// Injected-fetch harness — the whole suite runs offline, no key, no network.
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { impl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function providerWith(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const { impl, calls } = stubFetch(respond);
  const provider = createApolloProvider({ apiKey: API_KEY, fetch: impl });
  return { provider, calls };
}

/** Recursively assert no null value survives normalization (trap 3). */
function expectNoNulls(obj: object): void {
  for (const value of Object.values(obj)) {
    expect(value).not.toBeNull();
  }
}

// ---------------------------------------------------------------------------
// enrichPerson
// ---------------------------------------------------------------------------

describe("createApolloProvider · enrichPerson", () => {
  it("AC 1: a match returns found:true with person + company mapped and verbatim raw", async () => {
    const { provider } = providerWith(() => jsonResponse(MATCH_RESPONSE));
    const result = await provider.enrichPerson({
      email: "avery.quinn@acme-rockets.test",
    });

    expect(result.found).toBe(true);
    expect(result.person).toEqual({
      firstName: "Avery",
      lastName: "Quinn",
      title: "VP of Engineering",
      seniority: "vp",
      department: "engineering",
      city: "Lisbon",
      country: "Portugal",
    });
    expect(result.company).toEqual({
      name: "Acme Rockets",
      domain: "acme-rockets.test",
      industry: "aerospace",
      employeeCount: 250,
      estimatedRevenue: 12500000,
      city: "Lisbon",
      country: "Portugal",
      linkedinUrl: "https://www.linkedin.com/company/acme-rockets",
    });
    // Verbatim response body, untouched.
    expect(result.raw).toEqual(MATCH_RESPONSE);
  });

  it("trap 1: the departments ARRAY maps to its FIRST element as a single string", async () => {
    const { provider } = providerWith(() => jsonResponse(MATCH_RESPONSE));
    const result = await provider.enrichPerson({ email: "a@b.test" });

    // The fixture carries TWO departments — a raw array assignment (or a
    // join) cannot satisfy this exact-string assertion.
    expect(result.person?.department).toBe("engineering");
    expect(typeof result.person?.department).toBe("string");
  });

  it("trap 2: company.domain comes from primary_domain, never website_url", async () => {
    const { provider } = providerWith(() => jsonResponse(MATCH_RESPONSE));
    const result = await provider.enrichPerson({ email: "a@b.test" });

    // website_url ("https://www.acme-rockets.test") must not leak into the
    // domain — refineContact keys its lookup cache on this value.
    expect(result.company?.domain).toBe("acme-rockets.test");
  });

  it("trap 3: a null person.linkedin_url is OMITTED while organization.linkedin_url maps", async () => {
    const { provider } = providerWith(() => jsonResponse(MATCH_RESPONSE));
    const result = await provider.enrichPerson({ email: "a@b.test" });

    // Absent, not present-with-null: downstream jsonb_strip_nulls turns a
    // written null into a DELETE of an existing good contact value.
    expect(result.person).not.toHaveProperty("linkedinUrl");
    expect(result.company?.linkedinUrl).toBe(
      "https://www.linkedin.com/company/acme-rockets",
    );
    expectNoNulls(result.person ?? {});
    expectNoNulls(result.company ?? {});
  });

  it("AC 2: no match returns found:false with person/company undefined and does not throw", async () => {
    const { provider } = providerWith(() => jsonResponse(NO_MATCH_RESPONSE));
    const result = await provider.enrichPerson({ email: "ghost@nowhere.test" });

    expect(result.found).toBe(false);
    expect(result.person).toBeUndefined();
    expect(result.company).toBeUndefined();
    expect(result.raw).toEqual(NO_MATCH_RESPONSE);
  });

  it("AC 3: a 401 throws with the status code in the message", async () => {
    const { provider } = providerWith(() =>
      jsonResponse({ error: "unauthorized" }, 401),
    );
    await expect(provider.enrichPerson({ email: "a@b.test" })).rejects.toThrow(
      /401/,
    );
  });

  it("AC 3: a 429 throws with the status code in the message", async () => {
    const { provider } = providerWith(() =>
      jsonResponse({ error: "rate limited" }, 429),
    );
    await expect(provider.enrichPerson({ email: "a@b.test" })).rejects.toThrow(
      /429/,
    );
  });

  it("AC 4: sends the key as the x-api-key header on the probed endpoint", async () => {
    const { provider, calls } = providerWith(() =>
      jsonResponse(MATCH_RESPONSE),
    );
    await provider.enrichPerson({ email: "avery.quinn@acme-rockets.test" });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://api.apollo.io/api/v1/people/match");
    expect(call?.init?.method).toBe("POST");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(API_KEY);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      email: "avery.quinn@acme-rockets.test",
    });
  });

  it("AC 4: the key never appears in a thrown error message — even when Apollo echoes it", async () => {
    // Worst case: the vendor echoes the key back in the error body. The
    // thrown message must still not contain it.
    const { provider } = providerWith(() =>
      jsonResponse({ error: `bad key ${API_KEY}` }, 401),
    );
    const error = await provider
      .enrichPerson({ email: "a@b.test" })
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/401/);
    expect(error?.message).not.toContain(API_KEY);
    expect(String(error)).not.toContain(API_KEY);
  });

  it("maps the neutral query fields to Apollo's body keys and omits absent ones", async () => {
    const { provider, calls } = providerWith(() =>
      jsonResponse(NO_MATCH_RESPONSE),
    );
    await provider.enrichPerson({
      firstName: "Avery",
      lastName: "Quinn",
      domain: "acme-rockets.test",
      company: "Acme Rockets",
    });

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      first_name: "Avery",
      last_name: "Quinn",
      domain: "acme-rockets.test",
      organization_name: "Acme Rockets",
    });
  });

  it("AC 6: stringy numeric fields are coerced to real JSON numbers", async () => {
    const { provider } = providerWith(() =>
      jsonResponse(STRINGY_NUMBERS_RESPONSE),
    );
    const result = await provider.enrichPerson({ email: "noa@beacon.test" });

    expect(result.company?.employeeCount).toBe(480);
    expect(result.company?.estimatedRevenue).toBe(9600000);
    expect(typeof result.company?.employeeCount).toBe("number");
    expect(typeof result.company?.estimatedRevenue).toBe("number");
  });

  it("AC 6: a non-numeric string in a numeric field is omitted, not passed through", async () => {
    const { provider } = providerWith(() =>
      jsonResponse({
        person: {
          first_name: "Kai",
          departments: ["sales"],
          organization: {
            name: "Drift Tally",
            primary_domain: "drift-tally.test",
            estimated_num_employees: "unknown",
            annual_revenue: null,
          },
        },
        request_id: "req_fixture_junk",
      }),
    );
    const result = await provider.enrichPerson({ email: "kai@drift.test" });

    expect(result.company).not.toHaveProperty("employeeCount");
    expect(result.company).not.toHaveProperty("estimatedRevenue");
  });

  it("honours a baseUrl override (trailing slash stripped)", async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(NO_MATCH_RESPONSE));
    const provider = createApolloProvider({
      apiKey: API_KEY,
      baseUrl: "https://apollo-proxy.internal.test/",
      fetch: impl,
    });
    await provider.enrichPerson({ email: "a@b.test" });

    expect(calls[0]?.url).toBe(
      "https://apollo-proxy.internal.test/api/v1/people/match",
    );
  });
});

// ---------------------------------------------------------------------------
// enrichCompany
// ---------------------------------------------------------------------------

describe("createApolloProvider · enrichCompany", () => {
  it("a match returns found:true with the company mapped from primary_domain and verbatim raw", async () => {
    const { provider, calls } = providerWith(() =>
      jsonResponse(COMPANY_MATCH_RESPONSE),
    );
    const result = await provider.enrichCompany?.("cobalt-freight.test");

    expect(calls[0]?.url).toBe(
      "https://api.apollo.io/api/v1/organizations/enrich?domain=cobalt-freight.test",
    );
    expect(calls[0]?.init?.method).toBe("GET");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(API_KEY);

    expect(result?.found).toBe(true);
    expect(result?.person).toBeUndefined();
    expect(result?.company).toEqual({
      name: "Cobalt Freight",
      domain: "cobalt-freight.test",
      industry: "logistics",
      employeeCount: 1200,
      estimatedRevenue: 88000000,
      city: "Rotterdam",
      country: "Netherlands",
      linkedinUrl: "https://www.linkedin.com/company/cobalt-freight",
    });
    expect(result?.raw).toEqual(COMPANY_MATCH_RESPONSE);
  });

  it("no match returns found:false and does not throw", async () => {
    const { provider } = providerWith(() =>
      jsonResponse(COMPANY_NO_MATCH_RESPONSE),
    );
    const result = await provider.enrichCompany?.("nowhere.test");

    expect(result?.found).toBe(false);
    expect(result?.company).toBeUndefined();
  });

  it("a non-2xx throws with the status code and without the key", async () => {
    const { provider } = providerWith(() => jsonResponse({}, 500));
    const error = await provider
      .enrichCompany?.("cobalt-freight.test")
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(error?.message).toMatch(/500/);
    expect(error?.message).not.toContain(API_KEY);
  });
});

// ---------------------------------------------------------------------------
// Identity + capabilities
// ---------------------------------------------------------------------------

describe("createApolloProvider · meta + capabilities", () => {
  it("AC 5: reports personLookup:true and companyLookup:true under id 'apollo'", () => {
    const provider = createApolloProvider({ apiKey: API_KEY });

    expect(provider.meta.id).toBe("apollo");
    expect(provider.capabilities.personLookup).toBe(true);
    expect(provider.capabilities.companyLookup).toBe(true);
    // companyLookup:true is honest — the method is actually present.
    expect(typeof provider.enrichCompany).toBe("function");
  });
});
