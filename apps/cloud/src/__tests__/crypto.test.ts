import { describe, expect, it } from "vitest";
import {
  CIPHERTEXT_VERSION,
  CloudDecryptError,
  decryptSecretPayload,
  encryptSecretPayload,
} from "../lib/crypto";

/**
 * Pure crypto — no database. Every assertion here is a fail-CLOSED property:
 * the only way to read a payload back is with the exact ciphertext and the
 * exact secret it was written under.
 *
 * The literals below are obvious fakes (`fake-…`) so no line of this file ever
 * resembles a real credential.
 */
const SECRET_A = "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_B = "test-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const PAYLOAD = {
  apiKey: "fake-api-key-0000-1111",
  fromEmail: "hello@example.test",
  nested: { region: "us", retries: 3, enabled: true },
  list: ["a", "b"],
};

/** Flip one bit inside the body (past the `v1:` prefix) of a ciphertext. */
function tamper(blob: string): string {
  const prefix = `${CIPHERTEXT_VERSION}:`;
  const body = blob.slice(prefix.length);
  const raw = Buffer.from(body, "base64url");
  // Byte 20 lands inside the ciphertext (IV is the first 12 bytes), so this
  // corrupts the message itself rather than the nonce.
  raw[20] = raw[20] === undefined ? 0 : raw[20] ^ 0xff;
  return prefix + raw.toString("base64url");
}

describe("cloud crypto", () => {
  it("round-trips an arbitrary JSON payload", () => {
    const blob = encryptSecretPayload(PAYLOAD, SECRET_A);
    expect(decryptSecretPayload(blob, SECRET_A)).toEqual(PAYLOAD);
  });

  it("emits a versioned, non-plaintext ciphertext", () => {
    const blob = encryptSecretPayload(PAYLOAD, SECRET_A);
    expect(blob.startsWith(`${CIPHERTEXT_VERSION}:`)).toBe(true);
    // The secret must not survive anywhere in the encoded blob.
    expect(blob).not.toContain(PAYLOAD.apiKey);
    expect(Buffer.from(blob).toString()).not.toContain("fromEmail");
  });

  it("uses a fresh IV per call (same payload → different ciphertext)", () => {
    const a = encryptSecretPayload(PAYLOAD, SECRET_A);
    const b = encryptSecretPayload(PAYLOAD, SECRET_A);
    expect(a).not.toBe(b);
    expect(decryptSecretPayload(a, SECRET_A)).toEqual(
      decryptSecretPayload(b, SECRET_A),
    );
  });

  it("fails closed on a tampered ciphertext", () => {
    const blob = tamper(encryptSecretPayload(PAYLOAD, SECRET_A));
    expect(() => decryptSecretPayload(blob, SECRET_A)).toThrow(
      CloudDecryptError,
    );
  });

  it("fails closed under the wrong secret", () => {
    const blob = encryptSecretPayload(PAYLOAD, SECRET_A);
    expect(() => decryptSecretPayload(blob, SECRET_B)).toThrow(
      CloudDecryptError,
    );
  });

  it("rejects an unknown version prefix", () => {
    const blob = encryptSecretPayload(PAYLOAD, SECRET_A);
    const forged = `v2:${blob.slice(CIPHERTEXT_VERSION.length + 1)}`;
    expect(() => decryptSecretPayload(forged, SECRET_A)).toThrow(
      CloudDecryptError,
    );
  });

  it("rejects a blob with no version prefix at all", () => {
    const blob = encryptSecretPayload(PAYLOAD, SECRET_A);
    const bare = blob.slice(CIPHERTEXT_VERSION.length + 1);
    expect(() => decryptSecretPayload(bare, SECRET_A)).toThrow(
      CloudDecryptError,
    );
  });

  it("rejects a truncated body that cannot hold iv + tag", () => {
    expect(() => decryptSecretPayload(`${CIPHERTEXT_VERSION}:AAAA`)).toThrow(
      CloudDecryptError,
    );
  });

  it("rejects a secret shorter than 32 characters", () => {
    expect(() => encryptSecretPayload(PAYLOAD, "too-short")).toThrow(
      CloudDecryptError,
    );
  });
});
