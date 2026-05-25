import { evaluatePropertyConditions } from "@hogsend/core";
import { describe, expect, it } from "vitest";

describe("evaluatePropertyConditions", () => {
  const properties = {
    plan: "pro",
    name: "Alice",
    score: 42,
    active: true,
    empty: null,
  };

  it("matches eq operator", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "plan",
            operator: "eq",
            value: "pro",
          },
        ],
        properties,
      }),
    ).toBe(true);
  });

  it("rejects eq when not matching", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "plan",
            operator: "eq",
            value: "free",
          },
        ],
        properties,
      }),
    ).toBe(false);
  });

  it("matches neq operator", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "plan",
            operator: "neq",
            value: "free",
          },
        ],
        properties,
      }),
    ).toBe(true);
  });

  it("matches exists operator", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "plan",
            operator: "exists",
          },
        ],
        properties,
      }),
    ).toBe(true);
  });

  it("rejects exists for null values", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "empty",
            operator: "exists",
          },
        ],
        properties,
      }),
    ).toBe(false);
  });

  it("matches not_exists for missing property", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "missing",
            operator: "not_exists",
          },
        ],
        properties,
      }),
    ).toBe(true);
  });

  it("matches contains operator", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "name",
            operator: "contains",
            value: "lic",
          },
        ],
        properties,
      }),
    ).toBe(true);
  });

  it("rejects contains when not a string", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "score",
            operator: "contains",
            value: "42",
          },
        ],
        properties,
      }),
    ).toBe(false);
  });

  it("requires all conditions to match (AND logic)", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "plan",
            operator: "eq",
            value: "pro",
          },
          {
            type: "property",

            property: "active",
            operator: "eq",
            value: true,
          },
        ],
        properties,
      }),
    ).toBe(true);
  });

  it("fails when any condition does not match", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "plan",
            operator: "eq",
            value: "pro",
          },
          {
            type: "property",

            property: "name",
            operator: "eq",
            value: "Bob",
          },
        ],
        properties,
      }),
    ).toBe(false);
  });

  it("returns true for empty conditions array", () => {
    expect(evaluatePropertyConditions({ conditions: [], properties })).toBe(
      true,
    );
  });

  it("matches gt operator", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "score",
            operator: "gt",
            value: 40,
          },
        ],
        properties,
      }),
    ).toBe(true);
  });

  it("rejects gt when not greater", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "score",
            operator: "gt",
            value: 42,
          },
        ],
        properties,
      }),
    ).toBe(false);
  });

  it("matches gte operator", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "score",
            operator: "gte",
            value: 42,
          },
        ],
        properties,
      }),
    ).toBe(true);
  });

  it("matches lt operator", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "score",
            operator: "lt",
            value: 50,
          },
        ],
        properties,
      }),
    ).toBe(true);
  });

  it("matches lte operator", () => {
    expect(
      evaluatePropertyConditions({
        conditions: [
          {
            type: "property",

            property: "score",
            operator: "lte",
            value: 42,
          },
        ],
        properties,
      }),
    ).toBe(true);
  });
});
