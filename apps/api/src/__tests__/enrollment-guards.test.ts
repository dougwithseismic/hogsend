import { describe, expect, it } from "vitest";
import { evaluateTriggerConditions } from "../lib/enrollment-guards.js";

describe("evaluateTriggerConditions", () => {
  const properties = {
    plan: "pro",
    name: "Alice",
    score: 42,
    active: true,
    empty: null,
  };

  it("matches eq operator", () => {
    expect(
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
            property: "plan",
            operator: "eq",
            value: "pro",
          },
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
            property: "plan",
            operator: "eq",
            value: "pro",
          },
          {
            type: "property",
            source: "context",
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
    expect(evaluateTriggerConditions({ conditions: [], properties })).toBe(
      true,
    );
  });

  it("matches gt operator", () => {
    expect(
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
      evaluateTriggerConditions({
        conditions: [
          {
            type: "property",
            source: "context",
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
