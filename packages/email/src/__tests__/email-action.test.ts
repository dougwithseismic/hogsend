import { createElement } from "react";
import { Body, Html } from "react-email";
import { describe, expect, it } from "vitest";
import { EmailAction } from "../email-action.js";
import { renderToHtml, renderToPlainText } from "../render.js";

// EmailAction is the template side of the semantic-link wire: it must render a
// plain anchor carrying data-hs-event / data-hs-props through renderToHtml so
// the engine's rewriteLinks can lift + strip them at send time.
function fixtureElement() {
  return createElement(
    Html,
    null,
    createElement(
      Body,
      null,
      createElement(
        EmailAction,
        {
          href: "https://example.com/thanks?score=9",
          event: "nps.submitted",
          properties: { score: 9, source: "email" },
        },
        "9",
      ),
    ),
  );
}

describe("EmailAction", () => {
  it("renders an anchor with the semantic data attributes", async () => {
    const html = await renderToHtml(fixtureElement());
    expect(html).toContain('href="https://example.com/thanks?score=9"');
    expect(html).toContain('data-hs-event="nps.submitted"');
    // React entity-escapes the JSON quotes — the engine lifter decodes them.
    expect(html).toContain(
      'data-hs-props="{&quot;score&quot;:9,&quot;source&quot;:&quot;email&quot;}"',
    );
  });

  it("omits data-hs-props when no properties are given", async () => {
    const html = await renderToHtml(
      createElement(
        Html,
        null,
        createElement(
          Body,
          null,
          createElement(
            EmailAction,
            { href: "https://example.com/yes", event: "checkin.answered" },
            "Yes",
          ),
        ),
      ),
    );
    expect(html).toContain('data-hs-event="checkin.answered"');
    expect(html).not.toContain("data-hs-props");
  });

  it("passes ordinary anchor props through", async () => {
    const html = await renderToHtml(
      createElement(
        Html,
        null,
        createElement(
          Body,
          null,
          createElement(
            EmailAction,
            {
              href: "https://example.com/yes",
              event: "checkin.answered",
              style: { color: "rgb(1, 2, 3)" },
            },
            "Yes",
          ),
        ),
      ),
    );
    expect(html).toContain("color:rgb(1, 2, 3)");
  });

  it("leaves plain-text rendering untouched", async () => {
    const text = await renderToPlainText(fixtureElement());
    expect(text).not.toContain("data-hs-event");
    expect(text).not.toContain("data-hs-props");
  });
});
