import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandContent } from "./brand-content";
import { BrandFrame } from "./brand-frame";

describe("shared brand frame", () => {
  it("renders equal padding and the 78 percent divider", () => {
    const html = renderToStaticMarkup(
      <BrandFrame preset="og" resolveAsset={(path) => `/resolved${path}`} />,
    );

    expect(html).toContain('data-frame-inset-x="28"');
    expect(html).toContain('data-frame-inset-y="28"');
    expect(html).toContain('data-divider-y="491.4"');
  });

  it("resolves both real thermal assets", () => {
    const html = renderToStaticMarkup(
      <BrandFrame preset="og" resolveAsset={(path) => `/resolved${path}`} />,
    );

    expect(html).toContain("/resolved/images/textures/thermal-1.webp");
    expect(html).toContain("/resolved/images/textures/thermal-2.webp");
  });

  it("keeps content in the upper chamber", () => {
    const html = renderToStaticMarkup(
      <BrandContent
        preset="og"
        palette="default"
        content={{
          eyebrow: "CUSTOMER MARKETING",
          headline: "Follow up while interest is high.",
          body: "Ship the right message from your product.",
          layout: "editorial",
          signature: "hogsend.com",
        }}
      />,
    );

    expect(html).toContain('data-content-chamber="upper"');
    expect(html).toContain("top:45.5px");
    expect(html).toContain("height:428.4px");
  });
});
