import {
  sign as edSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ComponentType,
  CustomIds,
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

/** Let queued microtasks (the fire-and-forget modal follow-ups) settle. */
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
  // The generalized follow-up editor: a full message `body`, NOT a `content`
  // string (the V2 success card / Enter-code button need `components`/`flags`).
  const editResponse = vi.fn(
    async (_args: {
      applicationId: string;
      token: string;
      body: Record<string, unknown>;
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
function linkPayload(opts: { userId?: string } = {}) {
  return {
    type: InteractionType.APPLICATION_COMMAND,
    token: "tok-link",
    data: { name: "link" },
    member: { user: { id: opts.userId ?? "discord-user-1" } },
  };
}

/** An email MODAL_SUBMIT payload (legacy Action Row > Text Input shape). */
function emailSubmitPayload(email: string, opts: { userId?: string } = {}) {
  return {
    type: InteractionType.MODAL_SUBMIT,
    token: "tok-email",
    data: {
      custom_id: CustomIds.EMAIL_MODAL,
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: "email",
              value: email,
            },
          ],
        },
      ],
    },
    member: { user: { id: opts.userId ?? "discord-user-1" } },
  };
}

/** An "Enter code" MESSAGE_COMPONENT (button-click) payload. */
function enterCodePayload(opts: { userId?: string } = {}) {
  return {
    type: InteractionType.MESSAGE_COMPONENT,
    token: "tok-button",
    data: { custom_id: CustomIds.ENTER_CODE_BUTTON },
    member: { user: { id: opts.userId ?? "discord-user-1" } },
  };
}

/** A code MODAL_SUBMIT payload (Label-wrapper shape, to exercise the walk). */
function codeSubmitPayload(code: string, opts: { userId?: string } = {}) {
  return {
    type: InteractionType.MODAL_SUBMIT,
    token: "tok-code",
    data: {
      custom_id: CustomIds.CODE_MODAL,
      // Modern Label (type 18) wrapping a single nested Text Input — readModalValue
      // must descend into `component`, not just an Action Row's `components`.
      components: [
        {
          type: ComponentType.LABEL,
          component: {
            type: ComponentType.TEXT_INPUT,
            custom_id: "code",
            value: code,
          },
        },
      ],
    },
    member: { user: { id: opts.userId ?? "discord-user-1" } },
  };
}

describe("handleInteraction — /link (open the email modal)", () => {
  it("opens the email modal (type 9), does NO work", async () => {
    const { deps, mintCode, sendLinkCode } = makeDeps();
    const res = await handleInteraction(linkPayload(), deps);

    expect(res.type).toBe(InteractionResponseType.MODAL);
    expect(res.data?.custom_id).toBe(CustomIds.EMAIL_MODAL);
    // A modal is inherently private — it takes NO flags.
    expect(res.data?.flags).toBeUndefined();
    // Single Text Input collecting the email by inner custom_id "email".
    const rows = res.data?.components as Array<{
      components: Array<{ custom_id: string }>;
    }>;
    expect(rows?.[0]?.components?.[0]?.custom_id).toBe("email");

    await flush();
    expect(mintCode).not.toHaveBeenCalled();
    expect(sendLinkCode).not.toHaveBeenCalled();
  });
});

describe("handleInteraction — email modal submit (defer → mint → send)", () => {
  it("DEFERS ephemerally, then mints + emails + PATCHes the button", async () => {
    const { deps, mintCode, sendLinkCode, editResponse } = makeDeps();
    const res = await handleInteraction(
      emailSubmitPayload("Ada@Example.com"),
      deps,
    );

    // Immediate response is a type-5 EPHEMERAL deferred ack (within 3s).
    expect(res.type).toBe(
      InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect(res.data?.flags).toBe(InteractionCallbackFlags.EPHEMERAL);

    await flush();

    // Email normalized (trim + lowercase) and bound to the invoking user.
    expect(mintCode).toHaveBeenCalledWith({
      discordUserId: "discord-user-1",
      email: "ada@example.com",
    });
    expect(sendLinkCode).toHaveBeenCalledWith({
      email: "ada@example.com",
      code: "428917",
    });
    // The deferred ack is PATCHed into the "check your inbox" + button message.
    expect(editResponse).toHaveBeenCalledTimes(1);
    const editArg = editResponse.mock.calls[0]?.[0];
    expect(editArg?.applicationId).toBe("app-1");
    expect(editArg?.token).toBe("tok-email");
    // The email is NEVER echoed in the rendered message.
    expect(JSON.stringify(editArg?.body)).not.toContain("ada@example.com");
    // The Enter-code button is present, carrying the static bridge custom_id.
    const comps = editArg?.body?.components as Array<{
      components: Array<{ custom_id: string }>;
    }>;
    expect(comps?.[0]?.components?.[0]?.custom_id).toBe(
      CustomIds.ENTER_CODE_BUTTON,
    );
    expect(editArg?.body?.content).toContain("Check your inbox");
  });

  it("rejects an over-length email (>254) INLINE: no defer, no mint", async () => {
    const { deps, mintCode, sendLinkCode, editResponse } = makeDeps();
    // 250-char local part → > 254 total once the domain is appended.
    const overLong = `${"a".repeat(250)}@example.com`;
    const res = await handleInteraction(emailSubmitPayload(overLong), deps);
    await flush();

    // Synchronous inline ephemeral error (type 4) — NOT a deferral, so no racy
    // follow-up PATCH is needed for the most common mistake.
    expect(res.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(res.data?.flags).toBe(InteractionCallbackFlags.EPHEMERAL);
    expect(res.data?.content).toContain("valid email");
    expect(mintCode).not.toHaveBeenCalled();
    expect(sendLinkCode).not.toHaveBeenCalled();
    expect(editResponse).not.toHaveBeenCalled();
  });

  it("rejects a malformed email INLINE: no defer, no mint", async () => {
    const { deps, mintCode, sendLinkCode, editResponse } = makeDeps();
    const res = await handleInteraction(
      emailSubmitPayload("not-an-email"),
      deps,
    );
    await flush();

    expect(res.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(res.data?.flags).toBe(InteractionCallbackFlags.EPHEMERAL);
    expect(res.data?.content).toContain("valid email");
    expect(mintCode).not.toHaveBeenCalled();
    expect(sendLinkCode).not.toHaveBeenCalled();
    expect(editResponse).not.toHaveBeenCalled();
  });

  it("over-throttle: no send, PATCHes a 'too many codes' reply", async () => {
    const mintCode = vi.fn(
      async (): Promise<LinkMintResult> => ({
        ok: false,
        reason: "throttled",
      }),
    );
    const { deps, sendLinkCode, editResponse } = makeDeps({ mintCode });
    await handleInteraction(emailSubmitPayload("ada@example.com"), deps);
    await flush();

    expect(sendLinkCode).not.toHaveBeenCalled();
    expect(editResponse).toHaveBeenCalledTimes(1);
    expect(editResponse.mock.calls[0]?.[0]?.body?.content).toContain(
      "too many codes",
    );
  });

  it("fails closed on a mint throw: logs, PATCHes an apology, no send", async () => {
    const mintCode = vi.fn(async (): Promise<LinkMintResult> => {
      throw new Error("db down");
    });
    const { deps, sendLinkCode, editResponse, logger } = makeDeps({ mintCode });
    await handleInteraction(emailSubmitPayload("ada@example.com"), deps);
    await flush();

    expect(sendLinkCode).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    // Never log the email / any provider detail — only a short reason.
    const meta = logger.error.mock.calls[0]?.[1] as { error?: string };
    expect(meta?.error).toBe("db down");
    expect(editResponse.mock.calls[0]?.[0]?.body?.content).toContain(
      "went wrong",
    );
  });
});

describe("handleInteraction — Enter-code button (open the code modal)", () => {
  it("opens the code modal (type 9) from the bridge button", async () => {
    const { deps, redeemCode } = makeDeps();
    const res = await handleInteraction(enterCodePayload(), deps);

    expect(res.type).toBe(InteractionResponseType.MODAL);
    expect(res.data?.custom_id).toBe(CustomIds.CODE_MODAL);
    const rows = res.data?.components as Array<{
      components: Array<{ custom_id: string }>;
    }>;
    expect(rows?.[0]?.components?.[0]?.custom_id).toBe("code");

    await flush();
    expect(redeemCode).not.toHaveBeenCalled();
  });
});

describe("handleInteraction — code modal submit (defer → redeem → card)", () => {
  it("DEFERS, then redeems + resolves + PATCHes a V2 success card", async () => {
    const { deps, redeemCode, resolveContact, editResponse } = makeDeps();
    const res = await handleInteraction(codeSubmitPayload(" 428917 "), deps);

    expect(res.type).toBe(
      InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect(res.data?.flags).toBe(InteractionCallbackFlags.EPHEMERAL);

    await flush();

    // Code trimmed (Label-wrapper value read) and bound to the invoking user.
    expect(redeemCode).toHaveBeenCalledWith({
      discordUserId: "discord-user-1",
      code: "428917",
    });
    expect(resolveContact).toHaveBeenCalledWith({
      discordId: "discord-user-1",
      email: "ada@example.com",
    });
    // The PATCH is a Components-V2 ephemeral success card: flags 64 | 32768.
    const editArg = editResponse.mock.calls[0]?.[0];
    expect(editArg?.token).toBe("tok-code");
    expect(editArg?.body?.flags).toBe(
      InteractionCallbackFlags.EPHEMERAL |
        InteractionCallbackFlags.IS_COMPONENTS_V2,
    );
    // The success card NEVER prints the email.
    expect(JSON.stringify(editArg?.body)).not.toContain("ada@example.com");
  });

  it("invalid/used/expired collapse to one non-leaking text edit", async () => {
    const redeemCode = vi.fn(
      async (): Promise<LinkRedeemResult> => ({ ok: false, reason: "invalid" }),
    );
    const { deps, resolveContact, editResponse } = makeDeps({ redeemCode });
    await handleInteraction(codeSubmitPayload("000000"), deps);
    await flush();

    const body = editResponse.mock.calls[0]?.[0]?.body;
    // Failure is a PLAIN text edit (no V2 flag).
    expect(body?.flags).toBeUndefined();
    expect(body?.content).toContain("invalid, expired, or already used");
    expect(resolveContact).not.toHaveBeenCalled();
  });

  it("wrong_user is rejected without attaching (no identity grafting)", async () => {
    const redeemCode = vi.fn(
      async (): Promise<LinkRedeemResult> => ({
        ok: false,
        reason: "wrong_user",
      }),
    );
    const { deps, resolveContact, editResponse } = makeDeps({ redeemCode });
    await handleInteraction(codeSubmitPayload("428917"), deps);
    await flush();

    expect(editResponse.mock.calls[0]?.[0]?.body?.content).toContain(
      "invalid, expired, or already used",
    );
    expect(resolveContact).not.toHaveBeenCalled();
  });

  it("attempt-throttle blocks BEFORE redeem when over cap", async () => {
    const recordVerifyAttempt = vi.fn(async () => ({ throttled: true }));
    const { deps, redeemCode, editResponse } = makeDeps({
      recordVerifyAttempt,
    });
    await handleInteraction(codeSubmitPayload("428917"), deps);
    await flush();

    expect(editResponse.mock.calls[0]?.[0]?.body?.content).toContain(
      "Too many verification attempts",
    );
    expect(recordVerifyAttempt).toHaveBeenCalledWith({
      discordUserId: "discord-user-1",
    });
    expect(redeemCode).not.toHaveBeenCalled();
  });

  it("fail-OPEN: a throttle THROW still proceeds to redeem", async () => {
    const recordVerifyAttempt = vi.fn(async () => {
      throw new Error("redis down");
    });
    const { deps, redeemCode, resolveContact, editResponse, logger } = makeDeps(
      {
        recordVerifyAttempt,
      },
    );
    await handleInteraction(codeSubmitPayload("428917"), deps);
    await flush();

    // The throttle threw, was logged, and the redeem STILL ran (fail-open).
    expect(logger.error).toHaveBeenCalled();
    expect(redeemCode).toHaveBeenCalledWith({
      discordUserId: "discord-user-1",
      code: "428917",
    });
    expect(resolveContact).toHaveBeenCalled();
    // Success card still rendered.
    expect(editResponse.mock.calls[0]?.[0]?.body?.flags).toBe(
      InteractionCallbackFlags.EPHEMERAL |
        InteractionCallbackFlags.IS_COMPONENTS_V2,
    );
  });
});

/** A `/verify <code>` APPLICATION_COMMAND payload (the slash fallback). */
function verifyPayload(code: string, opts: { userId?: string } = {}) {
  return {
    type: InteractionType.APPLICATION_COMMAND,
    token: "tok-verify",
    data: { name: "verify", options: [{ name: "code", value: code }] },
    member: { user: { id: opts.userId ?? "discord-user-1" } },
  };
}

describe("handleInteraction — /verify slash fallback", () => {
  it("redeems, attaches the email, replies ephemerally (inline)", async () => {
    const { deps, redeemCode, resolveContact } = makeDeps();
    const res = await handleInteraction(verifyPayload(" 428917 "), deps);

    // INLINE ephemeral reply (type 4) — no deferral for the slash fallback.
    expect(res.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(res.data?.flags).toBe(InteractionCallbackFlags.EPHEMERAL);
    expect(res.data?.content).toContain("all set");

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

    expect(res.data?.content).toContain("invalid, expired, or already used");
    expect(redeemCode).not.toHaveBeenCalled();
  });

  it("invalid collapses to one non-leaking reply, no attach", async () => {
    const redeemCode = vi.fn(
      async (): Promise<LinkRedeemResult> => ({ ok: false, reason: "invalid" }),
    );
    const { deps, resolveContact } = makeDeps({ redeemCode });
    const res = await handleInteraction(verifyPayload("000000"), deps);

    expect(res.data?.content).toContain("invalid, expired, or already used");
    expect(resolveContact).not.toHaveBeenCalled();
  });
});
