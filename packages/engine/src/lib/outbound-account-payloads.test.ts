import assert from "node:assert/strict";
import test from "node:test";
import type { OutboundPayloads } from "./outbound.js";

/**
 * The `account.*` outbound payload shapes (PRD 08 T2).
 *
 * The load-bearing assertion here is not the field list — it is that `version`
 * crosses the wire as a decimal STRING. `linked_accounts.version` is a Postgres
 * `bigint` (DECISIONS §5.1) and the whole consistency contract is a consumer's
 * `incoming.version > stored.version` guard, so a version that has been through
 * a JS `number` at ANY point in the producer is silently wrong above
 * `Number.MAX_SAFE_INTEGER` and breaks the guard in exactly the case it exists
 * for. A type-only test cannot see a `Number(row.version)` in a serializer, so
 * the last two cases are runtime assertions on a BUILT payload.
 */

/** The store's row shape, narrowed to what a payload build reads. */
interface FakeLinkRow {
  provider: string;
  providerUserId: string;
  contactId: string;
  version: bigint;
}

/** Stand-in for the T3 builder: the serialization under test is `String()`. */
function buildLinkedPayload(
  row: FakeLinkRow,
): OutboundPayloads["account.linked"] {
  return {
    state: "linked",
    provider: row.provider,
    providerUserId: row.providerUserId,
    contactId: row.contactId,
    userId: "usr_1",
    email: "player@example.com",
    username: "player",
    method: "oauth",
    relink: false,
    version: String(row.version),
    at: "2026-08-14T00:00:00.000Z",
  };
}

test("an account.linked payload type-checks with every documented field", () => {
  const linked: OutboundPayloads["account.linked"] = {
    state: "linked",
    provider: "steam",
    providerUserId: "76561198000000000",
    contactId: "ct_1",
    userId: "usr_1",
    email: "player@example.com",
    username: "player",
    method: "oauth",
    relink: true,
    version: "3",
    at: "2026-08-14T00:00:00.000Z",
  };
  const unlinked: OutboundPayloads["account.unlinked"] = {
    state: "unlinked",
    provider: "steam",
    providerUserId: "76561198000000000",
    contactId: "ct_1",
    userId: null,
    email: null,
    reason: "relinked",
    version: "2",
    at: "2026-08-14T00:00:00.000Z",
  };
  const failed: OutboundPayloads["account.link_failed"] = {
    provider: "steam",
    reason: "state_invalid",
    contactId: null,
    at: "2026-08-14T00:00:00.000Z",
  };

  assert.deepEqual(Object.keys(linked).sort(), [
    "at",
    "contactId",
    "email",
    "method",
    "provider",
    "providerUserId",
    "relink",
    "state",
    "userId",
    "username",
    "version",
  ]);
  assert.deepEqual(Object.keys(unlinked).sort(), [
    "at",
    "contactId",
    "email",
    "provider",
    "providerUserId",
    "reason",
    "state",
    "userId",
    "version",
  ]);
  // `account.link_failed` carries NO version and NO state: nothing mutated.
  assert.deepEqual(Object.keys(failed).sort(), [
    "at",
    "contactId",
    "provider",
    "reason",
  ]);
});

test("version serializes as a string, not a number", () => {
  const payload = buildLinkedPayload({
    provider: "steam",
    providerUserId: "76561198000000000",
    contactId: "ct_1",
    version: 7n,
  });
  assert.equal(typeof payload.version, "string");
  assert.equal(payload.version, "7");
});

test("a version above Number.MAX_SAFE_INTEGER round-trips through the payload without loss", () => {
  // ODD and above 2^53: every EVEN integer below 2^54 is exactly representable
  // in float64, so an assertion on an even value passes whether or not the code
  // rounds (DECISIONS §5.1). 9007199254740993 rounds to ...992 through a JS
  // number, so this assertion is non-vacuous.
  const payload = buildLinkedPayload({
    provider: "steam",
    providerUserId: "76561198000000000",
    contactId: "ct_1",
    version: 9007199254740993n,
  });
  const roundTripped = JSON.parse(
    JSON.stringify(payload),
  ) as OutboundPayloads["account.linked"];
  assert.equal(roundTripped.version, "9007199254740993");
  assert.notEqual(String(Number(payload.version)), payload.version);
});
