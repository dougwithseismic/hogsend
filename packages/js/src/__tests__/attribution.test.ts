import { describe, expect, it } from "vitest";
import {
  arrivalSignature,
  buildAttributionFields,
  parseAttribution,
  toArrivalProperties,
} from "../attribution/index.js";

const HREF =
  "https://example.com/solar/quote?fbclid=AbCd123&utm_source=facebook&utm_medium=paid&utm_campaign=spring&gclid=&irrelevant=1";

describe("parseAttribution", () => {
  it("captures allowlisted click IDs and utm_* params; drops the query from landingPage", () => {
    const parsed = parseAttribution(HREF, "https://m.facebook.com/");
    expect(parsed).toEqual({
      clickIds: { fbclid: "AbCd123" },
      utm: {
        utm_source: "facebook",
        utm_medium: "paid",
        utm_campaign: "spring",
      },
      landingPage: "https://example.com/solar/quote",
      referrer: "https://m.facebook.com/",
    });
  });

  it("returns null on a non-campaign pageload", () => {
    expect(parseAttribution("https://example.com/?ref=nav", "")).toBeNull();
    expect(parseAttribution("not a url", "")).toBeNull();
  });

  it("captures a utm-only landing (no click ID)", () => {
    const parsed = parseAttribution(
      "https://example.com/?utm_source=newsletter",
      "",
    );
    expect(parsed?.clickIds).toEqual({});
    expect(parsed?.utm).toEqual({ utm_source: "newsletter" });
  });

  it("captures every allowlisted platform click ID", () => {
    const parsed = parseAttribution(
      "https://x.com/?fbclid=f&gclid=g&gbraid=gb&wbraid=wb&ttclid=t&msclkid=m&li_fat_id=l&twclid=tw&rdt_cid=r&epik=e&sccid=s",
      "",
    );
    expect(Object.keys(parsed?.clickIds ?? {})).toHaveLength(11);
  });
});

describe("toArrivalProperties", () => {
  it("flattens to scalars (journeys/Hatchet only see scalar properties)", () => {
    const parsed = parseAttribution(HREF, "https://m.facebook.com/");
    expect(parsed && toArrivalProperties(parsed)).toEqual({
      fbclid: "AbCd123",
      utm_source: "facebook",
      utm_medium: "paid",
      utm_campaign: "spring",
      landing_page: "https://example.com/solar/quote",
      referrer: "https://m.facebook.com/",
    });
  });
});

describe("arrivalSignature", () => {
  it("is stable across param order and distinct across param values", () => {
    const a = parseAttribution("https://x.com/p?fbclid=1&utm_source=fb", "");
    const b = parseAttribution("https://x.com/p?utm_source=fb&fbclid=1", "");
    const c = parseAttribution("https://x.com/p?utm_source=fb&fbclid=2", "");
    expect(a && arrivalSignature(a)).toBe(b && arrivalSignature(b));
    expect(a && arrivalSignature(a)).not.toBe(c && arrivalSignature(c));
  });
});

describe("buildAttributionFields", () => {
  it("returns the anon id alone when nothing is stored", () => {
    expect(buildAttributionFields(null, "anon-1")).toEqual({
      hs_anonymous_id: "anon-1",
    });
  });

  it("flattens the stored last-touch set for hidden-field passthrough", () => {
    const parsed = parseAttribution(HREF, "");
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const fields = buildAttributionFields(
      { ...parsed, capturedAt: "2026-07-12T10:00:00.000Z" },
      "anon-1",
    );
    expect(fields).toEqual({
      hs_anonymous_id: "anon-1",
      fbclid: "AbCd123",
      utm_source: "facebook",
      utm_medium: "paid",
      utm_campaign: "spring",
      hs_landing_page: "https://example.com/solar/quote",
      hs_captured_at: "2026-07-12T10:00:00.000Z",
    });
  });
});
