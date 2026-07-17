import { describe, expect, it } from "vitest";
import {
  BRAND_TEMPLATE_PRESETS,
  getBrandTemplateGeometry,
  getUniformFrameInset,
} from "./presets";

describe("brand template geometry", () => {
  it("uses one inset for every edge", () => {
    const preset = BRAND_TEMPLATE_PRESETS.og;
    const geometry = getBrandTemplateGeometry("og");

    expect(geometry.frameInsetX).toBe(
      getUniformFrameInset(preset.width, preset.height),
    );
    expect(geometry.frameInsetY).toBe(geometry.frameInsetX);
    expect(preset.width - geometry.frameInsetX).toBe(
      preset.width - geometry.frameInsetY,
    );
  });

  it("places the divider at 78 percent", () => {
    expect(getBrandTemplateGeometry("social-square").dividerY).toBe(842.4);
  });

  it("keeps the content chamber above the divider", () => {
    for (const key of Object.keys(BRAND_TEMPLATE_PRESETS)) {
      const geometry = getBrandTemplateGeometry(
        key as keyof typeof BRAND_TEMPLATE_PRESETS,
      );
      expect(geometry.contentY).toBeGreaterThanOrEqual(geometry.frameInsetY);
      expect(geometry.contentY + geometry.contentHeight).toBeLessThanOrEqual(
        geometry.dividerY,
      );
    }
  });
});
