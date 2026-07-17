import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  resolveBrandCarouselCard,
  resolveBrandTextExample,
} from "@/lib/brand-template-content";
import { BrandTemplateContentLayer } from "./brand-template-content";

describe("BrandTemplateContentLayer", () => {
  it("renders campaign metadata and design-system typography", () => {
    const job = resolveBrandCarouselCard("reddit", "one-person-silo", 4);
    if (!job) throw new Error("expected campaign card");

    const markup = renderToStaticMarkup(
      <BrandTemplateContentLayer
        preset={job.preset}
        palette={job.palette}
        content={job.content}
      />,
    );

    expect(markup).toContain("data-brand-content");
    expect(markup).toContain('data-content-chamber="upper"');
    expect(markup).toContain("top:110.9px");
    expect(markup).toContain("04 / 04");
    expect(markup).toContain("See it. Improve it. Send it.");
    expect(markup).toContain("pnpm dlx create-hogsend@latest");
    expect(markup).toContain("hogsend.com");
    expect(markup).toContain("var(--font-sans)");
    expect(markup).toContain("var(--font-mono)");
  });

  it("only renders commands when content supplies one", () => {
    const problem = resolveBrandCarouselCard("meta", "leaking-bucket", 1);
    const cta = resolveBrandCarouselCard("meta", "leaking-bucket", 4);
    if (!problem || !cta) throw new Error("expected campaign cards");

    expect(
      renderToStaticMarkup(
        <BrandTemplateContentLayer
          preset={problem.preset}
          palette={problem.palette}
          content={problem.content}
        />,
      ),
    ).not.toContain("data-brand-command");
    expect(
      renderToStaticMarkup(
        <BrandTemplateContentLayer
          preset={cta.preset}
          palette={cta.palette}
          content={cta.content}
        />,
      ),
    ).toContain("data-brand-command");
  });

  it("compacts long headlines and renders ordered steps", () => {
    const longCard = resolveBrandCarouselCard("reddit", "clock-speed", 1);
    const threeLineCard = resolveBrandCarouselCard("meta", "launch-spike", 1);
    const commandCard = resolveBrandCarouselCard("reddit", "silent-drift", 4);
    const example = resolveBrandTextExample("linkedin-measure-keep-grow");
    if (!longCard || !threeLineCard || !commandCard || !example) {
      throw new Error("expected content");
    }

    expect(
      renderToStaticMarkup(
        <BrandTemplateContentLayer
          preset={longCard.preset}
          palette={longCard.palette}
          content={longCard.content}
        />,
      ),
    ).toContain('data-copy-density="compact"');
    expect(
      renderToStaticMarkup(
        <BrandTemplateContentLayer
          preset={commandCard.preset}
          palette={commandCard.palette}
          content={commandCard.content}
        />,
      ),
    ).toContain('data-copy-density="compact"');
    expect(
      renderToStaticMarkup(
        <BrandTemplateContentLayer
          preset={threeLineCard.preset}
          palette={threeLineCard.palette}
          content={threeLineCard.content}
        />,
      ),
    ).toContain('data-copy-density="compact"');

    const stepsMarkup = renderToStaticMarkup(
      <BrandTemplateContentLayer
        preset={example.preset}
        palette={example.palette}
        content={example.content}
      />,
    );
    expect(stepsMarkup).toContain("See where people drop off");
    expect(stepsMarkup).toContain("Scale what keeps them");
  });
});
