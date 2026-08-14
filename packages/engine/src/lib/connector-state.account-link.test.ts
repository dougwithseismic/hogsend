import assert from "node:assert/strict";
import test from "node:test";
import {
  type ConnectorStateIntent,
  signConnectorState,
  verifyConnectorState,
} from "./connector-state.js";

/**
 * PRD 07 T1 — the `account_link` purpose on the ONE state token format.
 *
 * There is deliberately no second token: `BETTER_AUTH_SECRET` signs every state
 * in the process, so a second format would be a second thing to keep hardened.
 * What IS new is `providerId`, which is why the cross-surface tests below (and
 * `apps/api/src/__tests__/connectors-oauth-state-purpose.test.ts`) exist.
 */

const SECRET = "test-secret-for-account-link-state-minimum-32-characters";

const WARM: ConnectorStateIntent = {
  purpose: "account_link",
  providerId: "steam",
  contactId: "11111111-2222-3333-4444-555555555555",
  returnTo: "https://play.example.com/settings",
  nonce: "nonce-warm",
};

const COLD: ConnectorStateIntent = {
  purpose: "account_link",
  providerId: "twitch",
  anonymousId: "anon-abc",
  nonce: "nonce-cold",
};

test("signs and verifies an account_link intent round-trip", () => {
  for (const intent of [WARM, COLD]) {
    const result = verifyConnectorState(
      signConnectorState(intent, SECRET, 900),
      SECRET,
    );
    assert.equal(result.valid, true);
    assert.deepEqual(result.intent, intent);
    // The connector surface's binding field is absent, not empty-string.
    assert.equal(result.intent?.connectorId, undefined);
  }
});

test("a tampered payload fails with bad_signature", () => {
  const token = signConnectorState(WARM, SECRET, 900);
  const [payloadB64, sig] = token.split(".");
  assert.ok(payloadB64 && sig);
  const payload = JSON.parse(
    Buffer.from(payloadB64, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  // The exact attack the signature exists to stop: re-point the sealed
  // contact at someone else's row and keep the old signature.
  payload.contactId = "99999999-9999-9999-9999-999999999999";
  const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;

  const result = verifyConnectorState(forged, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "bad_signature");
  assert.equal(result.intent, undefined);
});

test("an expired account_link state fails with expired", () => {
  const token = signConnectorState(WARM, SECRET, -1);
  const result = verifyConnectorState(token, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "expired");
  assert.equal(result.intent, undefined);
});

test("the existing install/member_link round-trips are unchanged", () => {
  const install: ConnectorStateIntent = {
    purpose: "install",
    connectorId: "discord",
    nonce: "nonce-install",
  };
  const memberLink: ConnectorStateIntent = {
    purpose: "member_link",
    connectorId: "discord",
    contactId: "contact-123",
    email: "alice@example.com",
    nonce: "nonce-member",
  };

  for (const intent of [install, memberLink]) {
    const result = verifyConnectorState(
      signConnectorState(intent, SECRET, 600),
      SECRET,
    );
    assert.equal(result.valid, true);
    assert.deepEqual(result.intent, intent);
    // Neither connector purpose ever carries the account-link fields.
    assert.equal(result.intent?.providerId, undefined);
    assert.equal(result.intent?.anonymousId, undefined);
    assert.equal(result.intent?.returnTo, undefined);
  }
});

test("an account_link state carries no connectorId, so the connector callback's own check rejects it", () => {
  // `routes/connectors/index.ts` compares `intent.connectorId !== id`, and
  // `undefined !== "steam"` is true. This pins the INCIDENTAL half of the
  // defence; the EXPLICIT purpose allowlist is pinned separately in
  // `apps/api/src/__tests__/connectors-oauth-state-purpose.test.ts` so the two
  // guards are never aliased onto one test.
  const result = verifyConnectorState(
    signConnectorState(WARM, SECRET, 900),
    SECRET,
  );
  assert.equal(result.valid, true);
  assert.notEqual(result.intent?.connectorId, "steam");
});
