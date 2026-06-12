import { useVideoConfig } from "remotion";

export type Ratio = "169" | "916" | "11";

export type Format = {
  ratio: Ratio;
  width: number;
  height: number;
  isPortrait: boolean;
  /** Base content padding inside the hairline frame, in px */
  pad: number;
  /** Multiply font sizes by this (1 on 16:9) */
  fontScale: number;
  /**
   * Extra top/bottom inset on 9:16 keeping content in the centre-safe
   * band (~12% reserved for platform UI overlays). 0 on other ratios.
   */
  safeTop: number;
  safeBottom: number;
};

/**
 * Derives the current format from useVideoConfig(). Every component in
 * the kit is responsive to the three registered ratios via this hook.
 */
export const useFormat = (): Format => {
  const { width, height } = useVideoConfig();
  const ratio: Ratio = height > width ? "916" : width === height ? "11" : "169";
  const isPortrait = ratio === "916";
  return {
    ratio,
    width,
    height,
    isPortrait,
    pad: ratio === "169" ? 112 : ratio === "11" ? 88 : 72,
    fontScale: ratio === "169" ? 1 : ratio === "11" ? 0.82 : 0.72,
    safeTop: isPortrait ? Math.round(height * 0.12) : 0,
    safeBottom: isPortrait ? Math.round(height * 0.12) : 0,
  };
};
