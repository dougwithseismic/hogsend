import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { AdminClient } from "../lib/http.js";
import {
  CIO_EVERYONE_FILTER,
  cioBaseUrl,
  fetchCioEspSuppressions,
  mapCioCsv,
  runCioExport,
} from "../lib/import-customerio.js";
import {
  checkLoopsSuppression,
  coerceLoopsValue,
  mapLoopsCsv,
} from "../lib/import-loops.js";
import {
  chunk,
  createRateLimitedFetch,
  mapGenericContactsCsv,
  mapGenericSuppressionsCsv,
  pollImportJobs,
} from "../lib/import-shared.js";
import type { Output } from "../lib/output.js";

/** Build a JSON Response the way the real APIs answer. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const noSleep = () => Promise.resolve();

describe("chunk", () => {
  it("splits rows into fixed-size chunks", () => {
    const rows = Array.from({ length: 12 }, (_, i) => i);
    expect(chunk(rows, 5)).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6, 7, 8, 9],
      [10, 11],
    ]);
    expect(chunk([], 5)).toEqual([]);
  });
});

describe("mapGenericContactsCsv", () => {
  it("maps identity columns and treats the rest as properties", () => {
    const csv = [
      "email,externalId,plan,seats",
      "a@example.com,user_1,pro,5",
      "b@example.com,,free,",
    ].join("\n");

    expect(mapGenericContactsCsv(csv)).toEqual([
      {
        email: "a@example.com",
        externalId: "user_1",
        properties: { plan: "pro", seats: "5" },
      },
      {
        email: "b@example.com",
        externalId: undefined,
        properties: { plan: "free" },
      },
    ]);
  });

  it("rejects a CSV without identity columns", () => {
    expect(() => mapGenericContactsCsv("plan,seats\npro,5")).toThrow(
      /email or externalId/,
    );
  });
});

describe("mapGenericSuppressionsCsv", () => {
  it("maps email/reason/externalId and defaults the reason", () => {
    const csv = [
      "email,reason,externalId",
      "a@example.com,bounced,user_1",
      "b@example.com,,",
    ].join("\n");

    expect(mapGenericSuppressionsCsv(csv)).toEqual([
      { email: "a@example.com", reason: "bounced", externalId: "user_1" },
      { email: "b@example.com", reason: "unsubscribed" },
    ]);
  });

  it("rejects a CSV without an email column", () => {
    expect(() => mapGenericSuppressionsCsv("reason\nbounced")).toThrow(
      /email column/,
    );
  });
});

describe("coerceLoopsValue", () => {
  it("coerces by the declared Loops property type", () => {
    expect(coerceLoopsValue("5", "number")).toBe(5);
    expect(coerceLoopsValue("true", "boolean")).toBe(true);
    expect(coerceLoopsValue("false", "boolean")).toBe(false);
    // Dates stay strings (JSON round-trip).
    expect(coerceLoopsValue("2026-01-01", "date")).toBe("2026-01-01");
    expect(coerceLoopsValue("hello", "string")).toBe("hello");
  });

  it("falls back to the raw string on unparseable values", () => {
    expect(coerceLoopsValue("not-a-number", "number")).toBe("not-a-number");
    expect(coerceLoopsValue("maybe", "boolean")).toBe("maybe");
    expect(coerceLoopsValue("plain", undefined)).toBe("plain");
  });
});

describe("mapLoopsCsv", () => {
  const csv = [
    "email,firstName,lastName,subscribed,userId,source,score",
    "Sub@Example.com,Ann,Lee,true,user_1,API,7",
    "unsub@example.com,Bob,,false,user_2,Import,",
    "noid@example.com,,,true,,,3",
  ].join("\n");

  it("maps userId to externalId and other columns to properties", () => {
    const { contacts } = mapLoopsCsv(csv);
    expect(contacts).toEqual([
      {
        email: "sub@example.com",
        externalId: "user_1",
        properties: {
          firstName: "Ann",
          lastName: "Lee",
          source: "API",
          score: "7",
        },
      },
      {
        email: "unsub@example.com",
        externalId: "user_2",
        properties: { firstName: "Bob", source: "Import" },
      },
      {
        email: "noid@example.com",
        properties: { score: "3" },
      },
    ]);
  });

  it("turns subscribed=false rows into unsubscribed suppression rows", () => {
    const { suppressions } = mapLoopsCsv(csv);
    expect(suppressions).toEqual([
      {
        email: "unsub@example.com",
        reason: "unsubscribed",
        externalId: "user_2",
      },
    ]);
  });

  it("type-coerces custom properties when property types are provided", () => {
    const { contacts } = mapLoopsCsv(csv, [
      { key: "score", label: "Score", type: "number" },
    ]);
    expect(contacts[0]?.properties?.score).toBe(7);
    expect(contacts[2]?.properties?.score).toBe(3);
  });

  it("rejects a CSV without an email column", () => {
    expect(() => mapLoopsCsv("userId,firstName\nuser_1,Ann")).toThrow(
      /email column/,
    );
  });
});

describe("mapCioCsv", () => {
  const csv = [
    "id,cio_id,email,unsubscribed,plan,company",
    "user_1,c1,A@Example.com,false,pro,Acme",
    ",c2,b@example.com,true,,Globex",
    "user_3,c3,,,free,",
  ].join("\n");

  it("prefers id over cio_id for externalId and maps attributes", () => {
    const { contacts } = mapCioCsv(csv);
    expect(contacts).toEqual([
      {
        externalId: "user_1",
        email: "a@example.com",
        properties: { plan: "pro", company: "Acme" },
      },
      {
        externalId: "c2",
        email: "b@example.com",
        properties: { company: "Globex" },
      },
      {
        externalId: "user_3",
        properties: { plan: "free" },
      },
    ]);
  });

  it("turns unsubscribed=true rows into unsubscribed suppression rows", () => {
    const { suppressions } = mapCioCsv(csv);
    expect(suppressions).toEqual([
      { email: "b@example.com", reason: "unsubscribed", externalId: "c2" },
    ]);
  });
});

describe("cioBaseUrl", () => {
  it("selects the regional host", () => {
    expect(cioBaseUrl("us")).toBe("https://api.customer.io");
    expect(cioBaseUrl("eu")).toBe("https://api-eu.customer.io");
  });
});

describe("runCioExport", () => {
  it("creates the export, polls until done, and downloads the CSV", async () => {
    const csvBody = "id,email\nuser_1,a@example.com";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse({ export: { id: 42, status: "pending" } });
      })
      .mockImplementationOnce(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse({ export: { id: 42, status: "pending" } });
      })
      .mockImplementationOnce(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse({ export: { id: 42, status: "done" } });
      })
      .mockImplementationOnce(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse({ url: "https://files.example.com/export-42.csv" });
      })
      .mockImplementationOnce(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(csvBody, { status: 200 });
      });

    const csv = await runCioExport({
      appKey: "app-key-test",
      baseUrl: "https://api.customer.io",
      fetch: fetchMock,
      sleep: noSleep,
      pollIntervalMs: 0,
    });

    expect(csv).toBe(csvBody);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.customer.io/v1/exports/customers",
      "https://api.customer.io/v1/exports/42",
      "https://api.customer.io/v1/exports/42",
      "https://api.customer.io/v1/exports/42/download",
      "https://files.example.com/export-42.csv",
    ]);

    // Create call: Bearer auth + the "everyone" tautology filter.
    const create = calls[0];
    expect(
      (create?.init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer app-key-test");
    expect(JSON.parse(String(create?.init?.body))).toEqual({
      filters: CIO_EVERYONE_FILTER,
    });

    // The signed download URL is fetched WITHOUT the auth header.
    expect(calls[4]?.init).toBeUndefined();
  });

  it("sends the segment filter when a segment id is given", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          filters: { segment: { id: 7 } },
        });
        return jsonResponse({ export: { id: 1, status: "done" } });
      })
      .mockImplementationOnce(async () =>
        jsonResponse({ url: "https://files.example.com/1.csv" }),
      )
      .mockImplementationOnce(async () => new Response("id,email\n"));

    await runCioExport({
      appKey: "k",
      baseUrl: "https://api.customer.io",
      segmentId: 7,
      fetch: fetchMock,
      sleep: noSleep,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws when the export job fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ export: { id: 9, status: "failed" } }),
      );

    await expect(
      runCioExport({
        appKey: "k",
        baseUrl: "https://api.customer.io",
        fetch: fetchMock,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/export 9 failed/);
  });
});

describe("fetchCioEspSuppressions", () => {
  it("pages with limit/offset until a short page", async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => ({
      email: `bounce${i}@example.com`,
    }));
    const page2 = [{ email: "bounce3@example.com" }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ suppressions: page1 }))
      .mockResolvedValueOnce(jsonResponse({ suppressions: page2 }));

    const emails = await fetchCioEspSuppressions({
      appKey: "k",
      baseUrl: "https://api.customer.io",
      type: "bounces",
      fetch: fetchMock,
      limit: 3,
    });

    expect(emails).toHaveLength(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.customer.io/v1/esp/suppression/bounces?limit=3&offset=0",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.customer.io/v1/esp/suppression/bounces?limit=3&offset=3",
    );
  });

  it("throws on an error response (caller warns and continues)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not enabled", { status: 400 }));

    await expect(
      fetchCioEspSuppressions({
        appKey: "k",
        baseUrl: "https://api.customer.io",
        type: "spam_reports",
        fetch: fetchMock,
      }),
    ).rejects.toThrow(/spam_reports failed \(400\)/);
  });
});

describe("createRateLimitedFetch", () => {
  it("retries a 429 with exponential backoff and returns the retry", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const rlFetch = createRateLimitedFetch({
      minIntervalMs: 0,
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const res = await rlFetch("https://example.com");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Two backoff sleeps: 1s then 2s.
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("honours a Retry-After header", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "3" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const rlFetch = createRateLimitedFetch({
      minIntervalMs: 0,
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await rlFetch("https://example.com");
    expect(sleeps).toEqual([3000]);
  });

  it("gives up after maxRetries and returns the 429", async () => {
    const fetchMock = vi.fn(
      async () => new Response("slow down", { status: 429 }),
    );
    const rlFetch = createRateLimitedFetch({
      minIntervalMs: 0,
      maxRetries: 2,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    const res = await rlFetch("https://example.com");
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("spaces request starts by the minimum interval", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn(async () => new Response("ok"));
    const rlFetch = createRateLimitedFetch({
      minIntervalMs: 100,
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await rlFetch("https://example.com/1");
    await rlFetch("https://example.com/2");
    await rlFetch("https://example.com/3");

    // First call goes straight through; the following calls wait ~100ms each.
    expect(sleeps.length).toBe(2);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(200);
    }
  });
});

describe("checkLoopsSuppression", () => {
  const check = (res: Response) =>
    checkLoopsSuppression({
      apiKey: "k",
      email: "a@example.com",
      fetch: vi.fn().mockResolvedValueOnce(res),
    });

  it("reads isSuppressed from a 200 response", async () => {
    await expect(check(jsonResponse({ isSuppressed: true }))).resolves.toBe(
      true,
    );
    await expect(check(jsonResponse({ isSuppressed: false }))).resolves.toBe(
      false,
    );
  });

  it("treats 404 (contact unknown to Loops) as not suppressed", async () => {
    await expect(check(new Response("nope", { status: 404 }))).resolves.toBe(
      false,
    );
  });

  it("throws on 401/403 with an API-key hint — never silently 'not suppressed'", async () => {
    await expect(check(new Response("", { status: 401 }))).rejects.toThrow(
      /401.*API key/,
    );
    await expect(check(new Response("", { status: 403 }))).rejects.toThrow(
      /403.*API key/,
    );
  });

  it("throws on a terminal 429 or 5xx", async () => {
    await expect(check(new Response("", { status: 429 }))).rejects.toThrow(
      /429/,
    );
    await expect(check(new Response("", { status: 500 }))).rejects.toThrow(
      /500/,
    );
  });
});

describe("runCioExport gzip handling", () => {
  it("inflates a gzipped export file (signed URLs often serve gzip without Content-Encoding)", async () => {
    const csvBody = "id,email\nuser_1,a@example.com";
    const gz = gzipSync(Buffer.from(csvBody, "utf8"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ export: { id: 5, status: "done" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ url: "https://files.example.com/5.csv.gz" }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(gz), { status: 200 }));

    const csv = await runCioExport({
      appKey: "k",
      baseUrl: "https://api.customer.io",
      fetch: fetchMock,
      sleep: noSleep,
    });
    expect(csv).toBe(csvBody);
  });
});

describe("pollImportJobs", () => {
  const out = { log: vi.fn() } as unknown as Output;

  const jobStatus = (over: Record<string, unknown>) => ({
    id: "job-1",
    status: "pending",
    totalRows: 2,
    processedRows: 0,
    failedRows: 0,
    errors: null,
    ...over,
  });

  it("polls to completion and aggregates the summary", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(jobStatus({ status: "pending" }))
      .mockResolvedValueOnce(
        jobStatus({ status: "processing", processedRows: 1 }),
      )
      .mockResolvedValueOnce(
        jobStatus({ status: "completed", processedRows: 2 }),
      );

    const summary = await pollImportJobs({
      http: { get } as unknown as AdminClient,
      out,
      endpoint: "/v1/admin/suppressions/import",
      jobIds: ["job-1"],
      pollIntervalMs: 1,
      sleep: noSleep,
    });

    expect(summary).toEqual({
      jobs: 1,
      totalRows: 2,
      processedRows: 2,
      failedRows: 0,
      errors: [],
    });
    expect(get).toHaveBeenCalledWith("/v1/admin/suppressions/import/job-1");
  });

  it("aborts a job stuck in pending with no progress instead of polling forever", async () => {
    const get = vi.fn().mockResolvedValue(jobStatus({ status: "pending" }));

    await expect(
      pollImportJobs({
        http: { get } as unknown as AdminClient,
        out,
        endpoint: "/v1/admin/suppressions/import",
        jobIds: ["job-1"],
        pollIntervalMs: 10,
        stallTimeoutMs: 30, // 3 unchanged polls
        sleep: noSleep,
      }),
    ).rejects.toThrow(/job-1 stalled.*pending/);
    // Bounded: 1 initial + 3 unchanged polls, not an infinite loop.
    expect(get.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("does not trip the stall guard while a job makes progress", async () => {
    let processed = 0;
    const get = vi.fn().mockImplementation(async () => {
      processed += 1;
      return processed >= 5
        ? jobStatus({ status: "completed", processedRows: processed })
        : jobStatus({ status: "processing", processedRows: processed });
    });

    const summary = await pollImportJobs({
      http: { get } as unknown as AdminClient,
      out,
      endpoint: "/v1/admin/contacts/import",
      jobIds: ["job-1"],
      pollIntervalMs: 10,
      stallTimeoutMs: 20, // would trip after 2 unchanged polls — none occur
      sleep: noSleep,
    });
    expect(summary.processedRows).toBe(5);
  });
});
