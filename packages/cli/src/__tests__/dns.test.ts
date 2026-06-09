import type { DnsRecord } from "@hogsend/engine";
import { describe, expect, it } from "vitest";
import { DNS_HOSTS, detectDnsHost, formatRecordsFor } from "../lib/dns.js";

/** Fixture resolver — NEVER touches real DNS. */
function resolverFor(map: Record<string, readonly string[]>) {
  return async (hostname: string): Promise<string[]> => {
    const ns = map[hostname];
    if (!ns) {
      const err = new Error(`queryNs ENOTFOUND ${hostname}`) as Error & {
        code: string;
      };
      err.code = "ENOTFOUND";
      throw err;
    }
    return [...ns];
  };
}

const RECORDS: DnsRecord[] = [
  {
    type: "TXT",
    name: "resend._domainkey.mysite.com",
    value: "p=MIGfMA0GCSq",
    purpose: "dkim",
    status: "pending",
  },
  {
    type: "MX",
    name: "send.mysite.com",
    value: "feedback-smtp.us-east-1.amazonses.com",
    priority: 10,
    purpose: "spf",
    status: "pending",
  },
  {
    type: "CNAME",
    name: "pm-bounces.mysite.com",
    value: "pm.mtasv.net",
    purpose: "return_path",
    status: "verified",
  },
];

describe("detectDnsHost", () => {
  it.each([
    ["cloudflare", ["dana.ns.cloudflare.com", "kirk.ns.cloudflare.com"]],
    ["vercel", ["ns1.vercel-dns.com", "ns2.vercel-dns.com"]],
    ["route53", ["ns-123.awsdns-15.com", "ns-456.awsdns-22.net"]],
    ["godaddy", ["ns01.domaincontrol.com", "ns02.domaincontrol.com"]],
    ["namecheap", ["dns1.registrar-servers.com", "dns2.registrar-servers.com"]],
    ["porkbun", ["maceio.ns.porkbun.com", "salvador.ns.porkbun.com"]],
    ["google", ["ns-cloud-a1.googledomains.com"]],
  ] as const)("detects %s from its NS suffixes", async (id, ns) => {
    const host = await detectDnsHost("mysite.com", {
      resolveNs: resolverFor({ "mysite.com": ns }),
    });
    expect(host.id).toBe(id);
  });

  it("walks up labels until NS records resolve", async () => {
    const host = await detectDnsHost("a.b.mysite.com", {
      resolveNs: resolverFor({ "mysite.com": ["dana.ns.cloudflare.com"] }),
    });
    expect(host.id).toBe("cloudflare");
  });

  it("returns unknown for an unrecognized nameserver", async () => {
    const host = await detectDnsHost("mysite.com", {
      resolveNs: resolverFor({ "mysite.com": ["ns1.example-dns.io"] }),
    });
    expect(host.id).toBe("unknown");
  });

  it("returns unknown when every lookup errors (never throws)", async () => {
    const host = await detectDnsHost("mysite.com", {
      resolveNs: resolverFor({}),
    });
    expect(host.id).toBe("unknown");
  });

  it("exposes a panel deep link per host", () => {
    const cloudflare = DNS_HOSTS.cloudflare;
    expect(cloudflare.panelUrl("mysite.com")).toBe(
      "https://dash.cloudflare.com/?to=/:account/mysite.com/dns/records",
    );
    expect(DNS_HOSTS.vercel.panelUrl("mysite.com")).toBe(
      "https://vercel.com/dashboard/domains/mysite.com",
    );
    expect(DNS_HOSTS.namecheap.panelUrl("mysite.com")).toContain(
      "domaincontrolpanel/mysite.com",
    );
    expect(DNS_HOSTS.unknown.panelUrl("mysite.com")).toBe("https://mysite.com");
  });
});

describe("formatRecordsFor", () => {
  it("renders an aligned table with type/name/value/priority/status", () => {
    const out = formatRecordsFor(DNS_HOSTS.cloudflare, RECORDS, {
      domain: "mysite.com",
    });
    expect(out).toContain("TXT");
    expect(out).toContain("resend._domainkey.mysite.com");
    expect(out).toContain("p=MIGfMA0GCSq");
    expect(out).toContain("10");
    expect(out).toContain("pending");
    expect(out).toContain("verified");
  });

  it("adds the Cloudflare grey-cloud guidance", () => {
    const out = formatRecordsFor(DNS_HOSTS.cloudflare, RECORDS, {
      domain: "mysite.com",
    });
    expect(out).toContain("DNS only");
  });

  it("strips the domain suffix for relative-host panels (namecheap/godaddy)", () => {
    for (const id of ["namecheap", "godaddy"] as const) {
      const out = formatRecordsFor(DNS_HOSTS[id], RECORDS, {
        domain: "mysite.com",
      });
      // Hosts shown RELATIVE to mysite.com.
      expect(out).toContain("resend._domainkey");
      expect(out).not.toContain("resend._domainkey.mysite.com");
      expect(out).toContain("RELATIVE");
    }
  });

  it("prints records verbatim with a generic note for unknown hosts", () => {
    const out = formatRecordsFor(DNS_HOSTS.unknown, RECORDS, {
      domain: "mysite.com",
    });
    expect(out).toContain("resend._domainkey.mysite.com");
    expect(out.toLowerCase()).toContain("dns");
  });

  it("handles an empty record list", () => {
    const out = formatRecordsFor(DNS_HOSTS.cloudflare, [], {
      domain: "mysite.com",
    });
    expect(typeof out).toBe("string");
  });
});
