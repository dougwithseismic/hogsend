import {
  sign as edSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  handleInteraction,
  InteractionCallbackFlags,
  type InteractionDeps,
  InteractionResponseType,
  InteractionType,
  type LinkMintResult,
  type LinkRedeemResult,
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
  it("answers PING with PONG", async () => {
    expect(await handleInteraction({ type: InteractionType.PING })).toEqual({
      type: InteractionResponseType.PONG,
    });
  });

  it("defers any non-PING interaction with no deps", async () => {
    expect(
      await handleInteraction({ type: InteractionType.APPLICATION_COMMAND }),
    ).toEqual({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });
  });
});

/** Let queued microtasks (the fire-and-forget `/link` follow-up) settle. */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

type DepOverrides = Partial<InteractionDeps>;

/** Build a fully-mocked {@link InteractionDeps} with sensible happy defaults. */
function makeDeps(overrides: DepOverrides = {}) {
  const mintCode = vi.fn(
    async (): Promise<LinkMintResult> => ({ ok: true, code: "428917" }),
  );
  const sendLinkCode = vi.fn(async () => {});
  const redeemCode = vi.fn(
    async (): Promise<LinkRedeemResult> => ({
      ok: true,
      email: "ada@example.com",
    }),
  );
  const resolveContact = vi.fn(async () => {});
  const editResponse = vi.fn(
    async (_args: {
      applicationId: string;
      token: string;
      content: string;
    }) => {},
  );
  const logger = { error: vi.fn() };
  const deps: InteractionDeps = {
    applicationId: "app-1",
    mintCode,
    sendLinkCode,
    redeemCode,
    resolveContact,
    editResponse,
    logger,
    ...overrides,
  };
  return {
    deps,
    mintCode,
    sendLinkCode,
    redeemCode,
    resolveContact,
    editResponse,
    logger,
  };
}

/** A `/link` APPLICATION_COMMAND payload (guild context → member.user.id). */
function linkPayload(email: string, opts: { userId?: string } = {}) {
  return {
    type: InteractionType.APPLICATION_COMMAND,
    token: "tok-link",
    data: {
      name: "link",
      options: [{ name: "email", value: email }],
    },
    member: { user: { id: opts.userId ?? "discord-user-1" } },
  };
}

/** A `/verify` APPLICATION_COMMAND payload. */
function verifyPayload(code: string, opts: { userId?: string } = {}) {
  return {
    type: InteractionType.APPLICATION_COMMAND,
    token: "tok-verify",
    data: {
      name: "verify",
      options: [{ name: "code", value: code }],
    },
    member: { user: { id: opts.userId ?? "discord-user-1" } },
  };
}

describe("handleInteraction — /link", () => {
  it("DEFERS ephemerally, then mints + emails + edits @original", async () => {
    const { deps, mintCode, sendLinkCode, editResponse } = makeDeps();
    const res = await handleInteraction(linkPayload("Ada@Example.com"), deps);

    // The immediate response is a type-5 EPHEMERAL deferred ack (within 3s).
    expect(res.type).toBe(
      InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect(res.data?.flags).toBe(InteractionCallbackFlags.EPHEMERAL);

    await flush();

    // Email is normalized to lowercase + trimmed and bound to the invoking user.
    expect(mintCode).toHaveBeenCalledWith({
      discordUserId: "discord-user-1",
      email: "ada@example.com",
    });
    expect(sendLinkCode).toHaveBeenCalledWith({
      email: "ada@example.com",
      code: "428917",
    });
    // The deferred ack is PATCHed into the "check your inbox" reply.
    expect(editResponse).toHaveBeenCalledTimes(1);
    const editArg = editResponse.mock.calls[0]?.[0];
    expect(editArg?.applicationId).toBe("app-1");
    expect(editArg?.token).toBe("tok-link");
    expect(editArg?.content).toContain("ada@example.com");
  });

  it("rejects a malformed email inline, never minting", async () => {
    const { deps, mintCode, sendLinkCode, editResponse } = makeDeps();
    const res = await handleInteraction(linkPayload("not-an-email"), deps);

    expect(res.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(res.data?.flags).toBe(InteractionCallbackFlags.EPHEMERAL);
    expect(res.data?.content).toContain("email address");

    await flush();
    expect(mintCode).not.toHaveBeenCalled();
    expect(sendLinkCode).not.toHaveBeenCalled();
    expect(editResponse).not.toHaveBeenCalled();
  });

  it("over-throttle: no send, edits with a 'too many codes' reply", async () => {
    const mintCode = vi.fn(
      async (): Promise<LinkMintResult> => ({
        ok: false,
        reason: "throttled",
      }),
    );
    const { deps, sendLinkCode, editResponse } = makeDeps({ mintCode });
    await handleInteraction(linkPayload("ada@example.com"), deps);
    await flush();

    expect(sendLinkCode).not.toHaveBeenCalled();
    expect(editResponse).toHaveBeenCalledTimes(1);
    expect(editResponse.mock.calls[0]?.[0]?.content).toContain(
      "too many codes",
    );
  });

  it("fails closed on a mint throw: logs, edits an apology, no send", async () => {
    const mintCode = vi.fn(async (): Promise<LinkMintResult> => {
      throw new Error("db down");
    });
    const { deps, sendLinkCode, editResponse, logger } = makeDeps({ mintCode });
    await handleInteraction(linkPayload("ada@example.com"), deps);
    await flush();

    expect(sendLinkCode).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    // Never log the email / any provider detail — only a short reason.
    const meta = logger.error.mock.calls[0]?.[1] as { error?: string };
    expect(meta?.error).toBe("db down");
    expect(editResponse.mock.calls[0]?.[0]?.content).toContain("went wrong");
  });
});

describe("handleInteraction — /verify", () => {
  it("redeems, attaches the email, replies ephemerally", async () => {
    const { deps, redeemCode, resolveContact } = makeDeps();
    const res = await handleInteraction(verifyPayload(" 428917 "), deps);

    // INLINE ephemeral reply (type 4) — no deferral for /verify.
    expect(res.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(res.data?.flags).toBe(InteractionCallbackFlags.EPHEMERAL);
    expect(res.data?.content).toContain("ada@example.com");

    // Code is trimmed and bound to the invoking Discord user.
    expect(redeemCode).toHaveBeenCalledWith({
      discordUserId: "discord-user-1",
      code: "428917",
    });
    expect(resolveContact).toHaveBeenCalledWith({
      discordId: "discord-user-1",
      email: "ada@example.com",
    });
  });

  it("rejects an empty code without redeeming", async () => {
    const { deps, redeemCode } = makeDeps();
    const res = await handleInteraction(verifyPayload("   "), deps);

    expect(res.data?.content).toContain("Usage");
    expect(redeemCode).not.toHaveBeenCalled();
  });

  it("invalid/used/expired collapse to one non-leaking reply, no attach", async () => {
    const redeemCode = vi.fn(
      async (): Promise<LinkRedeemResult> => ({
        ok: false,
        reason: "invalid",
      }),
    );
    const { deps, resolveContact } = makeDeps({ redeemCode });
    const res = await handleInteraction(verifyPayload("000000"), deps);

    expect(res.data?.content).toContain("invalid, expired, or already used");
    expect(resolveContact).not.toHaveBeenCalled();
  });

  it("wrong_user is rejected without attaching (no identity grafting)", async () => {
    const redeemCode = vi.fn(
      async (): Promise<LinkRedeemResult> => ({
        ok: false,
        reason: "wrong_user",
      }),
    );
    const { deps, resolveContact } = makeDeps({ redeemCode });
    const res = await handleInteraction(verifyPayload("428917"), deps);

    expect(res.data?.content).toContain("invalid, expired, or already used");
    expect(resolveContact).not.toHaveBeenCalled();
  });

  it("attempt-throttle blocks BEFORE redeem when over cap", async () => {
    const recordVerifyAttempt = vi.fn(async () => ({ throttled: true }));
    const { deps, redeemCode } = makeDeps({ recordVerifyAttempt });
    const res = await handleInteraction(verifyPayload("428917"), deps);

    expect(res.data?.content).toContain("Too many verification attempts");
    expect(recordVerifyAttempt).toHaveBeenCalledWith({
      discordUserId: "discord-user-1",
    });
    expect(redeemCode).not.toHaveBeenCalled();
  });
});
