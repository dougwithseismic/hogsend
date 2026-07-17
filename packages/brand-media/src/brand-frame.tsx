import type { CSSProperties, ReactNode } from "react";
import {
  BRAND_TEMPLATE_PALETTES,
  BRAND_TEMPLATE_PRESETS,
  type BrandTemplateComposition,
  type BrandTemplatePaletteKey,
  type BrandTemplatePresetKey,
  type BrandTemplateTreatment,
  getBrandTemplateGeometry,
} from "./presets";

const TEXTURES = [
  "/images/textures/thermal-1.webp",
  "/images/textures/thermal-2.webp",
] as const;

const COMPOSITIONS: Record<
  BrandTemplateComposition,
  { mask: string; glowPosition: string; dotOpacity: number }
> = {
  landscape: {
    mask: "linear-gradient(90deg, black, transparent 43%, transparent 57%, black)",
    glowPosition: "78% 110%",
    dotOpacity: 0.42,
  },
  square: {
    mask: "radial-gradient(circle at center, transparent 0 34%, black 76%)",
    glowPosition: "82% 105%",
    dotOpacity: 0.4,
  },
  portrait: {
    mask: "radial-gradient(ellipse at center, transparent 0 32%, black 78%)",
    glowPosition: "82% 92%",
    dotOpacity: 0.38,
  },
  wide: {
    mask: "linear-gradient(90deg, black, transparent 34%, transparent 66%, black)",
    glowPosition: "82% 120%",
    dotOpacity: 0.36,
  },
  overlay: {
    mask: "linear-gradient(90deg, black, transparent 31%, transparent 69%, black)",
    glowPosition: "82% 90%",
    dotOpacity: 0.28,
  },
};

const THERMAL_FILTERS: Record<BrandTemplatePaletteKey, string | undefined> = {
  default: undefined,
  ember: "saturate(1.35) brightness(1.08)",
  violet: "hue-rotate(280deg) saturate(1.35)",
  cyan: "hue-rotate(154deg) saturate(1.25) brightness(1.08)",
  acid: "hue-rotate(72deg) saturate(1.45) brightness(1.06)",
};

export type BrandFrameMotion = {
  lineProgress?: number;
  thermalMix?: number;
  thermalX?: number;
  thermalY?: number;
  glow?: number;
};

export type BrandFrameProps = {
  preset: BrandTemplatePresetKey;
  treatment?: BrandTemplateTreatment;
  palette?: BrandTemplatePaletteKey;
  resolveAsset?: (path: string) => string;
  motion?: BrandFrameMotion;
  children?: ReactNode;
};

function lineStyle(
  lineProgress: number,
  origin: "left" | "top",
): CSSProperties {
  return {
    transform:
      origin === "left" ? `scaleX(${lineProgress})` : `scaleY(${lineProgress})`,
    transformOrigin: origin,
  };
}

export function BrandFrame({
  preset: key,
  treatment = "clean",
  palette = "default",
  resolveAsset = (path) => path,
  motion,
  children,
}: BrandFrameProps) {
  const preset = BRAND_TEMPLATE_PRESETS[key];
  const tokens = BRAND_TEMPLATE_PALETTES[palette];
  const composition = COMPOSITIONS[preset.composition];
  const geometry = getBrandTemplateGeometry(key);
  const lineProgress = Math.min(1, Math.max(0, motion?.lineProgress ?? 1));
  const thermalMix = Math.min(1, Math.max(0, motion?.thermalMix ?? 0.5));
  const thermalX = motion?.thermalX ?? 0;
  const thermalY = motion?.thermalY ?? 0;
  const glow = motion?.glow ?? 1;
  const frameColor = preset.transparent
    ? `${tokens.accent}59`
    : "rgba(255,255,255,0.08)";
  const dotSize = Math.max(18, preset.width * 0.018);
  const rootStyle: CSSProperties = {
    position: "relative",
    width: preset.width,
    height: preset.height,
    overflow: "hidden",
    backgroundColor: preset.transparent ? "transparent" : "#050101",
    isolation: "isolate",
  };

  return (
    <div
      data-brand-template-canvas={key}
      data-brand-template-ready="true"
      data-composition={preset.composition}
      data-treatment={treatment}
      data-palette={palette}
      data-frame-inset-x={geometry.frameInsetX}
      data-frame-inset-y={geometry.frameInsetY}
      data-divider-y={geometry.dividerY}
      style={rootStyle}
    >
      {!preset.transparent && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: "-6%",
            overflow: "hidden",
            maskImage: composition.mask,
            filter: THERMAL_FILTERS[palette],
            transform: `translate3d(${thermalX}px, ${thermalY}px, 0) scale(1.08)`,
          }}
        >
          {TEXTURES.map((path, index) => (
            <img
              key={path}
              src={resolveAsset(path)}
              alt=""
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                mixBlendMode: "plus-lighter",
                opacity: (index === 0 ? 1 - thermalMix : thermalMix) * 0.44,
              }}
            />
          ))}
        </div>
      )}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(70% 55% at ${composition.glowPosition}, ${tokens.glow}88, transparent 72%)`,
          opacity: glow,
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `radial-gradient(${tokens.accent}66 1px, transparent 1px)`,
          backgroundSize: `${dotSize}px ${dotSize}px`,
          maskImage: composition.mask,
          opacity: composition.dotOpacity,
        }}
      />
      {[geometry.frameInsetX, preset.width - geometry.frameInsetX].map(
        (left) => (
          <span
            key={`v-${left}`}
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left,
              width: 1,
              background: frameColor,
              ...lineStyle(lineProgress, "top"),
            }}
          />
        ),
      )}
      {[
        ["top", geometry.frameInsetY],
        ["divider", geometry.dividerY],
        ["bottom", preset.height - geometry.frameInsetY],
      ].map(([role, top]) => (
        <span
          key={String(role)}
          aria-hidden="true"
          data-brand-frame-line={role}
          style={{
            position: "absolute",
            right: 0,
            left: 0,
            top: Number(top),
            height: 1,
            background: frameColor,
            ...lineStyle(lineProgress, "left"),
          }}
        />
      ))}
      <div
        aria-hidden="true"
        data-safe-area="true"
        style={{
          position: "absolute",
          left: geometry.safeX,
          top: geometry.safeY,
          width: geometry.safeWidth,
          height: geometry.safeHeight,
        }}
      />
      {treatment === "signed" && (
        <span
          data-brand-signature="true"
          style={{
            position: "absolute",
            right: geometry.frameInsetX * 1.6,
            bottom: geometry.frameInsetY * 1.6,
            color: `${tokens.hot}99`,
            fontFamily: "var(--font-mono), monospace",
            fontSize: Math.max(11, Math.min(18, preset.height * 0.025)),
            letterSpacing: "0.08em",
          }}
        >
          hogsend.com
        </span>
      )}
      {children}
    </div>
  );
}
