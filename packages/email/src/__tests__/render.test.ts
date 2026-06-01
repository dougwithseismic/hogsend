import { createElement } from "react";
import { Body, Html, Text } from "react-email";
import { describe, expect, it } from "vitest";
import { renderToHtml, renderToPlainText } from "../render.js";

// Render is template-agnostic machinery: it turns any react-email element into
// HTML / plain text. Use a minimal inline element rather than a baked template.
function fixtureElement(name: string) {
  return createElement(
    Html,
    null,
    createElement(Body, null, createElement(Text, null, `Welcome ${name}`)),
  );
}

describe("renderToHtml", () => {
  it("renders a react-email element to HTML", async () => {
    const html = await renderToHtml(fixtureElement("Doug"));
    expect(html).toContain("Welcome");
    expect(html).toContain("Doug");
    expect(html).toContain("<html");
  });
});

describe("renderToPlainText", () => {
  it("renders a react-email element to plain text", async () => {
    const text = await renderToPlainText(fixtureElement("Doug"));
    expect(text).toContain("Welcome");
    expect(text).toContain("Doug");
    expect(text).not.toContain("<html");
  });
});
