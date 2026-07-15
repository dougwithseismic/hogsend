import type { SmsTemplateName } from "@hogsend/sms";
import {
  deriveJourneyKey,
  getJourneyBoundary,
  registerKey,
} from "../journeys/journey-boundary.js";
import { createSingleton } from "./singleton.js";
import type { SmsService, SmsServiceSendOptions } from "./sms-service-types.js";

const _service = createSingleton<SmsService>("SMS service");

export const setSmsService = _service.set;

/**
 * The injected {@link SmsService} (set by `createHogsendClient` →
 * `setSmsService`). Exposed so module-level sites with no client reference reach
 * the container-built SMS sender. Throws if read before the container installs
 * it — the container always runs first. When no SMS provider is configured, the
 * installed service is a throwing stub whose `send` fails with an actionable
 * error.
 */
export const getSmsService = _service.get;

export interface SendSmsOptions {
  /** E.164 recipient. */
  to: string;
  userId: string;
  /**
   * The SMS template to send — typed against the consumer's augmented
   * `@hogsend/sms` `SmsTemplateRegistryMap` (`src/sms/templates.d.ts`). A key
   * that was never registered is a COMPILE error here.
   */
  template: SmsTemplateName;
  props?: Record<string, unknown>;
  journeyName?: string;
  journeyStateId?: string;
  /** Explicit idempotency key (a public caller); always wins over auto-derivation. */
  idempotencyKey?: string;
  /**
   * Disambiguates the exactly-once key when the SAME template is sent more than
   * once in one journey enrollment on divergent branches sharing a wait label.
   */
  idempotencyLabel?: string;
}

export interface SendSmsResult {
  smsSendId: string;
  /**
   * The pipeline verdict, passed through verbatim: `"sent"`, or a non-delivery
   * outcome — `"suppressed"` (STOP list), `"unsubscribed"`, `"no_consent"`
   * (explicit opt-in missing), `"skipped"` (frequency cap / journey suppress /
   * test mode; see `reason`). Journeys treating every outcome as success
   * should branch on this.
   */
  status: "sent" | "suppressed" | "unsubscribed" | "no_consent" | "skipped";
  /** Present when `status === "skipped"` — the skip reason. */
  reason?: string;
  /** Present only when `status === "sent"`. */
  sentAt?: string;
}

/**
 * The journey-facing SMS entry point — the SMS sibling of `sendEmail`. Derives a
 * deterministic, replay-stable idempotency key from the active journey boundary
 * (kind `smsSend`, a namespace DISJOINT from email's `send` so a `sendEmail` and
 * a `sendSms` of the same template under one wait label never collide), so a
 * durable replay re-firing the same logical send is absorbed by the unique
 * `sms_sends.idempotencyKey` index (Layer 2) and Hatchet's `memo` (Layer 1).
 */
export async function sendSms(opts: SendSmsOptions): Promise<SendSmsResult> {
  const boundary = getJourneyBoundary();
  let resolvedIdempotencyKey: string | undefined = opts.idempotencyKey;
  if (!resolvedIdempotencyKey && boundary) {
    const site =
      opts.idempotencyLabel ?? boundary.currentLabel ?? opts.template;
    resolvedIdempotencyKey = deriveJourneyKey({
      kind: "smsSend",
      anchor: boundary.runAnchor,
      site,
      discriminant: opts.template,
    });
    registerKey(boundary, resolvedIdempotencyKey);
  }

  const sendOptions = {
    template: opts.template,
    props: {
      ...opts.props,
      name:
        (opts.props?.firstName as string) ??
        (opts.props?.name as string) ??
        "there",
    },
    to: opts.to,
    userId: opts.userId,
    journeyStateId: opts.journeyStateId,
    idempotencyKey: resolvedIdempotencyKey,
    category: boundary?.category ?? "journey",
  } as unknown as SmsServiceSendOptions;

  const effect = {
    to: opts.to,
    userId: opts.userId,
    template: String(opts.template),
    props: sendOptions.props as Record<string, unknown>,
    category: boundary?.category ?? "journey",
    ...(opts.journeyName !== undefined
      ? { journeyName: opts.journeyName }
      : {}),
    ...(opts.journeyStateId !== undefined
      ? { journeyStateId: opts.journeyStateId }
      : {}),
    ...(resolvedIdempotencyKey
      ? { idempotencyKey: resolvedIdempotencyKey }
      : {}),
  };

  const doSend = async (): Promise<SendSmsResult> => {
    if (boundary?.services?.sms) {
      return boundary.services.sms(effect);
    }
    const service = getSmsService();
    const result = await service.send(sendOptions);
    return {
      smsSendId: result.smsSendId,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.status === "sent" ? { sentAt: new Date().toISOString() } : {}),
    };
  };

  if (boundary && resolvedIdempotencyKey) {
    return boundary.memoize([resolvedIdempotencyKey], doSend);
  }
  return doSend();
}
