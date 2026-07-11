import { randomBytes } from "node:crypto";
import { shouldSkipUrl } from "./tracking.js";

/**
 * SMS link shortening — the plain-text sibling of `rewriteLinks` (which is
 * HTML-anchor/email-only). `planSmsLinkRewrite` is PURE: it returns the
 * rewritten body plus the pending `tracked_links` rows; the caller inserts
 * them in the SAME transaction as the `sms_sends` row (the FK forces the
 * order, and the transaction closes both crash windows — no queued row ever
 * carries codes whose tracked rows are missing, and a short-code unique
 * collision rolls the whole attempt back for a clean replan).
 *
 * Why short links at all: a full `/v1/t/c/<uuid>` tracking URL eats a third
 * of a 160-char GSM-7 segment, and US carriers filter public shorteners —
 * first-party short codes on the operator's own domain are the practice.
 */

/**
 * Crockford-style base32 (no `i l o u`), all GSM-7 basic-set characters — a
 * code can never flip a message to UCS-2. 8 chars = 40 bits: birthday
 * collision odds reach 50% only around ~1.2M live codes; the insert-time
 * unique index + replan retry is a correctness backstop, not an expected path.
 */
export const SHORT_CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const SHORT_CODE_LENGTH = 8;

export function generateShortCode(): string {
  // 256 / 32 is exact, so byte % 32 carries no modulo bias.
  const bytes = randomBytes(SHORT_CODE_LENGTH);
  let out = "";
  for (const b of bytes) {
    out += SHORT_CODE_ALPHABET[b % SHORT_CODE_ALPHABET.length];
  }
  return out;
}

export interface PendingSmsLink {
  shortCode: string;
  originalUrl: string;
}

export interface SmsLinkRewritePlan {
  /** The body with every rewritable URL replaced by `${linkHost}/s/${code}`. */
  body: string;
  /** One entry per DISTINCT rewritten URL (occurrences share one code). */
  links: PendingSmsLink[];
}

const BARE_URL_RE = /https?:\/\/[^\s<>"']+/gi;

/** Trailing punctuation that reads as sentence punctuation, not URL. */
const TRAILING_PUNCT = new Set([".", ",", "!", "?", ";", ":", "'", '"']);

/**
 * Strip sentence punctuation from the end of a bare-URL match — the classic
 * bare-URL-regex bug ("Visit https://x.com/a." must not link the dot).
 * Closing brackets are stripped only when UNBALANCED within the URL, so
 * `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its paren while
 * `(see https://x.com)` loses it.
 */
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1] as string;
    if (TRAILING_PUNCT.has(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ")" || ch === "]") {
      const open = ch === ")" ? "(" : "[";
      const slice = url.slice(0, end);
      const opens = slice.split(open).length - 1;
      const closes = slice.split(ch).length - 1;
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/**
 * Pure rewrite pass over a rendered SMS body. Skips unsubscribe/preference
 * URLs (shared `shouldSkipUrl`) and the engine's OWN short/vanity/tracking
 * URLs (`/s/`, `/l/`, `/v1/t/` under `linkHost`) — a pasted tracked URL
 * already counts its click; wrapping it would add a hop and double-count.
 *
 * `generateCode` is injectable for deterministic tests.
 */
export function planSmsLinkRewrite(opts: {
  body: string;
  /** Full origin the short links are served from, no trailing slash. */
  linkHost: string;
  generateCode?: () => string;
}): SmsLinkRewritePlan {
  const { body, linkHost } = opts;
  const generate = opts.generateCode ?? generateShortCode;

  const byUrl = new Map<string, PendingSmsLink>();
  let out = "";
  let cursor = 0;

  for (const match of body.matchAll(BARE_URL_RE)) {
    const raw = match[0];
    const start = match.index;
    const url = trimTrailingPunctuation(raw);
    if (
      url.length === 0 ||
      shouldSkipUrl(url) ||
      url.startsWith(`${linkHost}/s/`) ||
      url.startsWith(`${linkHost}/l/`) ||
      url.startsWith(`${linkHost}/v1/t/`)
    ) {
      continue;
    }

    let pending = byUrl.get(url);
    if (!pending) {
      pending = { shortCode: generate(), originalUrl: url };
      byUrl.set(url, pending);
    }

    // Index-splice (never String.replace — URLs carry regex metachars and a
    // URL that prefixes another would mis-replace).
    out += body.slice(cursor, start);
    out += `${linkHost}/s/${pending.shortCode}`;
    cursor = start + url.length;
  }

  if (byUrl.size === 0) return { body, links: [] };
  out += body.slice(cursor);
  return { body: out, links: [...byUrl.values()] };
}

/**
 * True when `err` is the `tracked_links_short_code_unique` partial-unique
 * violation (an astronomically-rare 40-bit code collision). Walks the drizzle
 * cause chain for PG 23505, mirroring `isSlugUniqueViolation` in links.ts.
 */
export function isShortCodeCollision(err: unknown): boolean {
  let candidate: unknown = err;
  while (candidate && typeof candidate === "object") {
    const c = candidate as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      message?: string;
      cause?: unknown;
    };
    if (c.code === "23505") {
      const constraint = c.constraint_name ?? c.constraint ?? "";
      if (constraint.includes("tracked_links_short_code_unique")) return true;
      return (c.message ?? "").includes("tracked_links_short_code_unique");
    }
    candidate = c.cause;
  }
  return false;
}
