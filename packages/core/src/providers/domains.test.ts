import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  DnsRecord,
  DnsRecordPurpose,
  DnsRecordStatus,
  DomainStatus,
  DomainsCapability,
  DomainVerificationState,
  ReturnPathState,
  SetReturnPathInput,
} from "./domains.js";
import {
  normalizeReturnPathLabel,
  RETURN_PATH_LABEL_PATTERN,
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
    // OPTIONAL like `verify`: a provider with no branded-return-path concept
    // omits the member and the engine answers 501 (PRD 20).
    expectTypeOf<DomainsCapability["setReturnPath"]>().toEqualTypeOf<
      ((input: SetReturnPathInput) => Promise<ReturnPathState>) | undefined
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

describe("setReturnPath contract (PRD 20)", () => {
  it("pins the neutral input + result shapes", () => {
    expectTypeOf<SetReturnPathInput>().toEqualTypeOf<{
      domain: string;
      enabled: boolean;
      label?: string;
    }>();
    expectTypeOf<ReturnPathState["enabled"]>().toEqualTypeOf<boolean>();
    expectTypeOf<ReturnPathState["mailFromDomain"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<ReturnPathState["status"]>().toEqualTypeOf<DomainStatus>();
  });
});

describe("return-path label rule (the one PRD 15 shipped, one home)", () => {
  it("accepts single DNS labels, normalized (trim + lowercase)", () => {
    expect(normalizeReturnPathLabel("notifications")).toBe("notifications");
    // DNS is case-insensitive; a customer typing `Notifications` is not wrong.
    expect(normalizeReturnPathLabel(" Notifications ")).toBe("notifications");
    expect(normalizeReturnPathLabel("a")).toBe("a");
    expect(normalizeReturnPathLabel("x-1")).toBe("x-1");
    expect(normalizeReturnPathLabel("a".repeat(63))).toBe("a".repeat(63));
  });

  it("answers null for anything DNS cannot publish as ONE label", () => {
    for (const bad of [
      "",
      "   ",
      "-x",
      "x-",
      "has.dot",
      "under_score",
      "a".repeat(64),
    ]) {
      expect(normalizeReturnPathLabel(bad)).toBeNull();
    }
  });

  it("rejects an accidental edit to the pattern (literal pin, this copy only)", () => {
    // This guards ONLY the core copy — it cannot see the control plane's
    // authoritative `MAIL_FROM_LABEL_PATTERN` (core cannot import from an
    // app). The real cross-copy parity pin lives where both are reachable:
    // apps/cloud/src/__tests__/return-path-label-parity.test.ts.
    expect(RETURN_PATH_LABEL_PATTERN.source).toBe(
      "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$",
    );
  });
});
