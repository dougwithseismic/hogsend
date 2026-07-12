import type { z } from "zod";
import type { IngestEvent } from "../lib/ingestion.js";
import {
  type DefinedWebhookSource,
  defineWebhookSource,
  type WebhookSourceAuth,
  type WebhookSourceCtx,
} from "../webhook-sources/define-webhook-source.js";

/**
 * A CONTACT SOURCE is an origin of *sourced* contacts — Clay, Attio, a generic
 * webhook, any CRM/enrichment tool. It is thin sugar over
 * {@link defineWebhookSource}: the same inbound `transform` (raw payload →
 * {@link IngestEvent}) served on the existing `POST /v1/webhooks/:sourceId`
 * route, PLUS three things a plain webhook source has no opinion on:
 *
 *  1. **Provenance is automatic.** The webhook route ingests with
 *     `source = meta.id`, and the engine stamps that onto `contacts.source` on
 *     create (first-touch). So a source `id: "clay"` mints contacts with
 *     `source: "clay"` — a cold **prospect** — with NO extra wiring. Registering
 *     the id in the {@link ContactSourceRegistry} is what lets the rest of the
 *     engine *classify* such a contact as a prospect.
 *  2. **A cold-consent posture** ({@link ColdPosture}) — which channels a cold,
 *     no-consent contact may receive before they opt in. Legal-safe default:
 *     email `allow`, every other channel `block`. This is the deliberate,
 *     per-source "unflick" knob (see `docs/.../consent-and-legal.md`).
 *  3. **An optional {@link ContactWriteBack}** — pushing journey/engagement
 *     status back to the source CRM (implemented per-source; e.g. Attio).
 *
 * A contact source is NOT a new ingestion surface — {@link contactSourceToWebhookSource}
 * lifts it back onto the webhook-source umbrella for the container/route to
 * register, so it rides the exact battle-tested path every webhook source uses.
 */
export type ColdChannelPosture = "allow" | "block";

/**
 * Per-channel cold posture. Keys are channel ids (`"email"`, `"sms"`, a
 * connector id like `"discord"`). Any channel not named defaults to `block`,
 * EXCEPT `email`, which defaults to `allow` (cold email is lawful with
 * identification + unsubscribe, which the mailer already provides). Opening a
 * non-email channel to `"allow"` for cold contacts is a deliberate, auditable
 * act — see {@link resolveColdPosture} / {@link isColdChannelAllowed}.
 */
export type ColdPosture = Record<string, ColdChannelPosture>;

/**
 * The legal-safe default posture applied when a source declares none: cold
 * email allowed, everything else blocked. Kept as a function (not a shared
 * object) so callers can never mutate a shared default.
 */
export function defaultColdPosture(): ColdPosture {
  return { email: "allow" };
}

/**
 * Merge a source's declared posture over the safe default. `email` stays
 * `allow` unless the source explicitly blocks it; every other channel stays
 * `block` unless the source explicitly allows it.
 */
export function resolveColdPosture(declared?: ColdPosture): ColdPosture {
  return { ...defaultColdPosture(), ...(declared ?? {}) };
}

/**
 * Is `channelId` deliverable to a COLD (sourced, no-consent) contact under this
 * posture? `email` → allowed unless explicitly blocked; any other channel →
 * blocked unless explicitly allowed. This is the single source of truth the
 * cold gate consults, so the default is fail-closed for everything but email.
 */
export function isColdChannelAllowed(
  posture: ColdPosture,
  channelId: string,
): boolean {
  if (channelId === "email") return (posture.email ?? "allow") === "allow";
  return posture[channelId] === "allow";
}

export interface ContactSourceMeta {
  id: string;
  name: string;
  description?: string;
}

/**
 * Optional per-source write-back — push engagement/lifecycle status from a
 * journey milestone back to the origin CRM. Best-effort and provider-specific
 * (e.g. Attio's `PUT /v2/objects/people/records` + a note). Implemented in the
 * source-adapter phases; declared here so the primitive owns the contract.
 */
export interface ContactWriteBack {
  syncStatus(args: {
    /** The contact's email (the cross-system business key), if known. */
    email: string | null;
    /** The contact's external id, if known. */
    externalId: string | null;
    /** A short lifecycle status ("emailed", "replied", "opted_in", …). */
    status: string;
    /** Optional structured attributes to upsert on the CRM record. */
    properties?: Record<string, unknown>;
  }): Promise<void>;
}

export interface DefinedContactSource<T = unknown> {
  meta: ContactSourceMeta;
  /** Inbound-request verification — identical shape to a webhook source. */
  auth: WebhookSourceAuth;
  /** Optional Zod schema validating the payload BEFORE transform. */
  schema?: z.ZodSchema<T>;
  /** Raw CRM/enrichment payload → a sourcing {@link IngestEvent} (or null). */
  transform(payload: T, ctx: WebhookSourceCtx): Promise<IngestEvent | null>;
  /** RESOLVED cold posture (safe defaults already merged in). */
  coldPosture: ColdPosture;
  /** Optional write-back adapter. */
  writeBack?: ContactWriteBack;
}

/**
 * Author a contact source. Identity/validating function (mirrors
 * {@link defineWebhookSource}) that additionally resolves the cold posture to
 * its safe-default-merged form so downstream reads never re-derive it.
 */
export function defineContactSource<T>(def: {
  meta: ContactSourceMeta;
  auth: WebhookSourceAuth;
  schema?: z.ZodSchema<T>;
  transform(payload: T, ctx: WebhookSourceCtx): Promise<IngestEvent | null>;
  coldPosture?: ColdPosture;
  writeBack?: ContactWriteBack;
}): DefinedContactSource<T> {
  if (!def.meta.id) {
    throw new Error("defineContactSource: meta.id is required");
  }
  return {
    meta: def.meta,
    auth: def.auth,
    schema: def.schema,
    transform: def.transform,
    coldPosture: resolveColdPosture(def.coldPosture),
    writeBack: def.writeBack,
  };
}

/**
 * Lift a contact source back onto the {@link DefinedWebhookSource} umbrella so
 * the container/route can register it exactly like any webhook source (it rides
 * the `POST /v1/webhooks/:sourceId` path, and the route stamps `source = id`,
 * giving provenance for free). The cold posture / write-back live only on the
 * {@link ContactSourceRegistry}; the webhook path needs neither.
 */
export function contactSourceToWebhookSource<T>(
  source: DefinedContactSource<T>,
): DefinedWebhookSource<T> {
  return defineWebhookSource<T>({
    meta: source.meta,
    auth: source.auth,
    schema: source.schema,
    transform: source.transform,
  });
}
