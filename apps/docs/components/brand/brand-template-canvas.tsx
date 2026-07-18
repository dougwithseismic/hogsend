import type { CSSProperties, ReactNode } from "react";
import { HalftoneOverlay, ThermalLayer } from "@/components/ds/thermal";
import {
  BRAND_TEMPLATE_PALETTES,
  BRAND_TEMPLATE_PRESETS,
  type BrandTemplateComposition,
  type BrandTemplatePaletteKey,
  type BrandTemplatePresetKey,
  type BrandTemplateTreatment,
  getBrandTemplateGeometry,
} from "@/lib/brand-template-presets";

const INK = "#050101";
const TEXTURES: [string, string] = [
  "/images/textures/thermal-1.webp",
  "/images/textures/thermal-2.webp",
];

const COMPOSITIONS: Record<
  BrandTemplateComposition,
  { mask: string; glowPosition: string; strength: number; dotOpacity: number }
> = {
  landscape: {
    mask: "linear-gradient(90deg, black, transparent 43%, transparent 57%, black)",
    glowPosition: "78% 110%",
    strength: 0.3,
    dotOpacity: 0.42,
  },
  square: {
    mask: "radial-gradient(circle at center, transparent 0 34%, black 76%)",
    glowPosition: "82% 105%",
    strength: 0.32,
    dotOpacity: 0.4,
  },
  portrait: {
    mask: "radial-gradient(ellipse at center, transparent 0 32%, black 78%)",
    glowPosition: "82% 92%",
    strength: 0.34,
    dotOpacity: 0.38,
  },
  wide: {
    mask: "linear-gradient(90deg, black, transparent 34%, transparent 66%, black)",
    glowPosition: "82% 120%",
    strength: 0.34,
    dotOpacity: 0.36,
  },
  overlay: {
    mask: "linear-gradient(90deg, black, transparent 31%, transparent 69%, black)",
    glowPosition: "82% 90%",
    strength: 0.3,
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

type FrameProps = {
  width: number;
  height: number;
  insetX: number;
  insetY: number;
  dividerY: number;
  transparent: boolean;
  accent: string;
};

function Frame({
  width,
  height,
  insetX,
  insetY,
  dividerY,
  transparent,
  accent,
}: FrameProps) {
  const color = transparent ? `${accent}59` : "rgba(255,255,255,0.08)";
  const vertical = [insetX, width - insetX];
  const horizontal = [
    { role: "top", top: insetY },
    { role: "divider", top: dividerY },
    { role: "bottom", top: height - insetY },
  ] as const;

  return (
    <div aria-hidden="true" style={{ position: "absolute", inset: 0 }}>
      {vertical.map((left) => (
        <span
          key={`v-${left}`}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left,
            width: 1,
            background: color,
          }}
        />
      ))}
      {horizontal.map(({ role, top }) => (
        <span
          key={role}
          data-brand-frame-line={role}
          style={{
            position: "absolute",
            right: 0,
            left: 0,
            top,
            height: 1,
            background: color,
          }}
        />
      ))}
    </div>
  );
}

function hexToUnitRgb(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16, (value >> 8) & 255, value & 255].map((channel) =>
    (channel / 255).toFixed(3),
  );
}

function TransparentThermalEdges({
  width,
  height,
  preset,
  palette,
}: {
  width: number;
  height: number;
  preset: BrandTemplatePresetKey;
  palette: BrandTemplatePaletteKey;
}) {
  const tokens = BRAND_TEMPLATE_PALETTES[palette];
  const [red, green, blue] = hexToUnitRgb(tokens.accent);
  const id = `${preset}-${palette}`;
  const filterId = `thermal-to-alpha-${id}`;
  const leftFadeId = `left-fade-${id}`;
  const leftMaskId = `left-mask-${id}`;
  const rightFadeId = `right-fade-${id}`;
  const rightMaskId = `right-mask-${id}`;

  return (
    <svg
      aria-hidden="true"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: "absolute", inset: 0 }}
    >
      <defs>
        <filter id={filterId} colorInterpolationFilters="sRGB">
          <feColorMatrix
            type="matrix"
            values={`0 0 0 0 ${red}
                    0 0 0 0 ${green}
                    0 0 0 0 ${blue}
                    0.2126 0.7152 0.0722 0 0`}
          />
        </filter>
        <linearGradient id={leftFadeId} x1="0" x2="1">
          <stop offset="0" stopColor="white" />
          <stop offset="0.42" stopColor="white" />
          <stop offset="1" stopColor="black" />
        </linearGradient>
        <mask id={leftMaskId}>
          <rect
            width={width * 0.5}
            height={height}
            fill={`url(#${leftFadeId})`}
          />
        </mask>
        <radialGradient id={rightFadeId} cx="82%" cy="84%" r="58%">
          <stop offset="0" stopColor="white" />
          <stop offset="1" stopColor="black" />
        </radialGradient>
        <mask id={rightMaskId}>
          <rect width={width} height={height} fill={`url(#${rightFadeId})`} />
        </mask>
      </defs>
      <image
        href={TEXTURES[0]}
        x={-width * 0.08}
        y={-height * 0.06}
        width={width * 0.62}
        height={height * 1.12}
        preserveAspectRatio="xMidYMid slice"
        filter={`url(#${filterId})`}
        mask={`url(#${leftMaskId})`}
        opacity={0.5}
      />
      <image
        href={TEXTURES[1]}
        x={width * 0.52}
        y={height * 0.22}
        width={width * 0.56}
        height={height * 0.86}
        preserveAspectRatio="xMidYMid slice"
        filter={`url(#${filterId})`}
        mask={`url(#${rightMaskId})`}
        opacity={0.55}
      />
    </svg>
  );
}

export type BrandTemplateCanvasProps = {
  preset: BrandTemplatePresetKey;
  treatment?: BrandTemplateTreatment;
  palette?: BrandTemplatePaletteKey;
  children?: ReactNode;
};

export function BrandTemplateCanvas({
  preset: key,
  treatment = "clean",
  palette = "default",
  children,
}: BrandTemplateCanvasProps) {
  const preset = BRAND_TEMPLATE_PRESETS[key];
  const tokens = BRAND_TEMPLATE_PALETTES[palette];
  const composition = COMPOSITIONS[preset.composition];
  const {
    frameInsetX,
    frameInsetY,
    dividerY,
    safeX,
    safeY,
    safeWidth,
    safeHeight,
  } = getBrandTemplateGeometry(key);
  const rootStyle: CSSProperties = {
    position: "relative",
    width: preset.width,
    height: preset.height,
    overflow: "hidden",
    backgroundColor: preset.transparent ? "transparent" : INK,
    isolation: "isolate",
  };
  const dotSize = Math.max(18, preset.width * 0.018);
  const signatureInset =
    Math.round(Math.min(28, preset.height * 0.05) * 1000) / 1000;
  const signatureRight =
    Math.round((preset.width - safeX - safeWidth + signatureInset) * 1000) /
    1000;
  const signatureBottom =
    Math.round((preset.height - safeY - safeHeight + signatureInset) * 1000) /
    1000;

  return (
    <div
      data-brand-template-canvas={key}
      data-brand-template-ready="true"
      data-composition={preset.composition}
      data-treatment={treatment}
      data-palette={palette}
      style={rootStyle}
    >
      {!preset.transparent && (
        <>
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              maskImage: composition.mask,
              filter: THERMAL_FILTERS[palette],
            }}
          >
            <ThermalLayer strength={composition.strength} textures={TEXTURES} />
            <HalftoneOverlay />
          </div>
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              background: `radial-gradient(70% 55% at ${composition.glowPosition}, ${tokens.glow}66, transparent 72%)`,
            }}
          />
          <div
            aria-hidden="true"
            className="noise"
            style={{ position: "absolute", inset: 0 }}
          />
        </>
      )}

      {preset.transparent && (
        <TransparentThermalEdges
          width={preset.width}
          height={preset.height}
          preset={key}
          palette={palette}
        />
      )}

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
      <Frame
        width={preset.width}
        height={preset.height}
        insetX={frameInsetX}
        insetY={frameInsetY}
        dividerY={dividerY}
        transparent={preset.transparent}
        accent={tokens.accent}
      />
      <div
        aria-hidden="true"
        data-safe-area="true"
        style={{
          position: "absolute",
          left: safeX,
          top: safeY,
          width: safeWidth,
          height: safeHeight,
        }}
      />
      {treatment === "signed" && (
        <span
          data-brand-signature="true"
          style={{
            position: "absolute",
            right: signatureRight,
            bottom: signatureBottom,
            color: `${tokens.hot}99`,
            fontFamily: "var(--font-geist-mono), monospace",
            fontSize: Math.max(11, Math.min(18, preset.height * 0.025)),
            letterSpacing: "0.08em",
            lineHeight: 1,
          }}
        >
          hogsend.com
        </span>
      )}
      {children}
    </div>
  );
}
