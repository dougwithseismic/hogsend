import { createHmac } from "node:crypto";
import {
  type ConnectorStateIntent,
  signConnectorState,
  verifyConnectorState,
} from "@hogsend/engine";
import { describe, expect, it } from "vitest";

// DB-free unit tests for the engine-owned signed connector-state crypto. Pure
// `node:crypto` + the public engine exports — no container, db, or http.

const SECRET = "test-secret-for-connector-state-minimum-32-characters";

const INSTALL_INTENT: ConnectorStateIntent = {
  purpose: "install",
  connectorId: "discord",
  nonce: "nonce-abc",
};

const MEMBER_INTENT: ConnectorStateIntent = {
  purpose: "member_link",
  connectorId: "discord",
  contactId: "contact-123",
  email: "alice@example.com",
  nonce: "nonce-xyz",
};

const base64url = (input: string): string =>
  Buffer.from(input).toString("base64url");

describe("signConnectorState / verifyConnectorState — round-trip", () => {
  it("a freshly minted install token verifies and decodes its intent", () => {
    const token = signConnectorState(INSTALL_INTENT, SECRET, 600);
    const result = verifyConnectorState(token, SECRET);

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.intent).toEqual(INSTALL_INTENT);
  });

  it("round-trips purpose/connectorId/contactId/email for a member_link token", () => {
    const token = signConnectorState(MEMBER_INTENT, SECRET, 900);
    const result = verifyConnectorState(token, SECRET);

    expect(result.valid).toBe(true);
    expect(result.intent?.purpose).toBe("member_link");
    expect(result.intent?.connectorId).toBe("discord");
    expect(result.intent?.contactId).toBe("contact-123");
    expect(result.intent?.email).toBe("alice@example.com");
    expect(result.intent?.nonce).toBe("nonce-xyz");
  });

  it("does not leak `exp` into the decoded intent", () => {
    const token = signConnectorState(INSTALL_INTENT, SECRET, 600);
    const result = verifyConnectorState(token, SECRET);
    expect(result.intent).toBeDefined();
    expect("exp" in (result.intent as object)).toBe(false);
  });
});

describe("verifyConnectorState — rejects bad signatures", () => {
  it("a token signed with a different secret is invalid", () => {
    const token = signConnectorState(INSTALL_INTENT, SECRET, 600);
    const result = verifyConnectorState(token, "a-completely-different-secret");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad_signature");
    expect(result.intent).toBeUndefined();
  });

  it("a tampered payload (re-encoded, old signature) is invalid", () => {
    const token = signConnectorState(INSTALL_INTENT, SECRET, 600);
    const [, sig] = token.split(".");
    // Forge a DIFFERENT payload but reuse the original signature.
    const forgedPayload = base64url(
      JSON.stringify({ ...INSTALL_INTENT, connectorId: "evil", exp: 9e9 }),
    );
    const result = verifyConnectorState(`${forgedPayload}.${sig}`, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });

  it("a swapped signature segment is invalid", () => {
    const token = signConnectorState(INSTALL_INTENT, SECRET, 600);
    const [payload] = token.split(".");
    // A correctly-shaped HMAC of UNRELATED bytes → length-equal but wrong.
    const wrongSig = createHmac("sha256", SECRET)
      .update("unrelated-bytes")
      .digest("base64url");
    const result = verifyConnectorState(`${payload}.${wrongSig}`, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });

  it("a garbage signature segment is invalid", () => {
    const token = signConnectorState(INSTALL_INTENT, SECRET, 600);
    const [payload] = token.split(".");
    const result = verifyConnectorState(
      `${payload}.not-a-real-signature`,
      SECRET,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });
});

describe("verifyConnectorState — rejects expired tokens", () => {
  it("a token whose exp is in the past (valid signature) is invalid", () => {
    // A negative ttl mints a correctly-signed token with exp already elapsed.
    const token = signConnectorState(INSTALL_INTENT, SECRET, -10);
    const result = verifyConnectorState(token, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("expired");
    expect(result.intent).toBeUndefined();
  });
});

describe("verifyConnectorState — malformed tokens never throw", () => {
  const sign = (payloadB64: string): string =>
    createHmac("sha256", SECRET).update(payloadB64).digest("base64url");

  const cases: Array<[string, string]> = [
    ["empty string", ""],
    ["no dot separator", "abcdef"],
    ["leading dot", ".abcdef"],
    ["trailing dot", "abcdef."],
  ];

  for (const [name, token] of cases) {
    it(`${name} → { valid: false } without throwing`, () => {
      let result: ReturnType<typeof verifyConnectorState> | undefined;
      expect(() => {
        result = verifyConnectorState(token, SECRET);
      }).not.toThrow();
      expect(result?.valid).toBe(false);
      expect(result?.intent).toBeUndefined();
    });
  }

  it("non-base64 payload (valid-shaped sig over it) → invalid, no throw", () => {
    // `!!!` is not valid base64url; decoding it then JSON-parsing must fail
    // softly. We sign the literal payload bytes so the signature check passes
    // and the failure is forced into the payload-decode branch.
    const payloadB64 = "!!!not-base64!!!";
    const token = `${payloadB64}.${sign(payloadB64)}`;
    let result: ReturnType<typeof verifyConnectorState> | undefined;
    expect(() => {
      result = verifyConnectorState(token, SECRET);
    }).not.toThrow();
    expect(result?.valid).toBe(false);
  });

  it("non-JSON payload (valid signature) → malformed_payload, no throw", () => {
    const payloadB64 = base64url("this is not json");
    const token = `${payloadB64}.${sign(payloadB64)}`;
    let result: ReturnType<typeof verifyConnectorState> | undefined;
    expect(() => {
      result = verifyConnectorState(token, SECRET);
    }).not.toThrow();
    expect(result?.valid).toBe(false);
    expect(result?.reason).toBe("malformed_payload");
  });

  it("a JSON-array payload (no numeric exp, valid signature) → invalid, no throw", () => {
    const payloadB64 = base64url(JSON.stringify(["not", "an", "object"]));
    const token = `${payloadB64}.${sign(payloadB64)}`;
    let result: ReturnType<typeof verifyConnectorState> | undefined;
    expect(() => {
      result = verifyConnectorState(token, SECRET);
    }).not.toThrow();
    expect(result?.valid).toBe(false);
    expect(result?.reason).toBe("malformed_payload");
  });
});
