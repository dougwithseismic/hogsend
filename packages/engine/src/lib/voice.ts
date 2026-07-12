import type { VoiceAgentName, VoiceAgentRegistryMap } from "@hogsend/voice";
import {
  deriveJourneyKey,
  getJourneyBoundary,
  registerKey,
} from "../journeys/journey-boundary.js";
import { createSingleton } from "./singleton.js";
import type {
  StartTrackedCallOptions,
  VoiceService,
} from "./voice-service-types.js";

const _service = createSingleton<VoiceService>("Voice service");

export const setVoiceService = _service.set;

/**
 * The injected {@link VoiceService} (set by `createHogsendClient` →
 * `setVoiceService`). Exposed so module-level sites with no client reference
 * reach the container-built voice caller. Throws if read before the container
 * installs it. When no voice provider is configured, the installed service is a
 * throwing stub whose `startCall` fails with an actionable error.
 */
export const getVoiceService = _service.get;

export interface StartCallOptions<K extends VoiceAgentName = VoiceAgentName> {
  /** E.164 callee. */
  to: string;
  userId: string;
  /**
   * The voice agent to run — typed against the consumer's augmented
   * `@hogsend/voice` `VoiceAgentRegistryMap` (`src/voice/templates.d.ts`). A key
   * that was never registered is a COMPILE error here.
   */
  agent: K;
  props: VoiceAgentRegistryMap[K];
  /** Values for `{{variable}}` placeholders in the agent's prompts. */
  variables?: Record<string, string | number | boolean>;
  from?: string;
  journeyName?: string;
  journeyStateId?: string;
  /** Explicit idempotency key (a public caller); always wins over auto-derivation. */
  idempotencyKey?: string;
  /**
   * Disambiguates the exactly-once key when the SAME agent is called more than
   * once in one journey enrollment on divergent branches sharing a wait label.
   */
  idempotencyLabel?: string;
}

export interface StartCallResult {
  voiceCallId: string;
  providerCallId: string;
  /**
   * The pipeline verdict, passed through verbatim: `"started"`, or a non-connect
   * outcome — `"suppressed"` (DNC), `"unsubscribed"`, `"no_consent"` (explicit
   * voice consent missing), `"skipped"` (frequency cap / journey suppress /
   * quiet hours / test mode; see `reason`).
   */
  status: "started" | "suppressed" | "unsubscribed" | "no_consent" | "skipped";
  reason?: string;
}

/**
 * The journey-facing voice entry point — the voice sibling of `sendEmail` /
 * `sendSms`. Derives a deterministic, replay-stable idempotency key from the
 * active journey boundary (kind `voiceCall`, a namespace DISJOINT from email's
 * `send` and SMS's `smsSend`), so a durable replay re-firing the same logical
 * call is absorbed by the unique `voice_calls.idempotencyKey` index (Layer 2)
 * and Hatchet's `memo` (Layer 1) — a call is never double-dialed on replay.
 */
export async function startCall<K extends VoiceAgentName>(
  opts: StartCallOptions<K>,
): Promise<StartCallResult> {
  const service = getVoiceService();

  const boundary = getJourneyBoundary();
  let resolvedIdempotencyKey: string | undefined = opts.idempotencyKey;
  if (!resolvedIdempotencyKey && boundary) {
    const site = opts.idempotencyLabel ?? boundary.currentLabel ?? opts.agent;
    resolvedIdempotencyKey = deriveJourneyKey({
      kind: "voiceCall",
      anchor: boundary.runAnchor,
      site,
      discriminant: opts.agent,
    });
    registerKey(boundary, resolvedIdempotencyKey);
  }

  const startOptions: StartTrackedCallOptions<K> = {
    agentKey: opts.agent,
    props: opts.props,
    to: opts.to,
    userId: opts.userId,
    ...(opts.from ? { from: opts.from } : {}),
    ...(opts.variables ? { variables: opts.variables } : {}),
    ...(opts.journeyStateId ? { journeyStateId: opts.journeyStateId } : {}),
    ...(resolvedIdempotencyKey
      ? { idempotencyKey: resolvedIdempotencyKey }
      : {}),
    ...(boundary?.category ? { category: boundary.category } : {}),
  };

  const doStart = async (): Promise<StartCallResult> => {
    const result = await service.startCall(startOptions);
    return {
      voiceCallId: result.voiceCallId,
      providerCallId: result.providerCallId,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  };

  if (boundary && resolvedIdempotencyKey) {
    return boundary.memoize([resolvedIdempotencyKey], doStart);
  }
  return doStart();
}
