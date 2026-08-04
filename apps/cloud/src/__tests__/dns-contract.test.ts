import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_API_URL,
  CloudflareDns,
  type CloudflareHttpRequest,
  type CloudflareHttpResponse,
} from "../dns/cloudflare";
import { describeDnsContract } from "../dns/contract";
import { FakeDns } from "../dns/fake";
import { refuseFakeDns } from "../dns/index";
import { DnsError, DnsRecordConflictError } from "../dns/types";

/**
 * Both `DnsProvider` implementations against the one contract, plus the
 * Cloudflare-specific behaviour the contract cannot see (the wire format, the
 * retry policy, the proxied flag).
 *
 * The Cloudflare provider runs the contract against an in-memory zone that
 * speaks Cloudflare's envelope. That is the point of the exercise: it proves
 * the real request/response translation satisfies the same behaviour the fake
 * does, without reaching the network.
 */

const ZONE_ID = "zone-1";
const ZONE_NAME = "hogsend.test";

interface StoredRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

/** A tiny Cloudflare stand-in: enough of the v4 API to serve the contract. */
function makeCloudflareZone() {
  const records = new Map<string, StoredRecord>();
  let counter = 0;
  const requests: CloudflareHttpRequest[] = [];

  const transport = async (
    request: CloudflareHttpRequest,
  ): Promise<CloudflareHttpResponse> => {
    requests.push(request);
    const path = request.url.slice(CLOUDFLARE_API_URL.length);

    if (request.method === "GET") {
      const query = path.split("?")[1] ?? "";
      const params = new URLSearchParams(query);
      const name = params.get("name");
      const type = params.get("type");
      const all = [...records.values()];
      const result = all.filter(
        (row) => (!name || row.name === name) && (!type || row.type === type),
      );
      return json({
        success: true,
        result: params.get("per_page") === "1" ? result.slice(0, 1) : result,
        result_info: { total_count: all.length },
      });
    }

    if (request.method === "POST") {
      const body = JSON.parse(request.body ?? "{}") as {
        type: string;
        name: string;
        content: string;
        proxied: boolean;
      };
      counter += 1;
      const record: StoredRecord = {
        id: `cf-${counter}`,
        type: body.type,
        name: body.name,
        content: body.content,
        proxied: body.proxied,
      };
      records.set(record.id, record);
      return json({ success: true, result: record });
    }

    const id = path.split("/").pop() ?? "";
    if (!records.has(id)) {
      return { status: 404, body: JSON.stringify({ success: false }) };
    }
    records.delete(id);
    return json({ success: true, result: { id } });
  };

  return { records, requests, transport, reset: () => records.clear() };
}

function json(payload: unknown): CloudflareHttpResponse {
  return { status: 200, body: JSON.stringify(payload) };
}

describeDnsContract("FakeDns", () => {
  const provider = new FakeDns();
  return { provider, reset: () => provider.reset() };
});

describeDnsContract("CloudflareDns", () => {
  const zone = makeCloudflareZone();
  const provider = new CloudflareDns({
    token: "cf-token",
    zoneId: ZONE_ID,
    zoneName: ZONE_NAME,
    transport: zone.transport,
    sleep: async () => {},
  });
  return {
    provider,
    reset: async () => {
      zone.reset();
    },
  };
});

describe("CloudflareDns wire behaviour", () => {
  function make() {
    const zone = makeCloudflareZone();
    const sleeps: number[] = [];
    const provider = new CloudflareDns({
      token: "cf-token",
      zoneId: ZONE_ID,
      zoneName: ZONE_NAME,
      transport: zone.transport,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    return { zone, provider, sleeps };
  }

  // Railway terminates TLS for these hostnames. A proxied record breaks its
  // Let's Encrypt issuance outright, so this flag is load-bearing.
  it("always writes the record DNS-only, never proxied", async () => {
    const { zone, provider } = make();

    await provider.ensureRecord({
      type: "CNAME",
      hostname: `acme.${ZONE_NAME}`,
      value: "stack.up.railway.app",
    });

    const created = [...zone.records.values()][0];
    expect(created?.proxied).toBe(false);
  });

  it("sends the token as a bearer header", async () => {
    const { zone, provider } = make();

    await provider.ensureRecord({
      type: "CNAME",
      hostname: `acme.${ZONE_NAME}`,
      value: "stack.up.railway.app",
    });

    expect(zone.requests[0]?.headers.authorization).toBe("Bearer cf-token");
  });

  // A caller passing someone else's domain is a bug. Caught here it names the
  // problem; sent to Cloudflare it comes back as an opaque 400.
  it("refuses a hostname outside the zone without calling the vendor", async () => {
    const { zone, provider } = make();

    await expect(
      provider.ensureRecord({
        type: "CNAME",
        hostname: "acme.someone-else.test",
        value: "stack.up.railway.app",
      }),
    ).rejects.toBeInstanceOf(DnsError);
    expect(zone.requests).toHaveLength(0);
  });

  it("retries a 429 and succeeds, backing off between attempts", async () => {
    const { provider, sleeps } = makeFlaky(429, 2);

    const handle = await provider.ensureRecord({
      type: "CNAME",
      hostname: `acme.${ZONE_NAME}`,
      value: "stack.up.railway.app",
    });

    expect(handle.id).toBeTruthy();
    expect(sleeps).toEqual([500, 1000]);
  });

  // A 400 is a misconfiguration. It fails identically on every retry, so
  // retrying it would only burn the pipeline's attempt budget.
  it("does not retry a 400", async () => {
    const { provider, sleeps } = makeFlaky(400, 1);

    await expect(
      provider.ensureRecord({
        type: "CNAME",
        hostname: `acme.${ZONE_NAME}`,
        value: "stack.up.railway.app",
      }),
    ).rejects.toBeInstanceOf(DnsError);
    expect(sleeps).toEqual([]);
  });

  it("reports a conflict rather than repointing a live hostname", async () => {
    const { provider } = make();
    await provider.ensureRecord({
      type: "CNAME",
      hostname: `acme.${ZONE_NAME}`,
      value: "first.up.railway.app",
    });

    await expect(
      provider.ensureRecord({
        type: "CNAME",
        hostname: `acme.${ZONE_NAME}`,
        value: "second.up.railway.app",
      }),
    ).rejects.toBeInstanceOf(DnsRecordConflictError);
  });

  it("counts records against the zone's capacity", async () => {
    const { provider } = make();
    await provider.ensureRecord({
      type: "CNAME",
      hostname: `one.${ZONE_NAME}`,
      value: "a.up.railway.app",
    });
    await provider.ensureRecord({
      type: "CNAME",
      hostname: `two.${ZONE_NAME}`,
      value: "b.up.railway.app",
    });

    expect(await provider.readCapacity()).toEqual({ used: 2, limit: null });
  });
});

/** A zone that fails the first `failures` calls with `status`, then behaves. */
function makeFlaky(status: number, failures: number) {
  const zone = makeCloudflareZone();
  const sleeps: number[] = [];
  let remaining = failures;

  const provider = new CloudflareDns({
    token: "cf-token",
    zoneId: ZONE_ID,
    zoneName: ZONE_NAME,
    transport: async (request) => {
      if (remaining > 0) {
        remaining -= 1;
        return { status, body: "upstream said no" };
      }
      return zone.transport(request);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  return { provider, sleeps };
}

describe("refuseFakeDns", () => {
  /**
   * The guard exists because this misconfiguration is SILENT: instances come
   * up, the dashboard shows a hostname, and only the customer's delivered mail
   * reveals that none of it resolves.
   */
  it("refuses the fake in production once a zone is configured", () => {
    expect(
      refuseFakeDns({
        nodeEnv: "production",
        dns: "fake",
        zoneName: "hogsend.com",
      }),
    ).toMatch(/resolve nowhere/);
  });

  it("allows the fake in production with no zone — the state every deploy is in today", () => {
    expect(
      refuseFakeDns({ nodeEnv: "production", dns: "fake", zoneName: null }),
    ).toBeNull();
  });

  it("never gets in the way of dev or test", () => {
    expect(
      refuseFakeDns({
        nodeEnv: "development",
        dns: "fake",
        zoneName: "hogsend.com",
      }),
    ).toBeNull();
    expect(
      refuseFakeDns({ nodeEnv: "test", dns: "fake", zoneName: "hogsend.com" }),
    ).toBeNull();
  });

  it("says nothing about a real provider", () => {
    expect(
      refuseFakeDns({
        nodeEnv: "production",
        dns: "cloudflare",
        zoneName: "hogsend.com",
      }),
    ).toBeNull();
  });
});
