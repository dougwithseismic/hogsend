import type {
  DnsRecord,
  DnsRecordStatus,
  DomainStatus,
  DomainsCapability,
  ReturnPathState,
  SetReturnPathInput,
} from "@hogsend/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createHogsendEmailProvider,
  createHogsendRelayDomains,
  HogsendRelayError,
  type HogsendReturnPathResult,
} from "../index.js";

/**
 * The `domains` capability over the control-plane endpoints (PRD 07 tasks 5,
 * 7, 9). Every call is driven through a stubbed relay — nothing here touches
 * the network.
 *
 * Two things this suite exists to hold:
 *
 *  - **presence.** The engine gates the admin domain routes, `hogsend domain`
 *    and Studio Setup on `provider.domains` existing at all. If it is ever
 *    dropped, every one of those surfaces silently reports "not supported"
 *    with no error anywhere;
 *  - **`purpose` survives the wire, on EVERY record.** The CLI's `dns-apply`
 *    renders and writes what it is given; a record arriving with no purpose (or
 *    the `other` fallback) is what would force a special case into it.
 */

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubRelay(...responses: Array<{ status?: number; body?: unknown }>) {
  const calls: StubCall[] = [];
  const queue = [...responses];

  const impl = vi.fn(
    async (input: unknown, init?: RequestInit): Promise<Response> => {
      const raw = String(init?.body ?? "");
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(
            ([k, v]) => [k.toLowerCase(), v],
          ),
        ),
        body: raw ? JSON.parse(raw) : undefined,
      });
      const next = queue.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  return { impl: impl as unknown as typeof fetch, calls };
}

const DOMAIN = "acme.test";

/** THE record — the whole default flow, as the control plane produces it. */
function dkimRecord(status: DnsRecordStatus = "pending"): DnsRecord {
  return {
    type: "TXT",
    name: `hogsend._domainkey.${DOMAIN}`,
    value: "p=MIIBIjAN…",
    purpose: "dkim",
    status,
  };
}

/** The default flow's answer: ONE record. */
function pendingStatus(): DomainStatus {
  return {
    domain: DOMAIN,
    state: "pending",
    records: [dkimRecord()],
    providerId: "hogsend",
    checkedAt: "2026-08-11T00:00:00.000Z",
  };
}

/** The branded return path switched on: two more, and never a third. */
function brandedStatus(): DomainStatus {
  return {
    ...pendingStatus(),
    state: "verified",
    records: [
      dkimRecord("verified"),
      {
        type: "MX",
        name: `send.${DOMAIN}`,
        value: "feedback-smtp.us-east-1.amazonses.com",
        priority: 10,
        purpose: "mx",
        status: "pending",
      },
      {
        type: "TXT",
        name: `send.${DOMAIN}`,
        value: "v=spf1 include:amazonses.com ~all",
        purpose: "spf",
        status: "pending",
      },
    ],
  };
}

function domains(...responses: Array<{ status?: number; body?: unknown }>) {
  const relay = stubRelay(...responses);
  return {
    relay,
    capability: createHogsendRelayDomains({
      relayUrl: "https://cloud.hogsend.test/",
      tenantToken: "hsrel_test",
      fetch: relay.impl,
    }),
  };
}

describe("capability presence", () => {
  it("is attached to the provider — the gate every domain surface reads", () => {
    const provider = createHogsendEmailProvider({
      relayUrl: "https://cloud.hogsend.test",
      tenantToken: "hsrel_test",
    });
    expect(provider.domains).toBeDefined();
    expect(typeof provider.domains?.create).toBe("function");
    expect(typeof provider.domains?.get).toBe("function");
    expect(typeof provider.domains?.records).toBe("function");
    expect(typeof provider.domains?.verify).toBe("function");
  });

  it("carries the provider's injected fetch, so it needs no second config", async () => {
    const relay = stubRelay({ body: { status: pendingStatus() } });
    const provider = createHogsendEmailProvider({
      relayUrl: "https://cloud.hogsend.test",
      tenantToken: "hsrel_test",
      fetch: relay.impl,
    });

    await provider.domains?.create(DOMAIN);
    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0]?.headers.authorization).toBe("Bearer hsrel_test");
  });
});

describe("create", () => {
  it("POSTs the domain to the relay and returns the ONE-record status", async () => {
    const { capability, relay } = domains({
      body: { status: pendingStatus() },
    });
    const status = await capability.create(DOMAIN);

    expect(relay.calls[0]).toMatchObject({
      url: "https://cloud.hogsend.test/api/email/domains",
      method: "POST",
      body: { domain: DOMAIN },
    });
    expect(relay.calls[0]?.headers.authorization).toBe("Bearer hsrel_test");
    // The competitive point survives the wire: one record, not Resend's three.
    expect(status.records).toHaveLength(1);
    expect(status.records[0]?.purpose).toBe("dkim");
    expect(status.providerId).toBe("hogsend");
  });

  it("throws a typed relay error when the control plane refuses", async () => {
    const refusal = {
      status: 400,
      body: {
        error: "invalid_domain",
        message: '"nope" is not a domain name.',
      },
    };
    const { capability } = domains(refusal, refusal);

    await expect(capability.create("nope")).rejects.toBeInstanceOf(
      HogsendRelayError,
    );
    // The slug and the sentence both survive, so Studio can render a reason.
    await expect(capability.create("nope")).rejects.toMatchObject({
      status: 400,
      error: "invalid_domain",
      message: '"nope" is not a domain name.',
    });
  });

  it("refuses an answer that is not a domain status rather than passing it on", async () => {
    const { capability } = domains({ body: { status: { nonsense: true } } });
    await expect(capability.create(DOMAIN)).rejects.toBeInstanceOf(
      HogsendRelayError,
    );
  });
});

describe("get and records", () => {
  it("GETs by query parameter", async () => {
    const { capability, relay } = domains({
      body: { status: pendingStatus() },
    });
    const status = await capability.get(DOMAIN);

    expect(relay.calls[0]?.method).toBe("GET");
    expect(relay.calls[0]?.url).toBe(
      `https://cloud.hogsend.test/api/email/domains?domain=${DOMAIN}`,
    );
    expect(status?.domain).toBe(DOMAIN);
  });

  it("answers null when the relay reports the domain is unknown", async () => {
    const { capability } = domains({ body: { status: null } });
    expect(await capability.get(DOMAIN)).toBeNull();
  });

  it("answers [] records for an unknown domain rather than throwing", async () => {
    const { capability } = domains({ body: { status: null } });
    expect(await capability.records(DOMAIN)).toEqual([]);
  });

  it("keeps purpose on EVERY record, so CLI dns-apply needs no special case", async () => {
    const { capability } = domains({ body: { status: brandedStatus() } });
    const records = await capability.records(DOMAIN);

    expect(records.map((r) => `${r.type}:${r.purpose}`)).toEqual([
      "TXT:dkim",
      "MX:mx",
      "TXT:spf",
    ]);
    for (const record of records) {
      expect(["dkim", "mx", "spf"]).toContain(record.purpose);
    }
    // The MX priority the writer needs survives too.
    expect(records.find((r) => r.type === "MX")?.priority).toBe(10);
  });
});

describe("verify", () => {
  it("POSTs to the verify endpoint and returns the fresh status", async () => {
    const { capability, relay } = domains({
      body: { status: brandedStatus() },
    });
    const status = await capability.verify(DOMAIN);

    expect(relay.calls[0]).toMatchObject({
      url: "https://cloud.hogsend.test/api/email/domains/verify",
      method: "POST",
      body: { domain: DOMAIN },
    });
    expect(status.state).toBe("verified");
  });

  it("passes a not_found state through rather than turning it into an error", async () => {
    const { capability } = domains({
      body: {
        status: {
          domain: DOMAIN,
          state: "not_found",
          records: [],
          providerId: "hogsend",
          checkedAt: "2026-08-11T00:00:00.000Z",
        },
      },
    });
    const status = await capability.verify(DOMAIN);
    expect(status.state).toBe("not_found");
    expect(status.records).toEqual([]);
  });
});

describe("the branded return path toggle", () => {
  it("switches on, and the answer carries the two extra records", async () => {
    const { capability, relay } = domains({
      body: {
        enabled: true,
        mailFromDomain: `send.${DOMAIN}`,
        status: brandedStatus(),
      },
    });

    const result = await capability.setReturnPath({
      domain: DOMAIN,
      enabled: true,
    });

    expect(relay.calls[0]).toMatchObject({
      url: "https://cloud.hogsend.test/api/email/domains/return-path",
      method: "POST",
      body: { domain: DOMAIN, enabled: true },
    });
    expect(result.enabled).toBe(true);
    expect(result.mailFromDomain).toBe(`send.${DOMAIN}`);
    expect(result.status.records).toHaveLength(3);
  });

  it("switches off, and the record set is back to one", async () => {
    const { capability, relay } = domains({
      body: { enabled: false, mailFromDomain: null, status: pendingStatus() },
    });

    const result = await capability.setReturnPath({
      domain: DOMAIN,
      enabled: false,
    });

    expect(relay.calls[0]?.body).toEqual({ domain: DOMAIN, enabled: false });
    expect(result.enabled).toBe(false);
    expect(result.mailFromDomain).toBeNull();
    expect(result.status.records).toHaveLength(1);
  });

  it("reports what the control plane read back, never what was asked for", async () => {
    // Asked for "on"; SES answered that nothing changed. The honest answer is
    // the read-back, or a UI would show a return path that does not exist.
    const { capability } = domains({
      body: { enabled: false, mailFromDomain: null, status: pendingStatus() },
    });
    const result = await capability.setReturnPath({
      domain: DOMAIN,
      enabled: true,
    });
    expect(result.enabled).toBe(false);
  });

  it("passes a chosen label through the wire verbatim", async () => {
    const { capability, relay } = domains({
      body: {
        enabled: true,
        mailFromDomain: `notifications.${DOMAIN}`,
        status: brandedStatus(),
      },
    });

    const result = await capability.setReturnPath({
      domain: DOMAIN,
      enabled: true,
      label: "notifications",
    });

    expect(relay.calls[0]?.body).toEqual({
      domain: DOMAIN,
      enabled: true,
      label: "notifications",
    });
    expect(result.mailFromDomain).toBe(`notifications.${DOMAIN}`);
  });

  it("omits the label key when none was chosen — the control plane's default applies", async () => {
    // The control plane strict-parses the body (an unknown or null key is a
    // 400), and its default is what keeps `send.<domain>` byte-stable for
    // customers who never chose a label. Exact-equality: no stray key.
    const { capability, relay } = domains({
      body: {
        enabled: true,
        mailFromDomain: `send.${DOMAIN}`,
        status: brandedStatus(),
      },
    });

    await capability.setReturnPath({ domain: DOMAIN, enabled: true });
    expect(relay.calls[0]?.body).toEqual({ domain: DOMAIN, enabled: true });
  });

  it("IS the core contract — one surface, not two", () => {
    const { capability } = domains();

    // The bespoke method satisfies `DomainsCapability.setReturnPath` exactly;
    // the engine's admin route reaches it through the neutral contract with no
    // Hogsend-specific cast anywhere.
    expectTypeOf(capability.setReturnPath).toEqualTypeOf<
      (input: SetReturnPathInput) => Promise<ReturnPathState>
    >();
    expectTypeOf<HogsendReturnPathResult>().toEqualTypeOf<ReturnPathState>();
    const asCore: DomainsCapability = capability;
    expect(typeof asCore.setReturnPath).toBe("function");
  });
});
