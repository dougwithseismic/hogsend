import { randomUUID } from "node:crypto";
import { RESERVED_EVENT_NAME_RE } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { trackedLinks } from "@hogsend/db";
import {
  EMAIL_ACTION_EVENT_ATTR,
  EMAIL_ACTION_PROPS_ATTR,
  HOSTED_ANSWER_HREF,
} from "@hogsend/email";

const ANCHOR_RE = /<a\b[^>]*>/gi;
const HREF_RE = /\bhref="(https?:\/\/[^"]+)"/i;
const SENTINEL_HREF_RE = new RegExp(`\\bhref="${HOSTED_ANSWER_HREF}"`, "i");
const EVENT_ATTR_RE = new RegExp(
  `\\b${EMAIL_ACTION_EVENT_ATTR}="([^"]*)"`,
  "i",
);
const PROPS_ATTR_RE = new RegExp(
  `\\b${EMAIL_ACTION_PROPS_ATTR}="([^"]*)"`,
  "i",
);
const STRIP_SEMANTIC_ATTRS_RE = new RegExp(
  `\\s*(?:${EMAIL_ACTION_EVENT_ATTR}|${EMAIL_ACTION_PROPS_ATTR})="[^"]*"`,
  "gi",
);

const SKIP_PATTERNS = ["/v1/email/unsubscribe", "/v1/email/preferences"];

// Semantic payloads re-emit on every answer and persist indefinitely — keep
// them small and scalar (non-scalars don't survive the Hatchet wire anyway).
const MAX_PROPS_JSON_LENGTH = 2048;

/** Never rewrite unsubscribe/preference URLs (shared with the SMS rewriter). */
export function shouldSkipUrl(url: string): boolean {
  return SKIP_PATTERNS.some((pattern) => url.includes(pattern));
}

// React entity-escapes attribute values at render time. Decode the five
// entities it emits; `&amp;` LAST so `&amp;quot;` round-trips to `&quot;`.
function decodeAttributeValue(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

interface SemanticAttrs {
  event: string;
  /** Raw (encoded) props attribute — part of the dedupe key. */
  propsRaw: string | null;
  properties: Record<string, unknown> | null;
}

/**
 * Extract + validate the semantic metadata off one `<a …>` tag. Returns null
 * for a plain link. Throws on author error — a semantic link that can't be
 * honored must fail the SEND loudly, not degrade into a silent plain link.
 */
function parseSemanticAttrs(tag: string): SemanticAttrs | null {
  const eventMatch = tag.match(EVENT_ATTR_RE);
  if (!eventMatch) return null;

  const event = decodeAttributeValue(eventMatch[1] ?? "").trim();
  if (!event) {
    throw new Error(`Semantic link has an empty ${EMAIL_ACTION_EVENT_ATTR}`);
  }
  if (RESERVED_EVENT_NAME_RE.test(event)) {
    throw new Error(
      `Semantic link event "${event}" uses a reserved namespace (email/journey/bucket/contact)`,
    );
  }

  const propsMatch = tag.match(PROPS_ATTR_RE);
  if (!propsMatch) return { event, propsRaw: null, properties: null };

  const propsRaw = propsMatch[1] ?? "";
  const decoded = decodeAttributeValue(propsRaw);
  if (decoded.length > MAX_PROPS_JSON_LENGTH) {
    throw new Error(
      `Semantic link "${event}" properties exceed ${MAX_PROPS_JSON_LENGTH} chars`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error(
      `Semantic link "${event}" has unparseable ${EMAIL_ACTION_PROPS_ATTR}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Semantic link "${event}" properties must be a JSON object`,
    );
  }
  for (const [key, value] of Object.entries(parsed)) {
    const t = typeof value;
    if (value !== null && t !== "string" && t !== "number" && t !== "boolean") {
      throw new Error(
        `Semantic link "${event}" property "${key}" must be a scalar (string/number/boolean/null)`,
      );
    }
  }

  return {
    event,
    propsRaw,
    properties: parsed as Record<string, unknown>,
  };
}

// One tracked_links row per distinct (url, event, props) tuple: identical
// semantic links share a row; the same URL under DIFFERENT events/props must
// NOT collapse (the old URL-only dedupe would merge "yes" and "no" answers
// that point at the same thanks page).
function linkKey(url: string, semantic: SemanticAttrs | null): string {
  const sep = String.fromCharCode(0);
  return [url, semantic?.event ?? "", semantic?.propsRaw ?? ""].join(sep);
}

export async function rewriteLinks(opts: {
  html: string;
  emailSendId: string;
  baseUrl: string;
  db: Database;
}): Promise<string> {
  const { html, emailSendId, baseUrl, db } = opts;

  const pending = new Map<
    string,
    { id: string; url: string; semantic: SemanticAttrs | null }
  >();

  for (const match of html.matchAll(ANCHOR_RE)) {
    const tag = match[0];
    const semantic = parseSemanticAttrs(tag);

    // Sentinel destination: the engine-hosted answer page. Only meaningful on
    // a semantic link, and resolvable only here (the page URL embeds the
    // tracked link's own id, generated client-side below).
    if (SENTINEL_HREF_RE.test(tag)) {
      if (!semantic) {
        throw new Error(
          `href="${HOSTED_ANSWER_HREF}" is only valid on a semantic link (EmailAction)`,
        );
      }
      const key = linkKey(HOSTED_ANSWER_HREF, semantic);
      if (!pending.has(key)) {
        const id = randomUUID();
        pending.set(key, {
          id,
          url: `${baseUrl}/v1/t/a/${id}`,
          semantic,
        });
      }
      continue;
    }

    const url = tag.match(HREF_RE)?.[1];
    if (!url || shouldSkipUrl(url)) {
      if (semantic) {
        throw new Error(
          `Semantic link "${semantic.event}" needs an absolute http(s) href outside unsubscribe/preference URLs`,
        );
      }
      continue;
    }

    const key = linkKey(url, semantic);
    if (!pending.has(key)) {
      pending.set(key, { id: randomUUID(), url, semantic });
    }
  }

  if (pending.size === 0) return html;

  await db.insert(trackedLinks).values(
    [...pending.values()].map((link) => ({
      id: link.id,
      emailSendId,
      originalUrl: link.url,
      event: link.semantic?.event,
      eventProperties: link.semantic?.properties ?? undefined,
    })),
  );

  return html.replace(ANCHOR_RE, (tag) => {
    if (SENTINEL_HREF_RE.test(tag)) {
      const link = pending.get(
        linkKey(HOSTED_ANSWER_HREF, parseSemanticAttrs(tag)),
      );
      if (!link) return tag;
      return tag
        .replace(SENTINEL_HREF_RE, `href="${baseUrl}/v1/t/c/${link.id}"`)
        .replace(STRIP_SEMANTIC_ATTRS_RE, "");
    }
    const url = tag.match(HREF_RE)?.[1];
    if (!url || shouldSkipUrl(url)) return tag;
    const link = pending.get(linkKey(url, parseSemanticAttrs(tag)));
    if (!link) return tag;
    return tag
      .replace(HREF_RE, `href="${baseUrl}/v1/t/c/${link.id}"`)
      .replace(STRIP_SEMANTIC_ATTRS_RE, "");
  });
}

export function injectOpenPixel(opts: {
  html: string;
  emailSendId: string;
  baseUrl: string;
}): string {
  const { html, emailSendId, baseUrl } = opts;
  const pixel = `<img src="${baseUrl}/v1/t/o/${emailSendId}" width="1" height="1" alt="" style="display:none" />`;

  const bodyCloseIdx = html.lastIndexOf("</body>");
  if (bodyCloseIdx !== -1) {
    return html.slice(0, bodyCloseIdx) + pixel + html.slice(bodyCloseIdx);
  }

  return html + pixel;
}

export async function prepareTrackedHtml(opts: {
  html: string;
  emailSendId: string;
  baseUrl: string;
  db: Database;
}): Promise<string> {
  let result = await rewriteLinks(opts);
  result = injectOpenPixel({
    html: result,
    emailSendId: opts.emailSendId,
    baseUrl: opts.baseUrl,
  });
  return result;
}

/**
 * The mint surface for a NON-email tracked link (Discord, referral, ad-hoc).
 * Inserts a `tracked_links` row with a NULL `emailSendId` and returns the
 * `/v1/t/c/:id` redirect URL to use in place of the raw destination.
 *
 * This is the SINGLE chokepoint enforcing "broadcast links carry no subject":
 * a link only becomes identity-bearing when the caller EXPLICITLY passes
 * `distinctId` (the canonical contact key the click should stitch into). Per
 * MF-4, the referral path does NOT pass `distinctId` by default (referral
 * pages are shareable → broadcast), and the Discord destination passes
 * `distinctId: undefined`. The `hs_t` mint at click time is still gated by
 * `TRACKING_IDENTITY_TOKEN` (default false); a row with a NULL `distinctId`
 * never mints a token regardless.
 */
export async function createTrackedLink(opts: {
  db: Database;
  url: string;
  /**
   * The canonical contact key a click should fold the visitor's anon session
   * into. OMIT for a broadcast link (the safe default) — only an explicit,
   * single-subject, non-shareable link should pass this.
   */
  distinctId?: string;
  source: "discord" | "referral" | "link";
  baseUrl: string;
}): Promise<string> {
  const id = randomUUID();
  await opts.db.insert(trackedLinks).values({
    id,
    emailSendId: null,
    distinctId: opts.distinctId ?? null,
    source: opts.source,
    originalUrl: opts.url,
  });
  return `${opts.baseUrl}/v1/t/c/${id}`;
}
