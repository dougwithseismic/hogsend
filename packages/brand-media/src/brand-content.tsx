import type { CSSProperties } from "react";
import type { BrandTemplateContent } from "./content";
import {
  BRAND_TEMPLATE_PALETTES,
  BRAND_TEMPLATE_PRESETS,
  type BrandTemplatePaletteKey,
  type BrandTemplatePresetKey,
  getBrandTemplateGeometry,
} from "./presets";

export type BrandContentProps = {
  preset: BrandTemplatePresetKey;
  palette: BrandTemplatePaletteKey;
  content: BrandTemplateContent;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function BrandContent({
  preset: presetKey,
  palette: paletteKey,
  content,
}: BrandContentProps) {
  const preset = BRAND_TEMPLATE_PRESETS[presetKey];
  const palette = BRAND_TEMPLATE_PALETTES[paletteKey];
  const geometry = getBrandTemplateGeometry(presetKey);
  const shortEdge = Math.min(preset.width, preset.height);
  const compact =
    content.headline.length > 40 ||
    content.body.length > 80 ||
    Boolean(content.command);
  const headlineSize = clamp(
    shortEdge * (compact ? 0.064 : 0.09),
    38,
    compact ? 76 : 90,
  );
  const bodySize = clamp(shortEdge * (compact ? 0.026 : 0.032), 17, 30);
  const monoSize = clamp(shortEdge * 0.021, 12, 18);
  const gap = clamp(shortEdge * (compact ? 0.022 : 0.025), 14, 30);
  const pad = clamp(shortEdge * 0.024, 14, 28);
  const safeAreaStyle: CSSProperties = {
    position: "absolute",
    zIndex: 10,
    left: geometry.safeX,
    top: geometry.contentY,
    width: geometry.safeWidth,
    height: geometry.contentHeight,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    gap,
    padding: pad,
    overflow: "hidden",
    color: "#fff",
  };
  const mono: CSSProperties = {
    fontFamily: "var(--font-mono), monospace",
    fontSize: monoSize,
    lineHeight: 1.2,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  };

  return (
    <section
      data-brand-content="true"
      data-content-chamber="upper"
      data-content-layout={content.layout}
      data-copy-density={compact ? "compact" : "regular"}
      style={safeAreaStyle}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap,
          color: palette.hot,
          ...mono,
        }}
      >
        <span
          style={{
            border: `1px solid ${palette.accent}66`,
            borderRadius: 999,
            padding: `${Math.max(5, monoSize * 0.45)}px ${Math.max(9, monoSize * 0.75)}px`,
            background: `${palette.glow}44`,
          }}
        >
          {content.eyebrow}
        </span>
        {content.sequence && <span>{content.sequence}</span>}
      </header>

      <div
        data-brand-content-body="true"
        style={{
          display: "flex",
          flex: 1,
          minHeight: 0,
          flexDirection: "column",
          justifyContent: "center",
          gap,
          maxWidth: "92%",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontFamily: "var(--font-sans), Inter, sans-serif",
            fontSize: headlineSize,
            fontWeight: 500,
            letterSpacing: "-0.045em",
            lineHeight: compact ? 1.02 : 1.06,
            textWrap: "balance",
          }}
        >
          {content.headline}
        </h1>
        <p
          style={{
            margin: 0,
            maxWidth: "92%",
            color: "rgba(255,255,255,0.68)",
            fontFamily: "var(--font-sans), Inter, sans-serif",
            fontSize: bodySize,
            letterSpacing: "-0.018em",
            lineHeight: 1.35,
          }}
        >
          {content.body}
        </p>
        {content.steps && (
          <ol
            style={{
              display: "grid",
              gap: Math.max(7, gap * 0.4),
              margin: 0,
              padding: 0,
              listStyle: "none",
            }}
          >
            {content.steps.map((step, index) => (
              <li
                key={step}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: Math.max(8, gap * 0.45),
                  color: index === 1 ? "#fff" : "rgba(255,255,255,0.68)",
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: clamp(bodySize * 0.72, 13, 20),
                  lineHeight: 1.25,
                }}
              >
                <span style={{ color: palette.accent }}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                {step}
              </li>
            ))}
          </ol>
        )}
        {content.command && (
          <div
            data-brand-command="true"
            style={{
              maxWidth: "100%",
              boxSizing: "border-box",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: clamp(shortEdge * 0.012, 8, 14),
              padding: `${Math.max(9, gap * 0.45)}px ${Math.max(12, gap * 0.65)}px`,
              overflow: "hidden",
              color: "rgba(255,255,255,0.78)",
              background: "rgba(4,1,1,0.72)",
              fontFamily: "var(--font-mono), monospace",
              fontSize: clamp(bodySize * 0.64, 12, 18),
              lineHeight: 1.3,
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
            }}
          >
            <span style={{ color: palette.accent }}>$ </span>
            {content.command}
          </div>
        )}
      </div>

      <footer
        data-brand-content-footer="true"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          color: "rgba(255,255,255,0.55)",
          ...mono,
        }}
      >
        <span>{content.signature}</span>
        <span style={{ color: palette.accent }}>→</span>
      </footer>
    </section>
  );
}
