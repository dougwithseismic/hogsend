import { describe, expect, it } from "vitest";
import {
  addrSpecOf,
  hostOfFromAddress,
} from "../../../../packages/engine/src/lib/from-address.js";

describe("addrSpecOf", () => {
  it("accepts a bare addr-spec", () => {
    expect(addrSpecOf("doug@hogsend.com")).toBe("doug@hogsend.com");
  });

  it("accepts a display-name form and extracts the addr-spec", () => {
    expect(addrSpecOf("Doug at Hogsend <doug@hogsend.com>")).toBe(
      "doug@hogsend.com",
    );
  });

  it("lowercases the extracted address", () => {
    expect(addrSpecOf("Doug <Doug@Hogsend.com>")).toBe("doug@hogsend.com");
  });

  it("tolerates surrounding whitespace", () => {
    expect(addrSpecOf("  Doug <doug@hogsend.com>  ")).toBe("doug@hogsend.com");
    expect(addrSpecOf("Doug < doug@hogsend.com >")).toBe("doug@hogsend.com");
  });

  it("rejects values without a valid address", () => {
    expect(addrSpecOf(undefined)).toBeNull();
    expect(addrSpecOf("")).toBeNull();
    expect(addrSpecOf("not-an-email")).toBeNull();
    expect(addrSpecOf("Doug <not-an-email>")).toBeNull();
    expect(addrSpecOf("Doug <doug@hogsend.com")).toBeNull();
    expect(addrSpecOf("<>")).toBeNull();
  });
});

describe("hostOfFromAddress", () => {
  it("derives the host from a bare address", () => {
    expect(hostOfFromAddress("hello@x.com")).toBe("x.com");
  });

  it("derives the host from a display-name form", () => {
    // The pre-fix lastIndexOf("@") slice returned "hogsend.com>" here.
    expect(hostOfFromAddress("Doug at Hogsend <doug@hogsend.com>")).toBe(
      "hogsend.com",
    );
  });

  it("returns null for invalid input", () => {
    expect(hostOfFromAddress(undefined)).toBeNull();
    expect(hostOfFromAddress("nope")).toBeNull();
  });
});
