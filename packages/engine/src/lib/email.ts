import { generateUnsubscribeUrl, type TemplateName } from "@hogsend/email";
import {
  deriveJourneyKey,
  getJourneyBoundary,
  registerKey,
} from "../journeys/journey-boundary.js";
import type {
  EmailService,
  EmailServiceSendOptions,
} from "./email-service-types.js";
import { createSingleton } from "./singleton.js";

const _service = createSingleton<EmailService>("Email service");

export const setEmailService = _service.set;

/**
 * The injected {@link EmailService} (set by `createHogsendClient` →
 * `setEmailService`). Exposed so module-level task-execution sites with no
 * client reference (the `send-email` Hatchet task, the alerting task) deliver
 * through the same provider-backed mailer the container built, honoring a
 * swapped provider instead of constructing a raw Resend client of their own.
 * Throws if read before the container has installed the service — same
 * guarantee as the journey/bucket registry singletons (the container always
 * runs first in both the API and worker processes).
 */
export const getEmailService = _service.get;

export interface SendEmailOptions {
  to: string;
  userId: string;
  /**
   * The template to send. Typed as {@link TemplateName} — the union of keys the
   * consumer has registered by augmenting `@hogsend/email`'s
   * `TemplateRegistryMap` (see the consumer's `src/emails/templates.d.ts`). A
   * key that was never registered (a typo, or a slash-key when the registry
   * uses hyphen-keys) is a COMPILE error here, so a journey can no longer ship
   * pointing at an email that doesn't exist. `getTemplate` also throws a loud,
   * actionable error at send time as a runtime backstop for keys resolved
   * dynamically (e.g. the public `POST /v1/emails`).
   */
  template: TemplateName;
  /**
   * The email subject. Optional: when omitted, the tracked mailer falls back
   * to the template registry's `defaultSubject` for {@link template} (the
   * blueprint interpreter's send nodes rely on this — a blueprint send node
   * carries only a template key). Code journeys typically pass it explicitly.
   */
  subject?: string;
  journeyName?: string;
  journeyStateId?: string;
  props?: Record<string, unknown>;
  /**
   * Explicit idempotency key. A public caller (e.g. POST /v1/emails) sets this
   * directly; it always wins over the engine's auto-derivation. Journey sends
   * leave it unset — the engine derives a deterministic key from the active
   * journey boundary (see {@link idempotencyLabel}).
   */
  idempotencyKey?: string;
  /**
   * Disambiguates a send's exactly-once idempotency key when the SAME template
   * is sent more than once in one journey enrollment on divergent branches.
   * Normally the engine auto-derives the key from the nearest authored wait
   * label, so this is rarely needed; pass a distinct label per call if the
   * engine throws an intra-run key-collision error. Additive and optional.
   */
  idempotencyLabel?: string;
}

export interface SendEmailResult {
  emailSendId: string;
  sentAt: string;
}

export async function sendEmail(
  opts: SendEmailOptions,
): Promise<SendEmailResult> {
  const service = getEmailService();

  // Exactly-once across a durable replay. When inside a journey run, derive a
  // deterministic, branch-stable key (anchored on the replay-stable
  // `boundary.runAnchor` = Hatchet run id, NOT the freshly-minted stateId) so a
  // replay re-firing the same logical send re-derives the SAME key and the unique
  // `email_sends.idempotencyKey` index absorbs the duplicate provider call
  // (Layer 2 — version-independent). The boundary's nearest authored wait label
  // is the "site" discriminant, so two sends of the SAME template on different
  // branches derive distinct keys for free. An explicit key (public callers)
  // always wins; outside a journey (admin bulk / POST /v1/emails) the key is
  // whatever the caller passed (NULL for journey-less sends — Postgres treats
  // NULLs as distinct, so unchanged).
  const boundary = getJourneyBoundary();
  let resolvedIdempotencyKey: string | undefined = opts.idempotencyKey;
  if (!resolvedIdempotencyKey && boundary) {
    const site =
      opts.idempotencyLabel ?? boundary.currentLabel ?? opts.template;
    resolvedIdempotencyKey = deriveJourneyKey({
      kind: "send",
      anchor: boundary.runAnchor,
      site,
      discriminant: opts.template,
    });
    registerKey(boundary, resolvedIdempotencyKey);
  }

  let unsubscribeUrl: string | undefined;
  if (process.env.API_PUBLIC_URL && process.env.BETTER_AUTH_SECRET) {
    unsubscribeUrl = generateUnsubscribeUrl({
      baseUrl: process.env.API_PUBLIC_URL,
      secret: process.env.BETTER_AUTH_SECRET,
      externalId: opts.userId,
      email: opts.to,
    });
  }

  const headers: Record<string, string> = {};
  if (unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  // `sendEmail` is the journey entry point: the template key is typed against
  // the registry (see `SendEmailOptions.template`), but `props` stay loose here
  // (the helper injects `name`/`journeyName`/`body`/… below), so we build the
  // options untyped and hand them to the typed `service.send`. Fully type-safe
  // call sites use `container.emailService.send({ template, props })` directly.
  const sendOptions = {
    template: opts.template,
    props: {
      ...opts.props,
      name:
        (opts.props?.firstName as string) ??
        (opts.props?.name as string) ??
        opts.to.split("@")[0] ??
        "there",
      journeyName: opts.journeyName ?? opts.template,
      eventName: opts.template,
      body: opts.subject,
      unsubscribeUrl,
    },
    to: opts.to,
    subject: opts.subject,
    journeyStateId: opts.journeyStateId,
    idempotencyKey: resolvedIdempotencyKey,
    userId: opts.userId,
    userEmail: opts.to,
    // A journey may stamp its own email-preference category (`meta.category`,
    // threaded onto the boundary) — it overrides the template's own category at
    // send time exactly as this hardcoded `"journey"` default did. Outside a
    // journey there is no boundary, so this stays the built-in `journey`
    // category, unchanged.
    category: boundary?.category ?? "journey",
    tags: [
      { name: "journeyId", value: opts.journeyName ?? opts.template },
      { name: "templateKey", value: opts.template },
      { name: "userId", value: opts.userId },
    ],
    headers,
  } as unknown as EmailServiceSendOptions;

  // Layer 1 (fast path): when inside a journey on an eviction-capable engine,
  // run the provider send through Hatchet's durable `memo` so a replay returns
  // the recorded `{ emailSendId, sentAt }` WITHOUT re-hitting the provider or
  // the DB. JSON-safe (both fields are strings). Degrades to a bare send when
  // eviction is unavailable — Layer 2 (the DB key above) still guarantees
  // exactly-once. Outside a journey, send directly (no boundary).
  const doSend = async (): Promise<SendEmailResult> => {
    const result = await service.send(sendOptions);
    return {
      emailSendId: result.emailSendId,
      sentAt: new Date().toISOString(),
    };
  };

  if (boundary && resolvedIdempotencyKey) {
    return boundary.memoize([resolvedIdempotencyKey], doSend);
  }
  return doSend();
}
