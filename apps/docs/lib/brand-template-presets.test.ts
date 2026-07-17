import { describe, expect, it } from "vitest";
import {
  BRAND_TEMPLATE_PALETTES,
  BRAND_TEMPLATE_PRESETS,
  type BrandTemplatePresetKey,
  COLORWAY_PRESETS,
  getBrandTemplateGeometry,
  getBrandTemplateJobs,
  getUniformFrameInset,
  isBrandTemplatePaletteKey,
  isBrandTemplatePresetKey,
  isBrandTemplateTreatment,
} from "./brand-template-presets";

const DIMENSIONS = {
  og: [1200, 630],
  golden: [1200, 742],
  "social-9x6": [1080, 720],
  "social-square": [1080, 1080],
  "social-portrait": [1080, 1350],
  story: [1080, 1920],
  "youtube-thumbnail": [1280, 720],
  "youtube-banner": [2560, 1440],
  "linkedin-post": [1200, 627],
  "linkedin-profile-banner": [1584, 396],
  "linkedin-company-banner": [4200, 700],
  "x-post": [1600, 900],
  "x-header": [1500, 500],
  "stream-overlay": [1920, 1080],
  "stream-screen": [1920, 1080],
} as const;

describe("brand template presets", () => {
  it("defines all 15 exact output dimensions", () => {
    expect(Object.keys(BRAND_TEMPLATE_PRESETS)).toEqual(
      Object.keys(DIMENSIONS),
    );
    for (const [key, [width, height]] of Object.entries(DIMENSIONS)) {
      const preset = BRAND_TEMPLATE_PRESETS[key as keyof typeof DIMENSIONS];
      expect([preset.width, preset.height]).toEqual([width, height]);
    }
  });

  it("defines the five approved thermal palettes", () => {
    expect(Object.keys(BRAND_TEMPLATE_PALETTES)).toEqual([
      "default",
      "ember",
      "violet",
      "cyan",
      "acid",
    ]);
    expect(BRAND_TEMPLATE_PALETTES.violet.accent).toBe("#c75cff");
  });

  it("derives exact safe bounds including YouTube channel art", () => {
    expect(getBrandTemplateGeometry("youtube-banner")).toMatchObject({
      safeX: 508,
      safeY: 508.5,
      safeWidth: 1544,
      safeHeight: 423,
    });
    expect(getBrandTemplateGeometry("social-square")).toMatchObject({
      safeX: 205.2,
      safeY: 205.2,
      safeWidth: 669.6,
      safeHeight: 669.6,
    });
  });

  it("uses one clamped inset on all four frame edges", () => {
    expect(getUniformFrameInset(1200, 630)).toBe(28);
    expect(getUniformFrameInset(1080, 1080)).toBe(49);
    expect(getUniformFrameInset(1584, 396)).toBe(24);
    expect(getUniformFrameInset(2560, 1440)).toBe(64);

    for (const key of Object.keys(
      BRAND_TEMPLATE_PRESETS,
    ) as BrandTemplatePresetKey[]) {
      const geometry = getBrandTemplateGeometry(key);
      expect(geometry.frameInsetX).toBe(geometry.frameInsetY);
      expect(geometry.frameInsetX).toBeGreaterThanOrEqual(24);
      expect(geometry.frameInsetX).toBeLessThanOrEqual(64);
    }
  });

  it("places content inside the chamber above the lower divider", () => {
    expect(getBrandTemplateGeometry("social-square")).toMatchObject({
      dividerY: 842.4,
      contentY: 110.9,
      contentHeight: 669.6,
    });

    for (const key of Object.keys(
      BRAND_TEMPLATE_PRESETS,
    ) as BrandTemplatePresetKey[]) {
      const geometry = getBrandTemplateGeometry(key);
      expect(geometry.contentY).toBeGreaterThanOrEqual(geometry.frameInsetY);
      expect(geometry.contentY + geometry.contentHeight).toBeLessThanOrEqual(
        geometry.dividerY,
      );
    }
  });

  it("creates exactly 50 unique approved render jobs", () => {
    const jobs = getBrandTemplateJobs();
    const keys = jobs.map(
      ({ preset, treatment, palette }) => `${preset}:${treatment}:${palette}`,
    );

    expect(jobs).toHaveLength(50);
    expect(new Set(keys).size).toBe(50);

    for (const preset of Object.keys(BRAND_TEMPLATE_PRESETS)) {
      expect(keys).toContain(`${preset}:clean:default`);
      expect(keys).toContain(`${preset}:signed:default`);
    }

    const colorwayJobs = jobs.filter(
      ({ treatment }) => treatment === "colorway",
    );
    expect(new Set(colorwayJobs.map(({ preset }) => preset))).toEqual(
      new Set(COLORWAY_PRESETS),
    );
    expect(colorwayJobs.every(({ palette }) => palette !== "default")).toBe(
      true,
    );
  });

  it("guards preview parameters", () => {
    expect(isBrandTemplatePresetKey("stream-overlay")).toBe(true);
    expect(isBrandTemplatePresetKey("unknown")).toBe(false);
    expect(isBrandTemplateTreatment("signed")).toBe(true);
    expect(isBrandTemplateTreatment("loud")).toBe(false);
    expect(isBrandTemplatePaletteKey("cyan")).toBe(true);
    expect(isBrandTemplatePaletteKey("blue")).toBe(false);
  });
});
