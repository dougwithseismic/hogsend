import { describe, expect, it } from "vitest";
import {
  buildInstanceHostname,
  isUsableSlug,
  RESERVED_SLUGS,
  refuseSlug,
  refuseTenantZone,
  SLUG_MAX_LENGTH,
} from "../lib/hostnames";
import { slugifyOrgName } from "../lib/org-provision";

/**
 * The hostname rules, which are load-bearing in a way most string helpers are
 * not: the answer is written into DNS and into `API_PUBLIC_URL`, and every
 * tracked link in already-delivered mail resolves through it.
 */

const ZONE = "hogsend.app";

describe("refuseSlug", () => {
  it("accepts an ordinary tenant slug", () => {
    expect(refuseSlug("acme")).toBeNull();
    expect(refuseSlug("acme-corp")).toBeNull();
    expect(refuseSlug("a1b2")).toBeNull();
  });

  it("names the reason rather than returning a bare boolean", () => {
    expect(refuseSlug("ab")).toBe("too-short");
    expect(refuseSlug("a".repeat(SLUG_MAX_LENGTH + 1))).toBe("too-long");
    expect(refuseSlug("-acme")).toBe("malformed");
    expect(refuseSlug("acme-")).toBe("malformed");
    expect(refuseSlug("ACME")).toBe("malformed");
    expect(refuseSlug("acme corp")).toBe("malformed");
    expect(refuseSlug("ac--me")).toBe("double-hyphen");
  });

  // `t` is the tracking host. A tenant taking it would break links in mail
  // that has already been delivered.
  it("refuses every reserved slug, including the tracking host", () => {
    expect(refuseSlug("t")).not.toBeNull();
    for (const reserved of RESERVED_SLUGS) {
      expect(isUsableSlug(reserved)).toBe(false);
    }
  });

  it("refuses the hosts we serve from today", () => {
    for (const slug of ["api", "app", "cloud", "docs", "www", "demo"]) {
      expect(refuseSlug(slug)).toBe("reserved");
    }
  });
});

describe("buildInstanceHostname", () => {
  it("gives production the bare hostname", () => {
    expect(
      buildInstanceHostname({
        slug: "acme",
        environmentName: "production",
        zone: ZONE,
      }),
    ).toBe("acme.hogsend.app");
  });

  it("suffixes every other environment as one label", () => {
    expect(
      buildInstanceHostname({
        slug: "acme",
        environmentName: "staging",
        zone: ZONE,
      }),
    ).toBe("acme-staging.hogsend.app");
  });

  // A deeper label would need a multi-level wildcard certificate, which
  // Railway and Let's Encrypt both handle poorly.
  it("never introduces a second DNS level", () => {
    const hostname = buildInstanceHostname({
      slug: "acme",
      environmentName: "staging",
      zone: ZONE,
    });
    expect(hostname.split(".")).toHaveLength(3);
  });

  it("throws rather than returning a nearly-right name", () => {
    expect(() =>
      buildInstanceHostname({
        slug: "docs",
        environmentName: "production",
        zone: ZONE,
      }),
    ).toThrow(/reserved/);
    expect(() =>
      buildInstanceHostname({ slug: "ab", environmentName: "x", zone: ZONE }),
    ).toThrow(/too-short/);
  });

  // The environment name is tenant-chosen. Unchecked it would reach a DNS write.
  it("refuses an environment name that is not a DNS label", () => {
    expect(() =>
      buildInstanceHostname({
        slug: "acme",
        environmentName: "prod/../etc",
        zone: ZONE,
      }),
    ).toThrow(/not a usable DNS label/);
  });
});

describe("refuseTenantZone", () => {
  /**
   * The rule that makes tenant isolation structural. Cookie domain-matching is
   * suffix-based with no depth limit, so every one of these sits inside the
   * cookie's reach and would receive our session token on every request.
   */
  it("refuses the cookie domain itself and anything under it, at any depth", () => {
    for (const zone of [
      "hogsend.com",
      "cloud.hogsend.com",
      "instances.cloud.hogsend.com",
      "tenants.hogsend.com",
    ]) {
      expect(
        refuseTenantZone({ zone, ssoCookieDomain: ".hogsend.com" }),
      ).toMatch(/separate registrable domain/);
    }
  });

  it("allows a separate registrable domain", () => {
    expect(
      refuseTenantZone({
        zone: "hogsend.app",
        ssoCookieDomain: ".hogsend.com",
      }),
    ).toBeNull();
  });

  // A domain that merely ENDS with the same letters is not inside it.
  it("does not confuse a suffix of the string with a suffix of the domain", () => {
    expect(
      refuseTenantZone({
        zone: "nothogsend.com",
        ssoCookieDomain: ".hogsend.com",
      }),
    ).toBeNull();
  });

  it("tolerates the domain written with or without its leading dot", () => {
    expect(
      refuseTenantZone({ zone: "hogsend.com", ssoCookieDomain: "hogsend.com" }),
    ).not.toBeNull();
  });

  // No SSO cookie configured is not a licence to skip the check by accident —
  // it means there is nothing to leak.
  it("allows anything when no SSO cookie domain is set", () => {
    expect(
      refuseTenantZone({ zone: "hogsend.com", ssoCookieDomain: null }),
    ).toBeNull();
  });
});

describe("slugifyOrgName", () => {
  it("keeps an ordinary name recognisable", () => {
    expect(slugifyOrgName("Acme Corp")).toBe("acme-corp");
  });

  it("still falls back to org for a name with nothing usable in it", () => {
    expect(slugifyOrgName("!!!")).toBe("org");
  });

  // The whole point of the change: a tenant called "Docs" must not be issued
  // the slug that shadows our documentation site.
  it("never issues a reserved slug", () => {
    for (const name of ["Docs", "API", "www", "Studio", "Support"]) {
      const slug = slugifyOrgName(name);
      expect(isUsableSlug(slug)).toBe(true);
      expect(RESERVED_SLUGS.has(slug)).toBe(false);
      // The stem survives, so the customer still recognises their handle.
      expect(slug.startsWith(name.toLowerCase())).toBe(true);
    }
  });

  it("always returns something usable as a hostname label", () => {
    for (const name of ["", "  ", "!!!", "A", "ab", "a--b", "x".repeat(80)]) {
      expect(isUsableSlug(slugifyOrgName(name))).toBe(true);
    }
  });
});
