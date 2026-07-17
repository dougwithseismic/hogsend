export type BrandTemplateComposition =
  | "landscape"
  | "square"
  | "portrait"
  | "wide"
  | "overlay";

export type BrandTemplateTreatment = "clean" | "signed" | "colorway";
export type BrandTemplatePaletteKey =
  | "default"
  | "ember"
  | "violet"
  | "cyan"
  | "acid";

type SafeArea =
  | { unit: "ratio"; x: number; y: number; width: number; height: number }
  | { unit: "px"; x: number; y: number; width: number; height: number };

type BrandTemplatePresetDefinition = {
  width: number;
  height: number;
  transparent: boolean;
  composition: BrandTemplateComposition;
  safeArea: SafeArea;
};

export const BRAND_TEMPLATE_PALETTES = {
  default: { accent: "#f64838", hot: "#ff7a45", glow: "#7c140f" },
  ember: { accent: "#ff4d24", hot: "#ffc14d", glow: "#8f1800" },
  violet: { accent: "#c75cff", hot: "#ff4fd8", glow: "#3a1b91" },
  cyan: { accent: "#30d9ff", hot: "#73fff2", glow: "#075c91" },
  acid: { accent: "#b8ff38", hot: "#efff73", glow: "#357800" },
} as const satisfies Record<
  BrandTemplatePaletteKey,
  { accent: string; hot: string; glow: string }
>;

export const BRAND_TEMPLATE_PRESETS = {
  og: {
    width: 1200,
    height: 630,
    transparent: false,
    composition: "landscape",
    safeArea: { unit: "ratio", x: 0.22, y: 0.16, width: 0.56, height: 0.68 },
  },
  golden: {
    width: 1200,
    height: 742,
    transparent: false,
    composition: "landscape",
    safeArea: { unit: "ratio", x: 0.22, y: 0.16, width: 0.56, height: 0.68 },
  },
  "social-9x6": {
    width: 1080,
    height: 720,
    transparent: false,
    composition: "landscape",
    safeArea: { unit: "ratio", x: 0.22, y: 0.16, width: 0.56, height: 0.68 },
  },
  "social-square": {
    width: 1080,
    height: 1080,
    transparent: false,
    composition: "square",
    safeArea: { unit: "ratio", x: 0.19, y: 0.19, width: 0.62, height: 0.62 },
  },
  "social-portrait": {
    width: 1080,
    height: 1350,
    transparent: false,
    composition: "portrait",
    safeArea: { unit: "ratio", x: 0.16, y: 0.2, width: 0.68, height: 0.6 },
  },
  story: {
    width: 1080,
    height: 1920,
    transparent: false,
    composition: "portrait",
    safeArea: { unit: "ratio", x: 0.15, y: 0.22, width: 0.7, height: 0.56 },
  },
  "youtube-thumbnail": {
    width: 1280,
    height: 720,
    transparent: false,
    composition: "landscape",
    safeArea: { unit: "ratio", x: 0.18, y: 0.16, width: 0.64, height: 0.68 },
  },
  "youtube-banner": {
    width: 2560,
    height: 1440,
    transparent: false,
    composition: "wide",
    safeArea: { unit: "px", x: 508, y: 508.5, width: 1544, height: 423 },
  },
  "linkedin-post": {
    width: 1200,
    height: 627,
    transparent: false,
    composition: "landscape",
    safeArea: { unit: "ratio", x: 0.2, y: 0.16, width: 0.6, height: 0.68 },
  },
  "linkedin-profile-banner": {
    width: 1584,
    height: 396,
    transparent: false,
    composition: "wide",
    safeArea: { unit: "ratio", x: 0.28, y: 0.15, width: 0.64, height: 0.7 },
  },
  "linkedin-company-banner": {
    width: 4200,
    height: 700,
    transparent: false,
    composition: "wide",
    safeArea: { unit: "ratio", x: 0.18, y: 0.15, width: 0.72, height: 0.7 },
  },
  "x-post": {
    width: 1600,
    height: 900,
    transparent: false,
    composition: "landscape",
    safeArea: { unit: "ratio", x: 0.2, y: 0.16, width: 0.6, height: 0.68 },
  },
  "x-header": {
    width: 1500,
    height: 500,
    transparent: false,
    composition: "wide",
    safeArea: { unit: "ratio", x: 0.22, y: 0.18, width: 0.68, height: 0.64 },
  },
  "stream-overlay": {
    width: 1920,
    height: 1080,
    transparent: true,
    composition: "overlay",
    safeArea: { unit: "ratio", x: 0.21, y: 0.16, width: 0.58, height: 0.68 },
  },
  "stream-screen": {
    width: 1920,
    height: 1080,
    transparent: false,
    composition: "landscape",
    safeArea: { unit: "ratio", x: 0.19, y: 0.16, width: 0.62, height: 0.68 },
  },
} as const satisfies Record<string, BrandTemplatePresetDefinition>;

export const COLORWAY_PRESETS = [
  "og",
  "social-square",
  "social-portrait",
  "youtube-thumbnail",
  "stream-screen",
] as const satisfies readonly BrandTemplatePresetKey[];

const COLORWAY_PALETTES = ["ember", "violet", "cyan", "acid"] as const;

export type BrandTemplatePresetKey = keyof typeof BRAND_TEMPLATE_PRESETS;
export type BrandTemplatePreset =
  (typeof BRAND_TEMPLATE_PRESETS)[BrandTemplatePresetKey];

export type BrandTemplateJob = {
  preset: BrandTemplatePresetKey;
  treatment: BrandTemplateTreatment;
  palette: BrandTemplatePaletteKey;
};

export function isBrandTemplatePresetKey(
  value: string,
): value is BrandTemplatePresetKey {
  return Object.hasOwn(BRAND_TEMPLATE_PRESETS, value);
}

export function isBrandTemplateTreatment(
  value: string,
): value is BrandTemplateTreatment {
  return ["clean", "signed", "colorway"].includes(value);
}

export function isBrandTemplatePaletteKey(
  value: string,
): value is BrandTemplatePaletteKey {
  return Object.hasOwn(BRAND_TEMPLATE_PALETTES, value);
}

export function getUniformFrameInset(width: number, height: number) {
  return Math.min(
    64,
    Math.max(24, Math.round(Math.min(width, height) * 0.045)),
  );
}

export function getBrandTemplateGeometry(key: BrandTemplatePresetKey) {
  const preset = BRAND_TEMPLATE_PRESETS[key];
  const px = (value: number) => Math.round(value * 1000) / 1000;
  const safe = preset.safeArea;
  const ratio = safe.unit === "ratio";
  const frameInset = getUniformFrameInset(preset.width, preset.height);
  const safeY = px(ratio ? preset.height * safe.y : safe.y);
  const safeHeight = px(ratio ? preset.height * safe.height : safe.height);
  const dividerY = px(preset.height * 0.78);
  const chamberHeight = dividerY - frameInset;
  const contentHeight = px(Math.min(safeHeight, chamberHeight));
  const centeredContentY = px(frameInset + (chamberHeight - contentHeight) / 2);
  const contentY = ratio
    ? centeredContentY
    : px(Math.min(Math.max(safeY, frameInset), dividerY - contentHeight));

  return {
    frameInsetX: frameInset,
    frameInsetY: frameInset,
    dividerY,
    safeX: px(ratio ? preset.width * safe.x : safe.x),
    safeY,
    safeWidth: px(ratio ? preset.width * safe.width : safe.width),
    safeHeight,
    contentY,
    contentHeight,
  };
}

export function getBrandTemplateJobs(): BrandTemplateJob[] {
  const presets = Object.keys(
    BRAND_TEMPLATE_PRESETS,
  ) as BrandTemplatePresetKey[];
  const jobs: BrandTemplateJob[] = presets.flatMap((preset) => [
    { preset, treatment: "clean", palette: "default" },
    { preset, treatment: "signed", palette: "default" },
  ]);

  for (const preset of COLORWAY_PRESETS) {
    for (const palette of COLORWAY_PALETTES) {
      jobs.push({ preset, treatment: "colorway", palette });
    }
  }

  return jobs;
}
