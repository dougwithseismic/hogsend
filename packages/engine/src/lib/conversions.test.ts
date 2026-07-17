import assert from "node:assert/strict";
import test from "node:test";
import { defineConversion } from "@hogsend/core";
import { ConversionRegistry } from "./conversions.js";

const signup = defineConversion({
  id: "signup-completed",
  name: "Signup completed",
  trigger: { event: "signup.completed" },
});
// A wildcard definition (trigger.event "*") lands in the registry's separate
// `wildcard` list — `has()` must see it via `all`, not `byEvent`.
const wildcard = defineConversion({
  id: "any-valued",
  name: "Any valued event",
  trigger: { event: "*" },
});

test("has() finds a definition registered under a named trigger", () => {
  const registry = new ConversionRegistry([signup]);
  assert.equal(registry.has("signup-completed"), true);
});

test("has() finds a WILDCARD definition (trigger.event '*')", () => {
  const registry = new ConversionRegistry([wildcard]);
  assert.equal(registry.has("any-valued"), true);
});

test("has() is false for an unknown id and on an empty registry", () => {
  const registry = new ConversionRegistry([signup, wildcard]);
  assert.equal(registry.has("signup-complete"), false); // typo'd id
  assert.equal(new ConversionRegistry().has("signup-completed"), false);
});
