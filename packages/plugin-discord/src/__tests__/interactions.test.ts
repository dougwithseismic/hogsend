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
  type RequestConfirmResult,
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
  // requestConfirm mints a cold-connect token AND emails the confirm link inside
  // the consumer — the handler only sees the `{ ok }` result, NEVER the token.
  const requestConfirm = vi.fn(
    async (): Promise<RequestConfirmResult> => ({ ok: true }),
  );
  // The generalized follow-up editor: a full message `body`, NOT a `content`
  // string (it carries `content` for the link-confirm flow).
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
    requestConfirm,
    editResponse,
    logger,
    ...overrides,
  };
  return { deps, requestConfirm, editResponse, logger };
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

describe("handleInteraction — /link (open the email modal)", () => {
  it("opens the email modal (type 9), does NO work", async () => {
    const { deps, requestConfirm } = makeDeps();
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
    expect(requestConfirm).not.toHaveBeenCalled();
  });
});

describe("handleInteraction — email modal submit (defer → requestConfirm)", () => {
  it("DEFERS ephemerally, then mints + emails the link + PATCHes 'check your inbox'", async () => {
    const { deps, requestConfirm, editResponse } = makeDeps();
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

    // Email normalized (trim + lowercase) and bound to the invoking user. The
    // consumer's requestConfirm mints the cold-connect token + emails the link.
    expect(requestConfirm).toHaveBeenCalledWith({
      discordUserId: "discord-user-1",
      email: "ada@example.com",
    });
    // The deferred ack is PATCHed into a button-less "check your inbox" message.
    expect(editResponse).toHaveBeenCalledTimes(1);
    const editArg = editResponse.mock.calls[0]?.[0];
    expect(editArg?.applicationId).toBe("app-1");
    expect(editArg?.token).toBe("tok-email");
    // The email is NEVER echoed in the rendered message.
    expect(JSON.stringify(editArg?.body)).not.toContain("ada@example.com");
    // No components/button — the confirm action lives in the EMAILED link.
    expect(editArg?.body?.components).toBeUndefined();
    expect(editArg?.body?.content).toContain("Check your inbox");
    expect(editArg?.body?.content).toContain("link");
  });

  it("rejects an over-length email (>254) INLINE: no defer, no requestConfirm", async () => {
    const { deps, requestConfirm, editResponse } = makeDeps();
    // 250-char local part → > 254 total once the domain is appended.
    const overLong = `${"a".repeat(250)}@example.com`;
    const res = await handleInteraction(emailSubmitPayload(overLong), deps);
    await flush();

    // Synchronous inline ephemeral error (type 4) — NOT a deferral, so no racy
    // follow-up PATCH is needed for the most common mistake.
    expect(res.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(res.data?.flags).toBe(InteractionCallbackFlags.EPHEMERAL);
    expect(res.data?.content).toContain("valid email");
    expect(requestConfirm).not.toHaveBeenCalled();
    expect(editResponse).not.toHaveBeenCalled();
  });

  it("rejects a malformed email INLINE: no defer, no requestConfirm", async () => {
    const { deps, requestConfirm, editResponse } = makeDeps();
    const res = await handleInteraction(
      emailSubmitPayload("not-an-email"),
      deps,
    );
    await flush();

    expect(res.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(res.data?.flags).toBe(InteractionCallbackFlags.EPHEMERAL);
    expect(res.data?.content).toContain("valid email");
    expect(requestConfirm).not.toHaveBeenCalled();
    expect(editResponse).not.toHaveBeenCalled();
  });

  it("rate_limited: PATCHes a 'too many' reply (cold-connect throttle fired)", async () => {
    const requestConfirm = vi.fn(
      async (): Promise<RequestConfirmResult> => ({
        ok: false,
        reason: "rate_limited",
      }),
    );
    const { deps, editResponse } = makeDeps({ requestConfirm });
    await handleInteraction(emailSubmitPayload("ada@example.com"), deps);
    await flush();

    expect(editResponse).toHaveBeenCalledTimes(1);
    const body = editResponse.mock.calls[0]?.[0]?.body;
    expect(body?.content).toContain("too many");
    // No link was emailed → no inbox copy.
    expect(body?.content).not.toContain("Check your inbox");
  });

  it("unavailable (Redis down): PATCHes a 'briefly unavailable' reply", async () => {
    const requestConfirm = vi.fn(
      async (): Promise<RequestConfirmResult> => ({
        ok: false,
        reason: "unavailable",
      }),
    );
    const { deps, editResponse } = makeDeps({ requestConfirm });
    await handleInteraction(emailSubmitPayload("ada@example.com"), deps);
    await flush();

    expect(editResponse.mock.calls[0]?.[0]?.body?.content).toContain(
      "briefly unavailable",
    );
  });

  it("fails closed on a requestConfirm throw: logs, PATCHes an apology", async () => {
    const requestConfirm = vi.fn(async (): Promise<RequestConfirmResult> => {
      throw new Error("mailer down");
    });
    const { deps, editResponse, logger } = makeDeps({ requestConfirm });
    await handleInteraction(emailSubmitPayload("ada@example.com"), deps);
    await flush();

    expect(logger.error).toHaveBeenCalled();
    // Never log the email / any provider detail — only a short reason.
    const meta = logger.error.mock.calls[0]?.[1] as { error?: string };
    expect(meta?.error).toBe("mailer down");
    expect(editResponse.mock.calls[0]?.[0]?.body?.content).toContain(
      "went wrong",
    );
  });
});
