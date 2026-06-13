import {
  sign as edSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  handleInteraction,
  InteractionResponseType,
  InteractionType,
  verifyInteractionSignature,
} from "../connect/interactions.js";

/**
 * Generate a real Ed25519 keypair, sign `timestamp || body` exactly as Discord
 * does, and exercise the `node:crypto`-based verifier. No tweetnacl, no mocks.
 */
function makeSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Discord publishes the RAW 32-byte public key as hex — extract it from the
  // SPKI DER (the last 32 bytes) to feed our raw-key verifier.
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyHex = spki.subarray(spki.length - 32).toString("hex");
  return { publicKeyHex, privateKey };
}

function sign(privateKey: KeyObject, timestamp: string, rawBody: string) {
  return edSign(
    null,
    Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]),
    privateKey,
  ).toString("hex");
}

/** A timestamp inside the replay window (now, in unix seconds). */
function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe("verifyInteractionSignature", () => {
  it("accepts a valid signature over timestamp || body", () => {
    const { publicKeyHex, privateKey } = makeSigner();
    const timestamp = nowTs();
    const rawBody = JSON.stringify({ type: 1 });
    const signatureHex = sign(privateKey, timestamp, rawBody);

    expect(
      verifyInteractionSignature({
        publicKeyHex,
        signatureHex,
        timestamp,
        rawBody,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body (signature no longer covers it)", () => {
    const { publicKeyHex, privateKey } = makeSigner();
    const timestamp = nowTs();
    const signatureHex = sign(privateKey, timestamp, JSON.stringify({ a: 1 }));

    expect(
      verifyInteractionSignature({
        publicKeyHex,
        signatureHex,
        timestamp,
        rawBody: JSON.stringify({ a: 2 }),
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay window) even with a valid signature", () => {
    const { publicKeyHex, privateKey } = makeSigner();
    // 10 minutes ago — beyond the 5-minute replay window.
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const rawBody = JSON.stringify({ type: 1 });
    const signatureHex = sign(privateKey, timestamp, rawBody);

    expect(
      verifyInteractionSignature({
        publicKeyHex,
        signatureHex,
        timestamp,
        rawBody,
      }),
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    const { publicKeyHex, privateKey } = makeSigner();
    const timestamp = "not-a-number";
    const rawBody = JSON.stringify({ type: 1 });
    const signatureHex = sign(privateKey, timestamp, rawBody);

    expect(
      verifyInteractionSignature({
        publicKeyHex,
        signatureHex,
        timestamp,
        rawBody,
      }),
    ).toBe(false);
  });

  it("fails closed on a missing signature or timestamp", () => {
    const { publicKeyHex } = makeSigner();
    expect(
      verifyInteractionSignature({
        publicKeyHex,
        signatureHex: "",
        timestamp: nowTs(),
        rawBody: "{}",
      }),
    ).toBe(false);
    expect(
      verifyInteractionSignature({
        publicKeyHex,
        signatureHex: "aa".repeat(64),
        timestamp: "",
        rawBody: "{}",
      }),
    ).toBe(false);
  });

  it("fails closed on a malformed public key", () => {
    expect(
      verifyInteractionSignature({
        publicKeyHex: "not-hex-and-wrong-length",
        signatureHex: "aa".repeat(64),
        timestamp: nowTs(),
        rawBody: "{}",
      }),
    ).toBe(false);
  });
});

describe("handleInteraction", () => {
  it("answers PING with PONG", () => {
    expect(handleInteraction({ type: InteractionType.PING })).toEqual({
      type: InteractionResponseType.PONG,
    });
  });

  it("defers any non-PING interaction", () => {
    expect(
      handleInteraction({ type: InteractionType.APPLICATION_COMMAND }),
    ).toEqual({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });
  });
});
