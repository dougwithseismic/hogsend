import assert from "node:assert/strict";
import test from "node:test";
import { parseAllowedOrigins } from "./account-link-origins.js";

test("parses a csv of origins", () => {
  assert.deepEqual(
    parseAllowedOrigins(
      "https://play.example.com, https://www.example.com ,http://localhost:3000",
    ),
    [
      "https://play.example.com",
      "https://www.example.com",
      "http://localhost:3000",
    ],
  );
});

test("throws on a path", () => {
  assert.throws(
    () => parseAllowedOrigins("https://x.example.com/cb"),
    /not an absolute origin/,
  );
  assert.throws(
    () => parseAllowedOrigins(["https://x.example.com/cb"]),
    /not an absolute origin/,
  );
});

test("throws on a bare *", () => {
  assert.throws(() => parseAllowedOrigins("*"), /not an absolute origin/);
});

test("throws on a wildcard host", () => {
  assert.throws(
    () => parseAllowedOrigins("https://*.example.com"),
    /not an absolute origin/,
  );
});

test("throws naming the offending entry", () => {
  assert.throws(
    () =>
      parseAllowedOrigins("https://good.example.com,https://bad.example.com/x"),
    /"https:\/\/bad\.example\.com\/x"/,
  );
  // The source label rides along so the operator knows which knob to fix.
  assert.throws(
    () => parseAllowedOrigins(["*"], "accountLinks.allowedOrigins"),
    /accountLinks\.allowedOrigins/,
  );
});

test("returns an empty array for undefined and for an empty string", () => {
  assert.deepEqual(parseAllowedOrigins(undefined), []);
  assert.deepEqual(parseAllowedOrigins(""), []);
  assert.deepEqual(parseAllowedOrigins([]), []);
  // Empty csv slots are dropped, not treated as malformed entries.
  assert.deepEqual(parseAllowedOrigins(",https://a.example.com,,"), [
    "https://a.example.com",
  ]);
});

test("dedupes", () => {
  assert.deepEqual(
    parseAllowedOrigins([
      "https://a.example.com",
      "https://b.example.com",
      "https://a.example.com",
    ]),
    ["https://a.example.com", "https://b.example.com"],
  );
});
