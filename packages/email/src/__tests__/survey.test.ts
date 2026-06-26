import { createElement, type ReactElement } from "react";
import { Body, Html } from "react-email";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToHtml } from "../render.js";
import { Survey, type SurveyProps } from "../survey.js";

// Survey is pure composition over EmailAction: each option becomes a semantic
// anchor carrying data-hs-event / data-hs-props, so it flows through the SAME
// link-rewrite pipeline with no engine change.
function wrap(props: SurveyProps): ReactElement {
  return createElement(
    Html,
    null,
    createElement(Body, null, createElement(Survey, props)),
  );
}

describe("Survey", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an NPS scale as 11 semantic anchors (0..10)", async () => {
    const html = await renderToHtml(wrap({ event: "nps.test", mode: "nps" }));
    const events = html.match(/data-hs-event="nps\.test"/g) ?? [];
    expect(events).toHaveLength(11);
    // Bounds carry the numeric answer under the default "value" key.
    expect(html).toContain('data-hs-props="{&quot;value&quot;:0}"');
    expect(html).toContain('data-hs-props="{&quot;value&quot;:10}"');
    // No per-option href → the hosted answer page sentinel.
    expect(html).toContain('href="hogsend://answer"');
  });

  it("renders a scale with custom bounds, property key, and end labels", async () => {
    const html = await renderToHtml(
      wrap({
        event: "rating.test",
        mode: "scale",
        min: 1,
        max: 3,
        property: "stars",
        minLabel: "Bad",
        maxLabel: "Great",
      }),
    );
    const events = html.match(/data-hs-event="rating\.test"/g) ?? [];
    expect(events).toHaveLength(3);
    expect(html).toContain('data-hs-props="{&quot;stars&quot;:1}"');
    expect(html).toContain('data-hs-props="{&quot;stars&quot;:3}"');
    expect(html).toContain("data-hs-survey-min-label");
    expect(html).toContain("Bad");
    expect(html).toContain("Great");
  });

  it("defaults yes/no to Yes=true / No=false", async () => {
    const html = await renderToHtml(
      wrap({ event: "confirm.test", mode: "yesno" }),
    );
    expect(html).toContain('data-hs-props="{&quot;value&quot;:true}"');
    expect(html).toContain('data-hs-props="{&quot;value&quot;:false}"');
    expect(html).toContain(">Yes</a>");
    expect(html).toContain(">No</a>");
  });

  it("renders explicit choice options with a per-option href override", async () => {
    const html = await renderToHtml(
      wrap({
        event: "color.test",
        mode: "choice",
        choices: [
          { label: "Blue", value: "blue" },
          { label: "Red", value: "red" },
        ],
        hrefFor: (v) => `https://x.test/${v}`,
      }),
    );
    expect(html).toContain('href="https://x.test/blue"');
    expect(html).toContain('href="https://x.test/red"');
    expect(html).toContain(
      'data-hs-props="{&quot;value&quot;:&quot;red&quot;}"',
    );
  });

  it("warns (does not throw) on a reserved-namespace event", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = await renderToHtml(
      wrap({ event: "email.opened", mode: "yesno" }),
    );
    expect(warn).toHaveBeenCalledOnce();
    // Still renders the anchors — the engine is the authority that rejects it.
    expect(html).toContain(">Yes</a>");
  });
});
