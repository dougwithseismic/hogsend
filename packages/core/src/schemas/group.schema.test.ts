import { describe, expect, it } from "vitest";
import type { GroupIdentifyInput, GroupMemberInput } from "../types/group.js";
import {
  groupIdentifySchema,
  groupKeySchema,
  groupMemberSchema,
  groupsAssociationSchema,
  groupTypeSchema,
} from "./group.schema.js";

describe("groupTypeSchema / groupKeySchema", () => {
  it("accepts non-empty strings", () => {
    expect(groupTypeSchema.parse("company")).toBe("company");
    expect(groupKeySchema.parse("acme.com")).toBe("acme.com");
  });

  it("rejects empty strings", () => {
    expect(groupTypeSchema.safeParse("").success).toBe(false);
    expect(groupKeySchema.safeParse("").success).toBe(false);
  });
});

describe("groupsAssociationSchema", () => {
  it("accepts a groupType→groupKey map", () => {
    expect(
      groupsAssociationSchema.parse({ company: "acme.com", team: "growth" }),
    ).toEqual({ company: "acme.com", team: "growth" });
  });

  it("rejects empty keys or values", () => {
    expect(groupsAssociationSchema.safeParse({ "": "acme.com" }).success).toBe(
      false,
    );
    expect(groupsAssociationSchema.safeParse({ company: "" }).success).toBe(
      false,
    );
  });
});

describe("groupIdentifySchema", () => {
  it("parses a full identify payload", () => {
    const parsed = groupIdentifySchema.parse({
      groupType: "company",
      groupKey: "acme.com",
      displayName: "Acme, Inc.",
      properties: { plan: "enterprise", seats: 42 },
    });
    expect(parsed.groupType).toBe("company");
    expect(parsed.properties).toEqual({ plan: "enterprise", seats: 42 });
    // Structurally compatible with the hand-written input interface.
    const asInput: GroupIdentifyInput = parsed;
    expect(asInput.groupKey).toBe("acme.com");
  });

  it("rejects an empty groupType", () => {
    expect(
      groupIdentifySchema.safeParse({ groupType: "", groupKey: "acme.com" })
        .success,
    ).toBe(false);
  });
});

describe("groupMemberSchema", () => {
  it("parses a member payload and is compatible with GroupMemberInput", () => {
    const parsed = groupMemberSchema.parse({
      groupType: "company",
      groupKey: "acme.com",
      contactId: "contact-123",
      role: "admin",
    });
    const asInput: GroupMemberInput = parsed;
    expect(asInput.contactId).toBe("contact-123");
  });

  it("rejects a missing contactId", () => {
    expect(
      groupMemberSchema.safeParse({
        groupType: "company",
        groupKey: "acme.com",
      }).success,
    ).toBe(false);
  });
});
