import { criteriaBuilder as b, days } from "@hogsend/core";
import { describe, expect, it } from "vitest";

// Pure builder unit tests — no DB, no engine. The builder must emit ConditionEval
// POJOs byte-identical to the hand-written declarative form (that equivalence is
// the whole point: everything downstream keeps treating criteria as data).

describe("criteria builder — property", () => {
  it("emits each operator with no stray keys", () => {
    expect(b.prop("plan").eq("trial")).toEqual({
      type: "property",
      property: "plan",
      operator: "eq",
      value: "trial",
    });
    expect(b.prop("converted").neq(true)).toEqual({
      type: "property",
      property: "converted",
      operator: "neq",
      value: true,
    });
    expect(b.prop("age").gte(18)).toEqual({
      type: "property",
      property: "age",
      operator: "gte",
      value: 18,
    });
    expect(b.prop("name").contains("ada")).toEqual({
      type: "property",
      property: "name",
      operator: "contains",
      value: "ada",
    });
  });

  it("exists/notExists carry NO value key", () => {
    expect(b.prop("email").exists()).toEqual({
      type: "property",
      property: "email",
      operator: "exists",
    });
    expect(b.prop("email").notExists()).toEqual({
      type: "property",
      property: "email",
      operator: "not_exists",
    });
  });
});

describe("criteria builder — event", () => {
  it("exists without a window omits operator/value/within", () => {
    expect(b.event("signup").exists()).toEqual({
      type: "event",
      eventName: "signup",
      check: "exists",
    });
  });

  it("count sugar maps to check:count + the right operator + within", () => {
    expect(b.event("key.action").within(days(30)).atLeast(10)).toEqual({
      type: "event",
      eventName: "key.action",
      check: "count",
      operator: "gte",
      value: 10,
      within: days(30),
    });
    expect(b.event("x").atMost(2)).toEqual({
      type: "event",
      eventName: "x",
      check: "count",
      operator: "lte",
      value: 2,
    });
    expect(b.event("x").exactly(1)).toEqual({
      type: "event",
      eventName: "x",
      check: "count",
      operator: "eq",
      value: 1,
    });
  });

  it("absence with a window is the dormancy shape", () => {
    expect(b.event("app.active").within(days(7)).notExists()).toEqual({
      type: "event",
      eventName: "app.active",
      check: "not_exists",
      within: days(7),
    });
  });
});

describe("criteria builder — composites", () => {
  it("all() / any() nest and equal the declarative composite", () => {
    const built = b.all(
      b.prop("plan").eq("trial"),
      b.prop("trial_days_left").lte(3),
      b.prop("converted").neq(true),
    );
    expect(built).toEqual({
      type: "composite",
      operator: "and",
      conditions: [
        { type: "property", property: "plan", operator: "eq", value: "trial" },
        {
          type: "property",
          property: "trial_days_left",
          operator: "lte",
          value: 3,
        },
        {
          type: "property",
          property: "converted",
          operator: "neq",
          value: true,
        },
      ],
    });

    expect(b.any(b.prop("a").eq(1), b.prop("b").eq(2)).operator).toBe("or");
  });
});
