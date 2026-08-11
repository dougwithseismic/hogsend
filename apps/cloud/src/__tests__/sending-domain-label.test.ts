import { describe, expect, it } from "vitest";
import {
  assertMailFromLabel,
  InvalidMailFromLabelError,
  MAIL_FROM_SUBDOMAIN,
  mailFromDomainFor,
} from "../lib/sending-domains";

/**
 * PRD 15: the branded return path's subdomain is choosable.
 *
 * The default is the load-bearing case. Anyone already onboarded published
 * `send.<their-domain>` in DNS themselves, so a changed default would silently
 * invalidate a record we told them to create.
 */
describe("return-path subdomain label", () => {
  it("defaults to `send`, byte-identical to before the label existed", () => {
    expect(mailFromDomainFor("acme.com")).toBe("send.acme.com");
    expect(MAIL_FROM_SUBDOMAIN).toBe("send");
  });

  it("uses a customer's label when they choose one", () => {
    expect(mailFromDomainFor("acme.com", "notifications")).toBe(
      "notifications.acme.com",
    );
    expect(mailFromDomainFor("acme.com", "mail")).toBe("mail.acme.com");
  });

  it("lowercases, because DNS is case-insensitive and typing is not", () => {
    expect(mailFromDomainFor("acme.com", "Notifications")).toBe(
      "notifications.acme.com",
    );
    expect(assertMailFromLabel("  UPDATES  ")).toBe("updates");
  });

  it("accepts hyphens inside, and 63 characters", () => {
    expect(assertMailFromLabel("go-mail")).toBe("go-mail");
    expect(assertMailFromLabel("a".repeat(63))).toBe("a".repeat(63));
  });

  it.each([
    ["", "empty"],
    ["-lead", "leading hyphen"],
    ["trail-", "trailing hyphen"],
    [
      "two.labels",
      "a dot — the return path must sit directly under the domain",
    ],
    ["under_score", "underscore is not a DNS label character"],
    ["a".repeat(64), "64 characters, one over the limit"],
    ["spa ce", "whitespace inside"],
  ])("rejects %j (%s)", (label) => {
    expect(() => assertMailFromLabel(label)).toThrow(InvalidMailFromLabelError);
    // And it must throw from the DERIVATION too, so no caller can route around
    // the validator by going straight to `mailFromDomainFor`.
    expect(() => mailFromDomainFor("acme.com", label)).toThrow(
      InvalidMailFromLabelError,
    );
  });

  it("names the offending label in the error, not a generic message", () => {
    // An operator reading a 400 needs to know WHICH value was refused.
    expect(() => assertMailFromLabel("two.labels")).toThrow(/two\.labels/);
  });
});
