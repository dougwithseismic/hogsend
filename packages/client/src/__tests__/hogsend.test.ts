import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HogsendAPIError, RateLimitError } from "../errors.js";
import { Hogsend } from "../hogsend.js";
import { verifyHogsendWebhook } from "../internal/verify.js";
import type { LinkQrOptions } from "../types.js";

// ---------------------------------------------------------------------------
// Fetch mock harness
// ---------------------------------------------------------------------------

interface MockResponseSpec {
  status?: number;
  body?: unknown;
  /** Raw response bytes served by `arrayBuffer()` (image/QR responses). */
  bytes?: Uint8Array;
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
        async arrayBuffer() {
          if (spec.bytes) return spec.bytes.slice().buffer;
          return new TextEncoder().encode(text).buffer;
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
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
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
      value: 99.5,
      currency: "GBP",
    });
    expect(res).toEqual({ stored: true, exits: [] });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/events");
    expect(calls[0]?.body).toMatchObject({
      name: "signup",
      userId: "u_1",
      eventProperties: { plan: "pro" },
      contactProperties: { country: "GB" },
      value: 99.5,
      currency: "GBP",
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
  it("list GETs /v1/lists and unwraps lists, passing through `kind`", async () => {
    const lists = [
      {
        id: "newsletter",
        name: "Newsletter",
        defaultOptIn: true,
        kind: "topic",
      },
      { id: "in_app", name: "In-app", defaultOptIn: true, kind: "channel" },
    ];
    const { fetchImpl, calls } = makeFetch({ body: { lists } });
    const res = await client(fetchImpl as unknown as typeof fetch).lists.list();
    expect(res).toEqual(lists);
    // `kind` is carried through verbatim (channel vs topic).
    expect(res[1]?.kind).toBe("channel");
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
// campaigns
// ---------------------------------------------------------------------------

describe("campaigns", () => {
  it("send POSTs /v1/campaigns for a list audience and returns the ack", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { campaignId: "cmp_1", status: "queued" },
    });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).campaigns.send({
      name: "June newsletter",
      list: "newsletter",
      template: "welcome",
      props: { name: "Ada" },
    });
    expect(res).toEqual({ campaignId: "cmp_1", status: "queued" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/campaigns");
    expect(calls[0]?.body).toMatchObject({
      name: "June newsletter",
      list: "newsletter",
      template: "welcome",
      props: { name: "Ada" },
    });
    // A list send never carries a bucket selector.
    expect((calls[0]?.body as { bucket?: string }).bucket).toBeUndefined();
  });

  it("send POSTs /v1/campaigns for a bucket audience", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { campaignId: "cmp_2", status: "queued" },
    });
    await client(fetchImpl as unknown as typeof fetch).campaigns.send({
      bucket: "power-users",
      template: "welcome",
      props: {},
    });
    expect(calls[0]?.body).toMatchObject({
      bucket: "power-users",
      template: "welcome",
    });
    expect((calls[0]?.body as { list?: string }).list).toBeUndefined();
  });

  it("get GETs /v1/campaigns/{id} and url-encodes the id", async () => {
    const campaign = {
      id: "cmp_1",
      name: "June newsletter",
      status: "sent",
      audienceKind: "list",
      audienceId: "newsletter",
      templateKey: "welcome",
      totalRecipients: 100,
      sentCount: 98,
      skippedCount: 2,
      failedCount: 0,
      startedAt: "2026-06-01T00:00:00.000Z",
      completedAt: "2026-06-01T00:01:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    const { fetchImpl, calls } = makeFetch({ body: campaign });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).campaigns.get("cmp/1");
    expect(res).toEqual(campaign);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/campaigns/cmp%2F1");
  });
});

// ---------------------------------------------------------------------------
// groups (secret-key data plane)
// ---------------------------------------------------------------------------

describe("groups", () => {
  const group = {
    id: "g_1",
    groupType: "company",
    groupKey: "acme",
    displayName: "Acme Inc",
    properties: { plan: "enterprise" },
    firstSeenAt: "2026-06-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };

  it("identify POSTs /v1/groups with the body and unwraps the group", async () => {
    const { fetchImpl, calls } = makeFetch({ body: { group } });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).groups.identify({
      groupType: "company",
      groupKey: "acme",
      displayName: "Acme Inc",
      properties: { plan: "enterprise" },
    });
    expect(res).toEqual(group);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/groups");
    expect(calls[0]?.body).toEqual({
      groupType: "company",
      groupKey: "acme",
      displayName: "Acme Inc",
      properties: { plan: "enterprise" },
    });
  });

  it("get GETs /v1/groups/{gt}/{gk}, url-encoding both segments", async () => {
    const { fetchImpl, calls } = makeFetch({ body: { group } });
    const res = await client(fetchImpl as unknown as typeof fetch).groups.get({
      groupType: "com/pany",
      groupKey: "ac me",
    });
    expect(res).toEqual(group);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/groups/com%2Fpany/ac%20me",
    );
  });

  it("list GETs /v1/groups with the query and unwraps groups", async () => {
    const { fetchImpl, calls } = makeFetch({ body: { groups: [group] } });
    const res = await client(fetchImpl as unknown as typeof fetch).groups.list({
      groupType: "company",
      limit: 10,
      offset: 5,
    });
    expect(res).toEqual([group]);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/groups?groupType=company&limit=10&offset=5",
    );
  });

  it("addMember POSTs the members path and returns { membership, created }", async () => {
    const membership = {
      id: "gm_1",
      groupId: "g_1",
      contactId: "c_1",
      role: "admin",
      joinedAt: "2026-06-01T00:00:00.000Z",
    };
    const { fetchImpl, calls } = makeFetch({
      body: { membership, created: true },
    });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).groups.addMember({
      groupType: "company",
      groupKey: "acme",
      contactId: "c_1",
      role: "admin",
    });
    expect(res).toEqual({ membership, created: true });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/groups/company/acme/members",
    );
    expect(calls[0]?.body).toEqual({ contactId: "c_1", role: "admin" });
  });

  it("removeMember DELETEs the encoded members/{contactId} path (no body)", async () => {
    const { fetchImpl, calls } = makeFetch({ body: { removed: true } });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).groups.removeMember({
      groupType: "com/pany",
      groupKey: "acme",
      contactId: "c/1",
    });
    expect(res).toEqual({ removed: true });
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/groups/com%2Fpany/acme/members/c%2F1",
    );
    // contactId travels in the PATH — never a body.
    expect(calls[0]?.body).toBeUndefined();
  });

  it("listMembers GETs the members path and unwraps members", async () => {
    const members = [
      {
        contactId: "c_1",
        email: "a@b.com",
        externalId: "u_1",
        role: "admin",
        joinedAt: "2026-06-01T00:00:00.000Z",
      },
    ];
    const { fetchImpl, calls } = makeFetch({ body: { members } });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).groups.listMembers({
      groupType: "company",
      groupKey: "acme",
      limit: 20,
    });
    expect(res).toEqual(members);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/groups/company/acme/members?limit=20",
    );
  });
});

// ---------------------------------------------------------------------------
// webhooks (admin plane)
// ---------------------------------------------------------------------------

describe("webhooks", () => {
  const endpoint = {
    id: "we_1",
    url: "https://example.com/hook",
    description: null,
    eventTypes: ["contact.created", "email.sent"],
    secretPrefix: "whsec_AbCd",
    status: "enabled",
    organizationId: null,
    lastDeliveryAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };

  it("create POSTs /v1/admin/webhooks and returns the endpoint + secret", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { ...endpoint, secret: "whsec_AbCdFullSecret" },
    });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).webhooks.create({
      url: "https://example.com/hook",
      eventTypes: ["contact.created", "email.sent"],
    });
    expect(res.secret).toBe("whsec_AbCdFullSecret");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/admin/webhooks");
    expect(calls[0]?.body).toMatchObject({
      url: "https://example.com/hook",
      eventTypes: ["contact.created", "email.sent"],
    });
  });

  it("list GETs /v1/admin/webhooks and unwraps endpoints", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { endpoints: [endpoint], total: 1, limit: 50, offset: 0 },
    });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).webhooks.list({ includeDisabled: true });
    expect(res).toEqual([endpoint]);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/admin/webhooks?includeDisabled=true",
    );
  });

  it("get GETs /v1/admin/webhooks/{id} and url-encodes the id", async () => {
    const { fetchImpl, calls } = makeFetch({ body: endpoint });
    const res = await client(fetchImpl as unknown as typeof fetch).webhooks.get(
      "we/1",
    );
    expect(res).toEqual(endpoint);
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/admin/webhooks/we%2F1",
    );
  });

  it("update PATCHes /v1/admin/webhooks/{id}", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { ...endpoint, status: "disabled" },
    });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).webhooks.update("we_1", { disabled: true });
    expect(res.status).toBe("disabled");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/admin/webhooks/we_1");
    expect(calls[0]?.body).toMatchObject({ disabled: true });
  });

  it("delete DELETEs /v1/admin/webhooks/{id}", async () => {
    const { fetchImpl, calls } = makeFetch({ body: { deleted: true } });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).webhooks.delete("we_1");
    expect(res).toEqual({ deleted: true });
    expect(calls[0]?.method).toBe("DELETE");
  });

  it("rotateSecret POSTs /{id}/rotate-secret and returns the new secret", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: {
        id: "we_1",
        secret: "whsec_NewSecret",
        secretPrefix: "whsec_NewS",
      },
    });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).webhooks.rotateSecret("we_1");
    expect(res.secret).toBe("whsec_NewSecret");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/admin/webhooks/we_1/rotate-secret",
    );
  });

  it("sendTest POSTs /{id}/test and returns the enqueue ack", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { enqueued: true, eventType: "webhook.test" },
    });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).webhooks.sendTest("we_1");
    expect(res).toEqual({ enqueued: true, eventType: "webhook.test" });
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/admin/webhooks/we_1/test",
    );
  });
});

// ---------------------------------------------------------------------------
// links (admin plane)
// ---------------------------------------------------------------------------

describe("links", () => {
  const link = {
    id: "lk_1",
    trackedLinkId: "tl_1",
    originalUrl: "https://example.com/pricing",
    type: "public",
    slug: null,
    vanityUrl: null,
    label: null,
    description: null,
    appendRef: false,
    campaign: null,
    source: "api",
    distinctId: null,
    createdBy: null,
    clickCount: 0,
    scanCount: 0,
    url: "https://api.test.local/v1/t/c/tl_1",
    archivedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };

  it("create POSTs /v1/admin/links with source 'api' and the idempotencyKey in the BODY (never the header)", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { ...link, existing: true },
    });
    const res = await client(fetchImpl as unknown as typeof fetch).links.create(
      {
        url: "https://example.com/pricing",
        idempotencyKey: "print-run-1",
      },
    );
    // The idempotent re-mint flag surfaces verbatim.
    expect(res.existing).toBe(true);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/admin/links");
    const body = calls[0]?.body as Record<string, unknown>;
    // SDK provenance is honest: source defaults to "api", not "studio".
    expect(body.source).toBe("api");
    // The admin route reads idempotencyKey from the BODY.
    expect(body.idempotencyKey).toBe("print-run-1");
    // ...and it must NOT leak into the Idempotency-Key header.
    expect(calls[0]?.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("create passes an explicit source through", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { ...link, source: "studio", existing: false },
    });
    await client(fetchImpl as unknown as typeof fetch).links.create({
      url: "https://example.com/pricing",
      source: "studio",
    });
    expect((calls[0]?.body as { source?: string }).source).toBe("studio");
  });

  it("create maps a 409 slug/key conflict to HogsendAPIError", async () => {
    const { fetchImpl } = makeFetch({
      status: 409,
      body: { error: "slug already taken" },
    });
    const err = await client(fetchImpl as unknown as typeof fetch)
      .links.create({ url: "https://example.com", slug: "taken" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HogsendAPIError);
    expect(err.status).toBe(409);
  });

  it("get GETs /v1/admin/links/{id} and url-encodes the id", async () => {
    const detail = {
      ...link,
      clicks: [],
      destinations: [],
      arrivalCount: 0,
      identifiedArrivalCount: 0,
    };
    const { fetchImpl, calls } = makeFetch({ body: detail });
    const res = await client(fetchImpl as unknown as typeof fetch).links.get(
      "lk/1",
    );
    expect(res).toEqual(detail);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/admin/links/lk%2F1");
  });

  it("list returns the envelope and OMITS includeArchived when false", async () => {
    const envelope = { links: [link], total: 1, limit: 50, offset: 0 };
    const { fetchImpl, calls } = makeFetch({ body: envelope });
    const res = await client(fetchImpl as unknown as typeof fetch).links.list({
      includeArchived: false,
    });
    expect(res).toEqual(envelope);
    // z.coerce.boolean() on the engine turns the string "false" into TRUE —
    // the param must be absent entirely when false.
    expect(calls[0]?.url).toBe("https://api.test.local/v1/admin/links");
  });

  it("list sends includeArchived=true when true and forwards hasQr", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { links: [], total: 0, limit: 50, offset: 0 },
    });
    await client(fetchImpl as unknown as typeof fetch).links.list({
      includeArchived: true,
      hasQr: false,
    });
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/admin/links?includeArchived=true&hasQr=false",
    );
  });

  it("update PATCHes /v1/admin/links/{id} with the body fields", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { ...link, label: null, originalUrl: "https://example.com/new" },
    });
    const res = await client(fetchImpl as unknown as typeof fetch).links.update(
      "lk_1",
      { originalUrl: "https://example.com/new", label: null },
    );
    expect(res.originalUrl).toBe("https://example.com/new");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/admin/links/lk_1");
    // Omitted fields are dropped; explicit nulls survive (they mean "clear").
    expect(calls[0]?.body).toEqual({
      originalUrl: "https://example.com/new",
      label: null,
    });
  });

  it("archive DELETEs /v1/admin/links/{id} and returns the archived link", async () => {
    const { fetchImpl, calls } = makeFetch({
      body: { ...link, archivedAt: "2026-07-21T00:00:00.000Z" },
    });
    const res = await client(
      fetchImpl as unknown as typeof fetch,
    ).links.archive("lk_1");
    expect(res.archivedAt).toBe("2026-07-21T00:00:00.000Z");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe("https://api.test.local/v1/admin/links/lk_1");
  });

  it("qr({ format: 'png' }) returns the raw PNG bytes untouched", async () => {
    // Real PNG magic + non-ASCII bytes: any UTF-8 round-trip corrupts these.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10,
    ]);
    const { fetchImpl, calls } = makeFetch({
      bytes: png,
      headers: { "content-type": "image/png" },
    });
    const res = await client(fetchImpl as unknown as typeof fetch).links.qr(
      "lk_1",
      { format: "png", size: 1024 },
    );
    expect(res).toBeInstanceOf(Uint8Array);
    expect(Array.from(res)).toEqual(Array.from(png));
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/admin/links/lk_1/qr?format=png&size=1024",
    );
  });

  it("qr({ format: 'svg' }) returns the SVG as a string", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`;
    const { fetchImpl, calls } = makeFetch({
      bytes: new TextEncoder().encode(svg),
      headers: { "content-type": "image/svg+xml" },
    });
    const res = await client(fetchImpl as unknown as typeof fetch).links.qr(
      "lk_1",
      { format: "svg" },
    );
    expect(res).toBe(svg);
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/admin/links/lk_1/qr?format=svg",
    );
  });

  it("qr() with no format sends no format param and returns the SVG string (server default)", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`;
    const { fetchImpl, calls } = makeFetch({
      bytes: new TextEncoder().encode(svg),
      headers: { "content-type": "image/svg+xml" },
    });
    // Statically typed Promise<string> — the formatless default is SVG.
    const pending: Promise<string> = client(
      fetchImpl as unknown as typeof fetch,
    ).links.qr("lk_1", { size: 256 });
    const res = await pending;
    expect(res).toBe(svg);
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/admin/links/lk_1/qr?size=256",
    );
  });

  it("qr accepts a LinkQrOptions-typed variable (union format)", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"/>`;
    const { fetchImpl } = makeFetch({
      bytes: new TextEncoder().encode(svg),
      headers: { "content-type": "image/svg+xml" },
    });
    const opts: LinkQrOptions = { format: "svg" };
    const res = await client(fetchImpl as unknown as typeof fetch).links.qr(
      "lk_1",
      opts,
    );
    expect(res).toBe(svg);
  });

  it("qr forwards transparent=true only when set", async () => {
    const { fetchImpl, calls } = makeFetch({
      bytes: new Uint8Array([0x89]),
      headers: { "content-type": "image/png" },
    });
    await client(fetchImpl as unknown as typeof fetch).links.qr("lk_1", {
      format: "png",
      transparent: true,
    });
    expect(calls[0]?.url).toBe(
      "https://api.test.local/v1/admin/links/lk_1/qr?format=png&transparent=true",
    );
  });

  it("qrUrl builds the URL locally — NO network call", async () => {
    const { fetchImpl, calls } = makeFetch({ body: {} });
    const url = client(fetchImpl as unknown as typeof fetch).links.qrUrl(
      "lk_1",
      { format: "svg", size: 256 },
    );
    expect(url).toBe(
      "https://api.test.local/v1/admin/links/lk_1/qr?format=svg&size=256",
    );
    expect(calls.length).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// verifyHogsendWebhook (subscriber-side)
// ---------------------------------------------------------------------------

describe("verifyHogsendWebhook", () => {
  // whsec_<base64(32 bytes)>; the signing key is the base64-decoded body.
  const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;

  function sign(id: string, ts: number, body: string): string {
    const key = Buffer.from(secret.slice(6), "base64");
    const sig = createHmac("sha256", key)
      .update(`${id}.${ts}.${body}`)
      .digest("base64");
    return `v1,${sig}`;
  }

  it("verifies a valid signature with Title-Case headers", () => {
    const id = "msg_abc";
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id, type: "contact.created", data: {} });
    const event = verifyHogsendWebhook({
      payload: body,
      headers: {
        "Webhook-Id": id,
        "Webhook-Timestamp": String(ts),
        "Webhook-Signature": sign(id, ts, body),
      },
      secret,
    });
    expect(event).toMatchObject({ type: "contact.created" });
  });

  it("verifies with lowercase header keys too", () => {
    const id = "msg_def";
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id, type: "email.sent", data: {} });
    const event = verifyHogsendWebhook({
      payload: body,
      headers: {
        "webhook-id": id,
        "webhook-timestamp": String(ts),
        "webhook-signature": sign(id, ts, body),
      },
      secret,
    });
    expect(event).toMatchObject({ type: "email.sent" });
  });

  it("throws on a tampered body", () => {
    const id = "msg_ghi";
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id, type: "contact.created", data: {} });
    expect(() =>
      verifyHogsendWebhook({
        payload: `${body} `, // mutated bytes
        headers: {
          "Webhook-Id": id,
          "Webhook-Timestamp": String(ts),
          "Webhook-Signature": sign(id, ts, body),
        },
        secret,
      }),
    ).toThrow();
  });

  it("throws when a signature header is missing", () => {
    expect(() =>
      verifyHogsendWebhook({
        payload: "{}",
        headers: { "Webhook-Id": "x", "Webhook-Timestamp": "1" },
        secret,
      }),
    ).toThrow(/missing/i);
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
