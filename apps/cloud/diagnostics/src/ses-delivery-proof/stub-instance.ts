import { createServer } from "node:http";
import {
  HOGSEND_RELAY_SIGNATURE_HEADER,
  verifyHogsendRelaySignature,
} from "@hogsend/plugin-hogsend";

/**
 * The run-scoped STAND-IN for a tenant instance — the receiving end of the
 * signed webhook hop.
 *
 * ## The design call (PRD 19 "instance hop"), and its honest limit
 *
 * An event whose tenant resolves to no stack ends `dropped`, so without this
 * the signed hop would never fire and the proof would stop at the ingress.
 * Registering a run-scoped stack whose `apiPublicUrl` points here makes the
 * control plane exercise its REAL delivery path — tenant resolution, webhook
 * secret decryption, `postToInstance`, the HMAC over the exact bytes — against
 * a listener that verifies with `verifyHogsendRelaySignature`, IMPORTED from
 * `@hogsend/plugin-hogsend`: the same function a real engine instance verifies
 * with, so the two ends of the wire cannot drift apart in this proof either.
 *
 * What this deliberately does NOT fake: the engine's `handleWebhook` → the
 * `email_sends` terminal status. A stub that pretended to be a whole engine
 * would prove nothing about the engine, so the report names that link as NOT
 * exercised instead of quietly claiming it.
 *
 * Loopback only, ephemeral port, torn down with everything else. An invalid
 * signature answers 401 — the same refusal a real instance gives — and is
 * RECORDED, because a signature failure here means the control plane and the
 * plugin disagree about the wire, which is exactly the class of finding this
 * script exists to surface.
 */

/** The engine route the relay POSTs to (`services/email-events.ts`). */
const WEBHOOK_PATH = "/v1/webhooks/email/hogsend";

export interface StubReceipt {
  signatureValid: boolean;
  /** The relay event type, read from the verified payload. */
  type: string | null;
  messageId: string | null;
}

export interface StubInstance {
  /** `http://127.0.0.1:<port>` — what the stack row's `apiPublicUrl` holds. */
  url: string;
  received: StubReceipt[];
  close(): Promise<void>;
}

export function startStubInstance(input: {
  secret: string;
}): Promise<StubInstance> {
  const received: StubReceipt[] = [];

  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== WEBHOOK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // Verify over the EXACT received bytes, like the engine does — the
      // control plane signs what it sends, and any re-serialization between
      // the two ends would break every signature.
      const payload = Buffer.concat(chunks).toString("utf8");
      const signature = request.headers[HOGSEND_RELAY_SIGNATURE_HEADER] ?? "";
      const signatureValid = verifyHogsendRelaySignature({
        payload,
        secret: input.secret,
        signature: Array.isArray(signature) ? (signature[0] ?? "") : signature,
      });

      let type: string | null = null;
      let messageId: string | null = null;
      if (signatureValid) {
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          type = typeof parsed.type === "string" ? parsed.type : null;
          messageId =
            typeof parsed.messageId === "string" ? parsed.messageId : null;
        } catch {
          // A signed body that is not JSON is still a receipt worth keeping.
        }
      }
      received.push({ signatureValid, type, messageId });

      if (!signatureValid) {
        // 401, matching a real instance's refusal — and `postToInstance`
        // never retries a 4xx, so a broken signature settles as ONE failed
        // event row instead of hammering the stub.
        response
          .writeHead(401, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "invalid_signature" }));
        return;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Port 0: the OS picks a free one, so two proof runs cannot collide.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("stub instance bound to no TCP address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        received,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) =>
              error ? rejectClose(error) : resolveClose(),
            );
          }),
      });
    });
  });
}
