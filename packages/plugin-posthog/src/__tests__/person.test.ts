import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPerson,
  getPersonProperties,
  type PostHogPersonRecord,
  type PostHogPersonResult,
} from "../properties.js";

const PERSON = {
  id: 4242,
  uuid: "0192f8c1-0000-7000-8000-000000000001",
  distinct_ids: ["anon-018e-aaaa", "user-42"],
  properties: { email: "ada@example.com", plan: "pro" },
};

const CONFIG = {
  host: "https://eu.i.posthog.com",
  projectId: "77",
  personalApiKey: "phx_personal",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Records every fetch, answering project discovery + persons separately. */
function stubFetch(
  personsBody: unknown = { results: [PERSON] },
  personsStatus = 200,
) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/api/projects/@current/")) {
      return jsonResponse({ id: 9001 });
    }
    return jsonResponse(personsBody, personsStatus);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type FetchMock = ReturnType<typeof stubFetch>;

function personCalls(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(([url]) => url.includes("/persons/"));
}

/** The Authorization header the person read went out with. */
function personAuthHeader(fetchMock: FetchMock): string | undefined {
  const init = personCalls(fetchMock)[0]?.[1];
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

/** Narrow to the found arm, failing loudly rather than silently skipping. */
function expectFound(result: PostHogPersonResult): PostHogPersonRecord {
  if (result.status !== "found") {
    throw new Error(`expected a found person, got "${result.status}"`);
  }
  return result.person;
}

describe("getPerson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the whole person record", async () => {
    stubFetch();

    const result = await getPerson({ config: CONFIG, distinctId: "user-42" });

    expect(result).toEqual({
      status: "found",
      person: {
        personId: PERSON.uuid,
        distinctIds: ["anon-018e-aaaa", "user-42"],
        properties: { email: "ada@example.com", plan: "pro" },
      },
    });
  });

  it("keys the person on the canonical uuid, not the row id", async () => {
    // PostHog's `id` is a Postgres row PK; `uuid` is the value every
    // query-shaped surface (HogQL, /query) calls person_id. Keying on `id`
    // makes a later observation through those paths miss the mapping.
    stubFetch();

    const person = expectFound(
      await getPerson({ config: CONFIG, distinctId: "user-42" }),
    );

    expect(person.personId).toBe(PERSON.uuid);
    expect(person.personId).not.toBe("4242");
  });

  it("surfaces every distinct_id, not just the one asked for", async () => {
    // The caller holds ONE of the person's ids; resolution needs the set.
    stubFetch();

    const person = expectFound(
      await getPerson({ config: CONFIG, distinctId: "anon-018e-aaaa" }),
    );

    expect(person.distinctIds).toEqual(["anon-018e-aaaa", "user-42"]);
  });

  it("trims, drops junk and de-duplicates the distinct_id set", async () => {
    stubFetch({
      results: [
        {
          ...PERSON,
          distinct_ids: [" user-42 ", "user-42", "", null, 7, "anon-1"],
        },
      ],
    });

    const person = expectFound(
      await getPerson({ config: CONFIG, distinctId: "user-42" }),
    );

    expect(person.distinctIds).toEqual(["user-42", "anon-1"]);
  });

  it("reports an observed-absent person as absent", async () => {
    stubFetch({ results: [] });

    const result = await getPerson({ config: CONFIG, distinctId: "nobody" });

    expect(result).toEqual({ status: "absent" });
  });

  it("reports a non-ok upstream response as failed, not absent", async () => {
    // Body carries a real person, so dropping the status check would surface
    // it — the assertion below fails rather than passing vacuously.
    stubFetch({ results: [PERSON] }, 429);

    const result = await getPerson({ config: CONFIG, distinctId: "user-42" });

    expect(result).toEqual({
      status: "failed",
      reason: "upstream_error",
      statusCode: 429,
    });
  });

  it("never returns the same value for absent and failed", async () => {
    // DECISIONS §2.6: conflating these is what produces mass-leave.
    stubFetch({ results: [] });
    const absent = await getPerson({ config: CONFIG, distinctId: "nobody" });

    vi.unstubAllGlobals();
    stubFetch({ results: [PERSON] }, 503);
    const failed = await getPerson({ config: CONFIG, distinctId: "user-42" });

    expect(absent.status).toBe("absent");
    expect(failed.status).toBe("failed");
    expect(absent).not.toEqual(failed);
  });

  it("reports a thrown fetch as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await getPerson({ config: CONFIG, distinctId: "user-42" });

    expect(result).toEqual({ status: "failed", reason: "network_error" });
  });

  it("reports a missing credential as failed, not absent", async () => {
    const fetchMock = stubFetch();

    const result = await getPerson({
      config: { host: "https://eu.i.posthog.com", projectId: "77" },
      distinctId: "user-42",
    });

    expect(result).toEqual({ status: "failed", reason: "reads_disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an undiscoverable project as failed, not absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/projects/@current/")) {
          return jsonResponse({ detail: "nope" }, 401);
        }
        return jsonResponse({ results: [PERSON] });
      }),
    );

    const result = await getPerson({
      config: {
        host: "https://no-project-probe.i.posthog.com",
        personalApiKey: "phx_no_project_probe",
      },
      distinctId: "user-42",
    });

    expect(result).toEqual({ status: "failed", reason: "no_project" });
  });

  it("reports a person carrying no uuid as failed, not absent", async () => {
    stubFetch({ results: [{ id: 4242, properties: { plan: "pro" } }] });

    const result = await getPerson({ config: CONFIG, distinctId: "user-42" });

    expect(result).toEqual({ status: "failed", reason: "malformed" });
  });

  it("reads the private host and the environment-scoped path", async () => {
    const fetchMock = stubFetch();

    await getPerson({ config: CONFIG, distinctId: "user a" });

    const url = personCalls(fetchMock)[0]?.[0];
    expect(url).toContain(
      "https://eu.posthog.com/api/environments/77/persons/",
    );
    expect(url).toContain("distinct_id=user+a");
  });

  it("prefers the OAuth token over the personal key", async () => {
    const fetchMock = stubFetch();

    await getPerson({
      config: { ...CONFIG, getAuthToken: async () => "oauth-token" },
      distinctId: "user-42",
    });

    expect(personAuthHeader(fetchMock)).toBe("Bearer oauth-token");
  });

  it("degrades to the personal key when OAuth yields no token", async () => {
    const fetchMock = stubFetch();

    await getPerson({
      config: { ...CONFIG, getAuthToken: async () => null },
      distinctId: "user-42",
    });

    expect(personAuthHeader(fetchMock)).toBe("Bearer phx_personal");
  });

  it("bounds the read with the 10s timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubFetch();

    await getPerson({ config: CONFIG, distinctId: "user-42" });

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it("discovers the project id once per credential", async () => {
    const fetchMock = stubFetch();
    const config = {
      host: "https://person-cache-probe.i.posthog.com",
      personalApiKey: "phx_person_cache_probe",
    };

    const first = await getPerson({ config, distinctId: "user-42" });
    const second = await getPerson({ config, distinctId: "anon-018e-aaaa" });

    expect(expectFound(first).personId).toBe(PERSON.uuid);
    expect(expectFound(second).personId).toBe(PERSON.uuid);
    const discoveries = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/projects/@current/"),
    );
    expect(discoveries).toHaveLength(1);
  });
});

describe("getPersonProperties (unchanged contract)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("still returns properties only, never the person id", async () => {
    stubFetch();

    const result = await getPersonProperties({
      config: CONFIG,
      distinctId: "user-42",
    });

    expect(result).toEqual({ email: "ada@example.com", plan: "pro" });
  });

  it("still soft-fails to {} on a non-ok response", async () => {
    stubFetch({ results: [PERSON] }, 500);

    const result = await getPersonProperties({
      config: CONFIG,
      distinctId: "user-42",
    });

    expect(result).toEqual({});
  });

  it("still returns properties for a person carrying no uuid", async () => {
    // The uuid matters only to the person-id read; a property read must not
    // start failing because of the stricter sibling.
    stubFetch({ results: [{ id: 4242, properties: { plan: "pro" } }] });

    const result = await getPersonProperties({
      config: CONFIG,
      distinctId: "user-42",
    });

    expect(result).toEqual({ plan: "pro" });
  });

  it("caches properties only, so the cached shape stays stable", async () => {
    stubFetch();
    const set = vi.fn(async () => "OK");
    const redis = { get: vi.fn(async () => null), set } as never;

    await getPersonProperties({
      config: CONFIG,
      distinctId: "user-42",
      cache: { redis, ttlSeconds: 60 },
    });

    expect(set).toHaveBeenCalledWith(
      "posthog:person:user-42",
      JSON.stringify({ email: "ada@example.com", plan: "pro" }),
      "EX",
      60,
    );
  });

  it("still caches an observed-absent read as {}", async () => {
    stubFetch({ results: [] });
    const set = vi.fn(async () => "OK");
    const redis = { get: vi.fn(async () => null), set } as never;

    const result = await getPersonProperties({
      config: CONFIG,
      distinctId: "nobody",
      cache: { redis, ttlSeconds: 60 },
    });

    expect(result).toEqual({});
    expect(set).toHaveBeenCalledWith("posthog:person:nobody", "{}", "EX", 60);
  });

  it("does not cache a failed read", async () => {
    stubFetch({ results: [PERSON] }, 500);
    const set = vi.fn(async () => "OK");
    const redis = { get: vi.fn(async () => null), set } as never;

    const result = await getPersonProperties({
      config: CONFIG,
      distinctId: "user-42",
      cache: { redis, ttlSeconds: 60 },
    });

    expect(result).toEqual({});
    expect(set).not.toHaveBeenCalled();
  });
});
