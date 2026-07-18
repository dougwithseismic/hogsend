import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandTemplateCanvas } from "./brand-template-canvas";

describe("BrandTemplateCanvas", () => {
  it("renders an opaque clean canvas from the real thermal assets without copy", () => {
    const markup = renderToStaticMarkup(
      <BrandTemplateCanvas preset="og" treatment="clean" palette="default" />,
    );

    expect(markup).toContain("data-brand-template-canvas");
    expect(markup).toContain('data-composition="landscape"');
    expect(markup).toContain("width:1200px");
    expect(markup).toContain("height:630px");
    expect(markup).toContain("background-color:#050101");
    expect(markup).toContain("/images/textures/thermal-1.webp");
    expect(markup).toContain('data-brand-frame-line="divider"');
    expect(markup).not.toContain("hogsend.com");
  });

  it("renders a signed wide canvas inside its safe region", () => {
    const markup = renderToStaticMarkup(
      <BrandTemplateCanvas
        preset="linkedin-profile-banner"
        treatment="signed"
        palette="default"
      />,
    );

    expect(markup).toContain('data-composition="wide"');
    expect(markup).toContain('data-brand-signature="true"');
    expect(markup).toContain("hogsend.com");
    expect(markup).toContain("right:146.52px");
  });

  it("recolors approved colorways without adding copy", () => {
    const markup = renderToStaticMarkup(
      <BrandTemplateCanvas
        preset="social-square"
        treatment="colorway"
        palette="violet"
      />,
    );

    expect(markup).toContain("#c75cff");
    expect(markup).toContain("#3a1b91");
    expect(markup).not.toContain("hogsend.com");
  });

  it("adapts the layout for portrait canvases", () => {
    const markup = renderToStaticMarkup(
      <BrandTemplateCanvas
        preset="story"
        treatment="clean"
        palette="default"
      />,
    );

    expect(markup).toContain('data-composition="portrait"');
    expect(markup).toContain("width:1080px");
    expect(markup).toContain("height:1920px");
  });

  it("renders the stream preset with palette-specific luminance-to-alpha edges", () => {
    const markup = renderToStaticMarkup(
      <BrandTemplateCanvas
        preset="stream-overlay"
        treatment="clean"
        palette="cyan"
      />,
    );

    expect(markup).toContain("width:1920px");
    expect(markup).toContain("height:1080px");
    expect(markup).toContain("background-color:transparent");
    expect(markup).toContain("feColorMatrix");
    expect(markup).toContain("thermal-to-alpha-stream-overlay-cyan");
    expect(markup).toContain("0.188");
    expect(markup).toContain("0.851");
  });

  it("renders optional content after decorative layers without changing blank canvases", () => {
    const blank = renderToStaticMarkup(<BrandTemplateCanvas preset="og" />);
    const populated = renderToStaticMarkup(
      <BrandTemplateCanvas preset="og">
        <section data-test-content="true">Example content</section>
      </BrandTemplateCanvas>,
    );

    expect(blank).not.toContain("Example content");
    expect(populated).toContain("Example content");
    expect(populated.indexOf('data-safe-area="true"')).toBeLessThan(
      populated.indexOf('data-test-content="true"'),
    );
  });
});
