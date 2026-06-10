import { describe, expectTypeOf, it } from "vitest";
import type {
  DnsRecord,
  DnsRecordPurpose,
  DnsRecordStatus,
  DomainStatus,
  DomainsCapability,
  DomainVerificationState,
} from "./domains.js";
import { defineEmailProvider, type EmailProvider } from "./email.js";

describe("DnsRecord contract (pinned in PROJECT_SPEC §a)", () => {
  it("pins the literal unions", () => {
    expectTypeOf<DnsRecordPurpose>().toEqualTypeOf<
      | "verification"
      | "spf"
      | "dkim"
      | "return_path"
      | "tracking"
      | "mx"
      | "other"
    >();
    expectTypeOf<DnsRecordStatus>().toEqualTypeOf<
      "pending" | "verified" | "failed" | "unknown"
    >();
    expectTypeOf<DnsRecord["type"]>().toEqualTypeOf<"TXT" | "CNAME" | "MX">();
    expectTypeOf<DnsRecord["name"]>().toEqualTypeOf<string>();
    expectTypeOf<DnsRecord["value"]>().toEqualTypeOf<string>();
    expectTypeOf<DnsRecord["ttl"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<DnsRecord["priority"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<DnsRecord["purpose"]>().toEqualTypeOf<DnsRecordPurpose>();
    expectTypeOf<DnsRecord["status"]>().toEqualTypeOf<DnsRecordStatus>();
  });
});

describe("DomainStatus contract", () => {
  it("pins the verification state union + member types", () => {
    expectTypeOf<DomainVerificationState>().toEqualTypeOf<
      "not_found" | "pending" | "verified" | "failed"
    >();
    expectTypeOf<DomainStatus["domain"]>().toEqualTypeOf<string>();
    expectTypeOf<
      DomainStatus["state"]
    >().toEqualTypeOf<DomainVerificationState>();
    expectTypeOf<DomainStatus["records"]>().toEqualTypeOf<DnsRecord[]>();
    expectTypeOf<DomainStatus["providerId"]>().toEqualTypeOf<string>();
    expectTypeOf<DomainStatus["checkedAt"]>().toEqualTypeOf<string>();
    expectTypeOf<DomainStatus["raw"]>().toEqualTypeOf<unknown>();
  });
});

describe("DomainsCapability contract", () => {
  it("pins the method signatures", () => {
    expectTypeOf<DomainsCapability["create"]>().toEqualTypeOf<
      (domain: string) => Promise<DomainStatus>
    >();
    expectTypeOf<DomainsCapability["get"]>().toEqualTypeOf<
      (domain: string) => Promise<DomainStatus | null>
    >();
    expectTypeOf<DomainsCapability["records"]>().toEqualTypeOf<
      (domain: string) => Promise<DnsRecord[]>
    >();
    expectTypeOf<DomainsCapability["verify"]>().toEqualTypeOf<
      ((domain: string) => Promise<DomainStatus>) | undefined
    >();
  });

  it("is an OPTIONAL EmailProvider member — presence is the capability gate", () => {
    expectTypeOf<EmailProvider["domains"]>().toEqualTypeOf<
      DomainsCapability | undefined
    >();
  });

  it("round-trips through defineEmailProvider", () => {
    const status: DomainStatus = {
      domain: "mysite.com",
      state: "pending",
      records: [],
      providerId: "fake",
      checkedAt: new Date().toISOString(),
    };
    const domains: DomainsCapability = {
      create: async () => status,
      get: async () => null,
      records: async () => [],
      verify: async () => status,
    };
    const provider = defineEmailProvider({
      meta: { id: "fake", name: "Fake" },
      send: async () => ({ id: "1" }),
      sendBatch: async () => ({ results: [] }),
      verifyWebhook: () => {
        throw new Error("unused");
      },
      parseWebhook: () => {
        throw new Error("unused");
      },
      domains,
    });
    expectTypeOf(provider.domains).toEqualTypeOf<
      DomainsCapability | undefined
    >();
  });
});
