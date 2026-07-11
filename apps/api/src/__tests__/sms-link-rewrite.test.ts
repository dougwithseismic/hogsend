/**
 * Pure unit matrix for the SMS link rewriter (`planSmsLinkRewrite`) — no DB,
 * no mocks. Pins the bare-URL extraction rules (trailing punctuation,
 * balanced brackets), dedupe-to-one-code, the skip set (unsubscribe/
 * preference URLs + the engine's own tracking URLs), and the GSM-7 segment
 * saving that motivates the whole feature.
 */

import {
  generateShortCode,
  planSmsLinkRewrite,
  SHORT_CODE_LENGTH,
} from "@hogsend/engine";
import { countSmsSegments } from "@hogsend/sms";
import { describe, expect, it } from "vitest";

const HOST = "https://api.example.com";

/** Deterministic code source: c0000001, c0000002, … */
function codes(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `c${String(n).padStart(SHORT_CODE_LENGTH - 1, "0")}`;
  };
}

describe("planSmsLinkRewrite", () => {
  it("rewrites a single URL to host/s/<code>", () => {
    const plan = planSmsLinkRewrite({
      body: "Check out https://example.com/sale now",
      linkHost: HOST,
      generateCode: codes(),
    });
    expect(plan.body).toBe(`Check out ${HOST}/s/c0000001 now`);
    expect(plan.links).toEqual([
      { shortCode: "c0000001", originalUrl: "https://example.com/sale" },
    ]);
  });

  it("does not swallow trailing sentence punctuation", () => {
    const g = codes();
    for (const [body, expected] of [
      ["Visit https://x.com/a.", `Visit ${HOST}/s/c0000001.`],
      ["See https://x.com/a, then reply", `See ${HOST}/s/c0000002, then reply`],
      ["(details: https://x.com/a)", `(details: ${HOST}/s/c0000003)`],
      ["Really? https://x.com/a?b=c!", `Really? ${HOST}/s/c0000004!`],
    ] as const) {
      const plan = planSmsLinkRewrite({
        body,
        linkHost: HOST,
        generateCode: g,
      });
      expect(plan.body).toBe(expected);
      expect(plan.links.at(-1)?.originalUrl).toMatch(/^https:\/\/x\.com\/a/);
      expect(plan.links.at(-1)?.originalUrl).not.toMatch(/[.,!)]$/);
    }
  });

  it("keeps a balanced closing paren inside the URL", () => {
    const plan = planSmsLinkRewrite({
      body: "Read https://en.wikipedia.org/wiki/Foo_(bar) tonight",
      linkHost: HOST,
      generateCode: codes(),
    });
    expect(plan.links[0]?.originalUrl).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
  });

  it("dedupes identical URLs to one code; distinct URLs get distinct codes", () => {
    const plan = planSmsLinkRewrite({
      body: "A https://a.com B https://b.com again https://a.com",
      linkHost: HOST,
      generateCode: codes(),
    });
    expect(plan.links).toHaveLength(2);
    const occurrences = plan.body.match(/\/s\/c0000001/g) ?? [];
    expect(occurrences).toHaveLength(2);
    expect(plan.body).toContain("/s/c0000002");
  });

  it("skips unsubscribe/preference URLs and the engine's own tracking URLs", () => {
    const body = [
      `Unsub: ${HOST}/v1/email/unsubscribe?token=t`,
      `Prefs: ${HOST}/v1/email/preferences?token=t`,
      `Vanity: ${HOST}/l/black-friday`,
      `Short: ${HOST}/s/abcd1234`,
      `Tracked: ${HOST}/v1/t/c/123`,
    ].join(" ");
    const plan = planSmsLinkRewrite({
      body,
      linkHost: HOST,
      generateCode: codes(),
    });
    expect(plan.links).toHaveLength(0);
    expect(plan.body).toBe(body);
  });

  it("returns the body identically when no URL matches; bare www. is not a URL", () => {
    const body = "Plain text with www.example.com and no scheme";
    const plan = planSmsLinkRewrite({
      body,
      linkHost: HOST,
      generateCode: codes(),
    });
    expect(plan.body).toBe(body);
    expect(plan.links).toHaveLength(0);
  });

  it("matches http:// as well as https://", () => {
    const plan = planSmsLinkRewrite({
      body: "Legacy http://old.example.com/x",
      linkHost: HOST,
      generateCode: codes(),
    });
    expect(plan.links[0]?.originalUrl).toBe("http://old.example.com/x");
  });

  it("default generateShortCode emits 8-char lowercase base32 (no i l o u)", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateShortCode()).toMatch(
        /^[0123456789abcdefghjkmnpqrstvwxyz]{8}$/,
      );
    }
  });

  it("strictly reduces the GSM segment count for a long-URL message", () => {
    const url = `https://example.com/some/deep/path?utm_source=sms&utm_campaign=${"x".repeat(30)}`;
    const body = `${"Your weekly growth digest is ready — read it here: ".padEnd(110, "!")} ${url}`;
    const before = countSmsSegments(body).segments;
    const plan = planSmsLinkRewrite({
      body,
      linkHost: HOST,
      generateCode: codes(),
    });
    const after = countSmsSegments(plan.body).segments;
    expect(after).toBeLessThan(before);
  });
});
