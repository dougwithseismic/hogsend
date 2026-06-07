import { beforeEach, describe, expect, it, vi } from "vitest";
import { HogsendAPIError, RateLimitError } from "../errors.js";
import { Hogsend } from "../hogsend.js";

// ---------------------------------------------------------------------------
// Fetch mock harness
// ---------------------------------------------------------------------------

interface MockResponseSpec {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** When set, the fetch rejects (transport failure). */
  throws?: Error;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(spec: MockResponseSpec) {
  const calls: RecordedCall[] = [];

  const fetchImpl = vi.fn(
    async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(
          init.headers as Record<string, string>,
        )) {
          headers[k] = v;
        }
      }
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      });

      if (spec.throws) throw spec.throws;

      const status = spec.status ?? 200;
      const text = spec.body === undefined ? "" : JSON.stringify(spec.body);
      const resHeaders = new Headers(spec.headers ?? {});
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: resHeaders,
        async text() {
          return text;
        },
      } as unknown as Response;
    },
  );

  return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch): Hogsend {
  return new Hogsend({
    baseUrl: "https://api.test.local",
    apiKey: "hsk_test_key",
    fetch: fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("Hogsend construction", () => {
  it("requires baseUrl and apiKey", () => {
    // @ts-expect-error missing apiKey
    expect(() => new Hogsend({ baseUrl: "x" })).toThrow(/apiKey/);
    // @ts-expect-error missing baseUrl
    expect(() => new Hogsend({ apiKey: "x" })).toThrow(/baseUrl/);
  });

  it("strips a trailing slash from baseUrl", async () => {
    const { fetchImpl, calls } = makeFetch({ body: { lists: [] } });
    const hs = new Hogsend({
      baseUrl: "https://api.test.local/",
      apiKey: "hsk_x",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await hs.lists.list();
    expect(calls[0]?.url).toBe("https://api.test.local/v1/lists");
  });

  it("sends the Bearer token on every request", async () => {
    const { fetchImpl, calls } = makeFetch({ body: { lists: [] } });
    await client(fetchImpl as unknown as typeof fetch).lists.list();
    expect(calls[0]?.headers.Authorization).toBe("Bearer hsk_test_key");
  });
});

// ---------------------------------------------------------------------------
// contacts
// ---------------------------------------------------------------------------

describe("contacts", () => {
  it("upsert PUTs to /v1/contacts and returns the result", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { id: "c_1", created: true, linked: false },
    });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).contacts.upsert({
      email: "a@b.com",
      properties: { plan: "pro" },
      lists: { newsletter: true },
    });
    expect(res).toEqual({ id: "c_1", created: true, linked: false });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/contacts");
    expect(calls[0]?.body).toEqual({
      email: "a@b.com",
      userId: undefined,
      properties: { plan: "pro" },
      lists: { newsletter: true },
    });
  });

  it("find GETs /v1/contacts/find with the query and unwraps contacts", async () => {
    const contact = {
      id: "c_1",
      externalId: "u_1",
      email: "a@b.com",
      properties: {},
      firstSeenAt: null,
      lastSeenAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const { fetchImpl, calls } = makeFetch({ body: { contacts: [contact] } });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).contacts.find({ userId: "u_1" });
    expect(res).toEqual([contact]);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/contacts/find?userId=u_1",
    );
  });

  it("delete DELETEs /v1/contacts and returns deleted", async () => {
    const { fetchImpl, calls } = makeFetch({ body: { deleted: true } });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).contacts.delete({ email: "a@b.com" });
    expect(res).toEqual({ deleted: true });
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.body).toEqual({ email: "a@b.com", userId: undefined });
  });

  it("rejects an empty identity at runtime", async () => {
    const { fetchImpl } = makeFetch({ body: {} });
    await expect(
      // @ts-expect-error empty identity is a type error too
      client(fetchImpl as unknown as typeof fetch).contacts.upsert({}),
    ).rejects.toThrow(/identity is required/);
  });
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

describe("events", () => {
  it("send POSTs /v1/events with both property bags", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { stored: true, exits: [] },
    });
    const res = await client(fetchImpl as unknown as typeof fetch).events.send({
      userId: "u_1",
      name: "signup",
      eventProperties: { plan: "pro" },
      contactProperties: { country: "GB" },
    });
    expect(res).toEqual({ stored: true, exits: [] });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/events");
    expect(calls[0]?.body).toMatchObject({
      name: "signup",
      userId: "u_1",
      eventProperties: { plan: "pro" },
      contactProperties: { country: "GB" },
    });
  });

  it("sends the Idempotency-Key header when an idempotencyKey is given", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { stored: true, exits: [] },
    });
    await client(fetchImpl as unknown as typeof fetch).events.send({
      email: "a@b.com",
      name: "signup",
      idempotencyKey: "evt_123",
    });
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("evt_123");
  });

  it("track is an alias of send", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { stored: true, exits: [] },
    });
    await client(fetchImpl as unknown as typeof fetch).events.track({
      userId: "u_1",
      name: "ping",
    });
    expect(calls[0]?.url).toBe("https://api.test.local/v1/events");
    expect(calls[0]?.body).toMatchObject({ name: "ping", userId: "u_1" });
  });
});

// ---------------------------------------------------------------------------
// emails
// ---------------------------------------------------------------------------

describe("emails", () => {
  it("send POSTs /v1/emails and returns the send result", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { emailSendId: "es_1", status: "queued" },
    });
    const res = await client(fetchImpl as unknown as typeof fetch).emails.send({
      to: "a@b.com",
      template: "welcome",
      props: { name: "Ada" },
    });
    expect(res).toEqual({ emailSendId: "es_1", status: "queued" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/emails");
    expect(calls[0]?.body).toMatchObject({
      to: "a@b.com",
      template: "welcome",
      props: { name: "Ada" },
    });
  });
});

// ---------------------------------------------------------------------------
// lists
// ---------------------------------------------------------------------------

describe("lists", () => {
  it("list GETs /v1/lists and unwraps lists", async () => {
    const lists = [
      { id: "newsletter", name: "Newsletter", defaultOptIn: true },
    ];
    const { fetchImpl, calls } = makeFetch({ body: { lists } });
    const res = await client(fetchImpl as unknown as typeof fetch).lists.list();
    expect(res).toEqual(lists);
    expect(calls[0]?.url).toBe("https://api.test.local/v1/lists");
  });

  it("subscribe POSTs the subscribe path and returns { subscribed }", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { list: "newsletter", subscribed: true },
    });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).lists.subscribe({ list: "newsletter", email: "a@b.com" });
    expect(res).toEqual({ subscribed: true });
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/lists/newsletter/subscribe",
    );
  });

  it("unsubscribe maps subscribed:false to { unsubscribed: true }", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { list: "newsletter", subscribed: false },
    });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).lists.unsubscribe({ list: "newsletter", userId: "u_1" });
    expect(res).toEqual({ unsubscribed: true });
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/lists/newsletter/unsubscribe",
    );
  });

  it("url-encodes the list id", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { list: "a/b", subscribed: true },
    });
    await client(fetchImpl as unknown as typeof fetch).lists.subscribe({
      list: "a/b",
      email: "a@b.com",
    });
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/lists/a%2Fb/subscribe",
    );
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe("error mapping", () => {
  it("maps a non-2xx response to HogsendAPIError with status + body", async () => {
    const { fetchImpl } = makeFetch({
      status: 400,
      body: { error: "email or userId required" },
    });
    const err = await client(fetchImpl as unknown as typeof fetch)
      .contacts.upsert({ email: "a@b.com" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HogsendAPIError);
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ error: "email or userId required" });
    expect(err.message).toContain("email or userId required");
  });

  it("maps a 429 to RateLimitError with parsed Retry-After", async () => {
    const { fetchImpl } = makeFetch({
      status: 429,
      body: { error: "rate limited" },
      headers: { "Retry-After": "12" },
    });
    const err = await client(fetchImpl as unknown as typeof fetch)
      .emails.send({ to: "a@b.com", template: "welcome", props: {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).toBeInstanceOf(HogsendAPIError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(12);
  });

  it("429 without a Retry-After header leaves retryAfter undefined", async () => {
    const { fetchImpl } = makeFetch({ status: 429, body: {} });
    const err = await client(fetchImpl as unknown as typeof fetch)
      .lists.list()
      .catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBeUndefined();
  });

  it("maps a transport failure to status 0", async () => {
    const { fetchImpl } = makeFetch({
      throws: new Error("ECONNREFUSED"),
    });
    const err = await client(fetchImpl as unknown as typeof fetch)
      .lists.list()
      .catch((e) => e);
    expect(err).toBeInstanceOf(HogsendAPIError);
    expect(err.status).toBe(0);
    expect(err.message).toContain("cannot reach");
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("timeout", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("aborts and surfaces a transport (status 0) error on timeout", async () => {
    const slowFetch = vi.fn(
      (_input: string | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const hs = new Hogsend({
      baseUrl: "https://api.test.local",
      apiKey: "hsk_x",
      fetch: slowFetch as unknown as typeof fetch,
      timeoutMs: 5,
    });
    const err = await hs.lists.list().catch((e) => e);
    expect(err).toBeInstanceOf(HogsendAPIError);
    expect(err.status).toBe(0);
  });
});
