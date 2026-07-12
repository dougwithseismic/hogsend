import { timingSafeEqual } from "node:crypto";
import {
  type VoiceEvent,
  type VoiceEventType,
  type VoiceFailureClass,
  type VoiceToolCall,
  type VoiceToolResult,
  type VoiceTranscriptTurn,
  type VoiceWebhookParsed,
  WebhookHandshakeSignal,
} from "./types.js";

type Rec = Record<string, unknown>;

const asRec = (v: unknown): Rec =>
  typeof v === "object" && v !== null ? (v as Rec) : {};
const asStr = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const asNum = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;

/** Vapi status-update statuses that are non-terminal handshakes (no dispatch). */
const HANDSHAKE_STATUSES = new Set([
  "queued",
  "in-progress",
  "forwarding",
  "ended", // the terminal outcome arrives via `end-of-call-report`, not here
]);

/**
 * Map a Vapi transcript role onto the neutral {@link VoiceTranscriptTurn} role.
 * Vapi uses "bot" for the assistant.
 */
function mapRole(role: string | undefined): VoiceTranscriptTurn["role"] {
  switch (role) {
    case "assistant":
    case "bot":
      return "agent";
    case "user":
      return "user";
    case "tool":
    case "function":
      return "tool";
    default:
      return "system";
  }
}

function mapTranscript(messages: unknown): VoiceTranscriptTurn[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  const turns: VoiceTranscriptTurn[] = [];
  for (const raw of messages) {
    const m = asRec(raw);
    const text = asStr(m.message) ?? asStr(m.content);
    if (text === undefined) continue;
    const at = asNum(m.secondsFromStart) ?? asNum(m.time);
    turns.push({
      role: mapRole(asStr(m.role)),
      text,
      ...(at !== undefined ? { at } : {}),
    });
  }
  return turns.length ? turns : undefined;
}

/**
 * Classify a Vapi `endedReason` into the terminal {@link VoiceEventType}. Normal
 * hangups → `call_ended`; the LLM/telephony faults → `failed`; the two call
 * outcomes worth their own event → `no_answer` / `voicemail`.
 */
function classifyEnded(reason: string): {
  type: VoiceEventType;
  failure?: VoiceFailureClass;
} {
  const r = reason.toLowerCase();
  if (r.includes("no-answer") || r.includes("did-not-answer")) {
    return { type: "voice.no_answer" };
  }
  if (r.includes("voicemail")) return { type: "voice.voicemail" };
  if (r.includes("error") || r.includes("pipeline") || r.includes("failed")) {
    return { type: "voice.failed", failure: "transient" };
  }
  if (r.includes("invalid") || r.includes("no-phone-number")) {
    return { type: "voice.failed", failure: "permanent" };
  }
  return { type: "voice.call_ended" };
}

/** Pull the callee/caller E.164 out of a Vapi message (several shapes). */
function extractPhone(message: Rec, call: Rec): string {
  return (
    asStr(asRec(message.customer).number) ??
    asStr(asRec(call.customer).number) ??
    ""
  );
}

/**
 * Normalize a Vapi server message (`payload.message`) into the provider-neutral
 * {@link VoiceWebhookParsed} — either a lifecycle {@link VoiceEvent} or a
 * synchronous {@link VoiceToolCall} request. Throws {@link WebhookHandshakeSignal}
 * for intermediate/unhandled messages the route should 200 without dispatch.
 */
export function toVoiceWebhook(message: Rec): VoiceWebhookParsed {
  const type = asStr(message.type);
  const call = asRec(message.call);
  const callId = asStr(call.id) ?? asStr(message.callId) ?? "";
  const occurredAt = asStr(message.timestamp) ?? new Date().toISOString();

  // --- Mid-call tool call (synchronous; the call blocks on our reply) --------
  if (type === "tool-calls") {
    const list = message.toolCallList;
    const calls: VoiceToolCall[] = [];
    if (Array.isArray(list)) {
      for (const raw of list) {
        const t = asRec(raw);
        const fn = asRec(t.function);
        const name = asStr(t.name) ?? asStr(fn.name);
        const id = asStr(t.id);
        if (!name || !id) continue;
        // Vapi's current server schema puts the model-produced arguments under
        // `parameters` (docs.vapi.ai/server-url/events). Keep `arguments` /
        // `function.arguments` as fallbacks for older/OpenAI-shaped payloads.
        const rawArgs = t.parameters ?? t.arguments ?? fn.arguments;
        const args =
          typeof rawArgs === "string"
            ? (JSON.parse(rawArgs) as Rec)
            : asRec(rawArgs);
        calls.push({ callId, toolCallId: id, name, args });
      }
    }
    if (!calls.length) {
      throw new WebhookHandshakeSignal("tool_calls_empty");
    }
    return { kind: "tool_call", calls };
  }

  // --- Status update ---------------------------------------------------------
  if (type === "status-update") {
    const status = asStr(message.status) ?? "";
    if (HANDSHAKE_STATUSES.has(status)) {
      throw new WebhookHandshakeSignal(`status:${status}`);
    }
    // "ringing" (and any first meaningful status) → call started.
    const event: VoiceEvent = {
      type: "voice.call_started",
      callId,
      phone: extractPhone(message, call),
      occurredAt,
      raw: message,
    };
    return { kind: "event", event };
  }

  // --- End-of-call report (the terminal outcome) -----------------------------
  if (type === "end-of-call-report") {
    const reason = asStr(message.endedReason) ?? "unknown";
    const { type: eventType, failure } = classifyEnded(reason);
    const artifact = asRec(message.artifact);
    const analysis = asRec(message.analysis);

    const durationSec =
      asNum(message.durationSeconds) ??
      (asNum(message.durationMs) !== undefined
        ? Math.round((asNum(message.durationMs) as number) / 1000)
        : undefined);
    const recordingUrl =
      asStr(message.recordingUrl) ??
      asStr(artifact.recordingUrl) ??
      asStr(asRec(artifact.recording).url);
    const summary = asStr(message.summary) ?? asStr(analysis.summary);
    const structuredData = analysis.structuredData;

    const outcome = {
      reason,
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(recordingUrl ? { recordingUrl } : {}),
      ...(mapTranscript(artifact.messages ?? message.messages)
        ? { transcript: mapTranscript(artifact.messages ?? message.messages) }
        : {}),
      ...(summary ? { summary } : {}),
      ...(structuredData !== undefined && structuredData !== null
        ? { structuredData: asRec(structuredData) }
        : {}),
      ...(asNum(message.cost) !== undefined
        ? { cost: asNum(message.cost) }
        : {}),
    };

    const event: VoiceEvent = {
      type: eventType,
      callId,
      phone: extractPhone(message, call),
      occurredAt,
      ended: outcome,
      ...(failure ? { failure: { class: failure, code: reason, reason } } : {}),
      ...(asStr(call.type) === "inboundPhoneCall"
        ? {
            inbound: {
              to:
                asStr(asRec(message.phoneNumber).number) ??
                asStr(asRec(call.phoneNumber).number) ??
                "",
            },
          }
        : {}),
      raw: message,
    };
    return { kind: "event", event };
  }

  // --- Inbound assistant request (synchronous; we pick the agent) ------------
  if (type === "assistant-request") {
    return {
      kind: "assistant_request",
      request: {
        callId,
        caller: extractPhone(message, call),
        called:
          asStr(asRec(message.phoneNumber).number) ??
          asStr(asRec(call.phoneNumber).number) ??
          "",
        raw: message,
      },
    };
  }

  throw new WebhookHandshakeSignal(`unhandled:${type ?? "unknown"}`);
}

/** Parse an unsigned Vapi webhook payload (trusted contexts/tests). */
export function parseWebhook(payload: string): VoiceWebhookParsed {
  const body = asRec(JSON.parse(payload));
  return toVoiceWebhook(asRec(body.message));
}

function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Verify a Vapi webhook, then normalize it. Vapi authenticates the server URL by
 * echoing a configured token — either the legacy `X-Vapi-Secret` header (no
 * prefix) OR the modern credential-based `Authorization: Bearer <token>`
 * (docs.vapi.ai/server-url/server-authentication).
 *
 * When NO secret is configured there is no token to compare against, so the
 * payload is ACCEPTED (parsed) rather than rejected — otherwise a basic setup
 * with only `VAPI_API_KEY` + `VAPI_PHONE_NUMBER_ID` would 401 every status, tool,
 * and outcome webhook. Operators who want fail-closed verification set
 * `VAPI_WEBHOOK_SECRET`; without it the endpoint should be secured by other
 * means (network/URL secrecy). `url` is part of the contract signature but
 * unused — Vapi does not sign the URL.
 */
export function verifyWebhook(opts: {
  payload: string;
  headers: Record<string, string>;
  url: string;
  secret?: string;
}): VoiceWebhookParsed {
  if (opts.secret) {
    const headerSecret =
      opts.headers["x-vapi-secret"] ?? opts.headers["X-Vapi-Secret"];
    const authz = opts.headers.authorization ?? opts.headers.Authorization;
    const bearer =
      authz && /^Bearer\s+/i.test(authz)
        ? authz.replace(/^Bearer\s+/i, "")
        : undefined;
    const provided = headerSecret ?? bearer;
    if (!provided) {
      throw new Error("Missing X-Vapi-Secret / Authorization header");
    }
    if (!secretsMatch(provided, opts.secret)) {
      throw new Error("Vapi webhook secret verification failed");
    }
  }
  return parseWebhook(opts.payload);
}

/**
 * Serialize tool results into Vapi's expected synchronous webhook response body.
 * Vapi blocks the call on this reply and reads `{ results: [{ toolCallId,
 * result }] }` — `result` must be a string.
 */
export function encodeToolResults(results: VoiceToolResult[]): {
  results: Array<{ toolCallId: string; result: string; name?: string }>;
} {
  return {
    results: results.map((r) => ({
      toolCallId: r.toolCallId,
      result: r.result,
      ...(r.name ? { name: r.name } : {}),
    })),
  };
}
