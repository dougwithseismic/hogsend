import {
  defineEnrichmentProvider,
  type EnrichedCompany,
  type EnrichedPerson,
  type EnrichmentProvider,
  type EnrichmentQuery,
  type EnrichmentResult,
} from "@hogsend/core";

/**
 * Apollo.io `EnrichmentProvider` — the reference implementation.
 *
 * A DUMB WIRE: query Apollo, normalize the response, nothing else. All DB,
 * caching, TTL, budget-cap, preference and ingest logic lives in the engine's
 * `refineContact()` pipeline (every lookup costs money and the engine is where
 * that is accounted). Apollo's response shape never leaks past this package —
 * the same discipline `EmailProvider` held against Resend.
 *
 * The person wire was probed live on 2026-07-25 (HTTP 200):
 *
 * ```
 * POST https://api.apollo.io/api/v1/people/match
 * Headers: x-api-key: <key>
 * Body:    { "email": "..." }
 * Returns: { person, request_id }
 * ```
 *
 * Three probe-confirmed traps are handled in the mappers below:
 *
 * 1. `person.departments` is an ARRAY; the neutral `EnrichedPerson.department`
 *    is ONE string — we take the FIRST element deliberately.
 * 2. The company domain is `organization.primary_domain` ("acme.com"), NEVER
 *    `website_url` (a full URL that would poison every domain-keyed lookup —
 *    `refineContact` uses the domain as a cache key).
 * 3. `person.linkedin_url` can be null while `organization.linkedin_url` is
 *    populated — they are independent, and a null is OMITTED, never emitted
 *    (downstream `jsonb_strip_nulls` turns a written null into a DELETE of an
 *    existing good value on the contact).
 */

export interface ApolloProviderConfig {
  /** Apollo API key — sent as the `x-api-key` header (probed auth mechanism). */
  apiKey: string;
  /** Override the API origin (tests). Default `https://api.apollo.io`. */
  baseUrl?: string;
  /** Override fetch (tests) — the whole suite runs offline through this. */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.apollo.io";

/** Non-empty string, else undefined (so `compact` omits the key entirely). */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Coerce to a real JSON number. The probe returned real numbers for
 * `estimated_num_employees` / `annual_revenue`, so the string branch is a
 * defensive guard — kept because the engine's property-condition evaluator
 * does NO coercion: a `"250"` written into a trait silently never matches a
 * `gte` bucket condition.
 */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Drop undefined-valued keys, so a missing/null vendor field is ABSENT from
 * the result rather than present-with-null (trap 3 above).
 */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
}

/** Normalize Apollo's `person` object → vendor-neutral {@link EnrichedPerson}. */
function mapPerson(p: Record<string, unknown>): EnrichedPerson {
  const departments = p.departments;
  return compact({
    firstName: str(p.first_name),
    lastName: str(p.last_name),
    title: str(p.title),
    seniority: str(p.seniority),
    // TRAP 1: Apollo's `departments` is an ARRAY of strings; the neutral
    // contract carries ONE `department` string (an array written into the
    // jsonb trait would make every `eq` condition fail silently, forever).
    // We deliberately map the FIRST element — Apollo lists the primary
    // function first. The full array survives untouched in `raw`.
    department: str(Array.isArray(departments) ? departments[0] : departments),
    // TRAP 3: independent of organization.linkedin_url; null → key omitted.
    linkedinUrl: str(p.linkedin_url),
    city: str(p.city),
    country: str(p.country),
  });
}

/**
 * Normalize Apollo's `organization` object → vendor-neutral
 * {@link EnrichedCompany}. Used for both the nested `person.organization` on a
 * people/match and the top-level `organization` on a company enrich.
 */
function mapCompany(o: Record<string, unknown>): EnrichedCompany {
  return compact({
    name: str(o.name),
    // TRAP 2: the domain is `primary_domain` ("acme.com"), NEVER `website_url`
    // ("https://www.acme.com") — the engine keys domain lookups on this value.
    domain: str(o.primary_domain),
    industry: str(o.industry),
    // AC 6: real JSON numbers only — see `num()`.
    employeeCount: num(o.estimated_num_employees),
    estimatedRevenue: num(o.annual_revenue),
    city: str(o.city),
    country: str(o.country),
    linkedinUrl: str(o.linkedin_url),
  });
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Build the Apollo `EnrichmentProvider`. `fetch` is injectable so every test
 * drives recorded fixtures with no network and no key (the plugin-attio
 * pattern); `baseUrl` exists for the same reason.
 */
export function createApolloProvider(
  config: ApolloProviderConfig,
): EnrichmentProvider {
  const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = config.fetch ?? fetch;

  async function api(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<unknown> {
    const res = await fetchImpl(`${base}${path}`, {
      method: init.method,
      headers: {
        // Probed auth mechanism (2026-07-25, HTTP 200): header, not Bearer.
        "x-api-key": config.apiKey,
        Accept: "application/json",
        ...(init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) {
      // Status code ONLY — `refineContact` needs it to record an `error`
      // ledger row. Deliberately no response-body echo and no config detail:
      // the API key must never appear in a thrown message or log line.
      throw new Error(
        `Apollo ${init.method} ${path.split("?")[0]} failed with status ${res.status}`,
      );
    }
    return await res.json();
  }

  return defineEnrichmentProvider({
    meta: {
      id: "apollo",
      name: "Apollo",
      description:
        "Apollo.io person + company enrichment via people/match, normalized to the vendor-neutral EnrichmentResult.",
    },
    capabilities: {
      personLookup: true,
      companyLookup: true,
    },

    async enrichPerson(query: EnrichmentQuery): Promise<EnrichmentResult> {
      const raw = await api("/api/v1/people/match", {
        method: "POST",
        body: compact({
          email: query.email,
          first_name: query.firstName,
          last_name: query.lastName,
          domain: query.domain,
          organization_name: query.company,
        }),
      });
      const person = asRecord(asRecord(raw)?.person);
      if (!person) {
        // AC 2: no match is a LEGITIMATE, billable answer — never a throw.
        return { found: false, raw };
      }
      const organization = asRecord(person.organization);
      return {
        found: true,
        person: mapPerson(person),
        ...(organization ? { company: mapCompany(organization) } : {}),
        raw,
      };
    },

    /**
     * Company-only lookup from a bare domain. NOTE: the 2026-07-25 probe
     * covered people/match only; this endpoint follows Apollo's documented
     * Organization Enrichment API (`GET /api/v1/organizations/enrich?domain=`)
     * and is exercised against fixtures — verify live in the PRD 07 smoke.
     */
    async enrichCompany(domain: string): Promise<EnrichmentResult> {
      const raw = await api(
        `/api/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
        { method: "GET" },
      );
      const organization = asRecord(asRecord(raw)?.organization);
      if (!organization) {
        return { found: false, raw };
      }
      return { found: true, company: mapCompany(organization), raw };
    },
  });
}
