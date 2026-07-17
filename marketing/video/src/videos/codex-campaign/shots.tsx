import type React from "react";
import {
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from "../../fonts";
import { useFormat } from "../../lib/format";
import { theme, typo } from "../../lib/theme";
import type { CampaignShot, ProductAsset } from "./edit";
import { directionalOffset, snapZoom } from "./motion";

const PRODUCT_FILES: Record<ProductAsset, string> = {
  overview: "images/studio/overview.png",
  journeys: "images/studio/journeys.png",
  contacts: "images/studio/contacts.png",
  campaigns: "images/studio/campaigns.png",
  sends: "images/studio/sends.png",
};

const ProductImage: React.FC<{
  asset: ProductAsset;
  objectPosition?: string;
  style?: React.CSSProperties;
}> = ({ asset, objectPosition = "50% 50%", style }) => (
  <Img
    src={staticFile(PRODUCT_FILES[asset])}
    style={{
      width: "100%",
      height: "100%",
      objectFit: "cover",
      objectPosition,
      ...style,
    }}
  />
);

const ImpactShot: React.FC<{ shot: CampaignShot }> = ({ shot }) => {
  const frame = useCurrentFrame();
  const f = useFormat();
  const duration = shot.to - shot.from;
  const isPromise = shot.id === "promise";
  const entry = directionalOffset(frame, Math.min(7, duration - 1), -1, 90);
  const scale = interpolate(frame, [0, Math.min(9, duration - 1)], [1.18, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: f.isPortrait ? "-30%" : "-14%",
          top: "8%",
          width: "120%",
          height: "72%",
          background:
            "linear-gradient(105deg, transparent 12%, rgba(246,72,56,0.3) 48%, transparent 75%)",
          transform: `translateX(${entry * -0.65}px) skewX(-14deg)`,
          mixBlendMode: "screen",
        }}
      />
      <div
        style={{
          maxWidth: "100%",
          color: theme.text,
          fontFamily: FONT_DISPLAY,
          fontSize: isPromise
            ? Math.round((f.isPortrait ? 120 : 116) * f.fontScale)
            : Math.round(
                (shot.copy.length >= 9
                  ? f.isPortrait
                    ? 170
                    : 205
                  : f.isPortrait
                    ? 210
                    : 240) * f.fontScale,
              ),
          fontWeight: 500,
          lineHeight: isPromise ? 0.98 : 0.82,
          letterSpacing: isPromise ? typo.tracking : "-0.075em",
          textAlign: "center",
          textTransform: isPromise ? "none" : "uppercase",
          textWrap: "balance",
          transform: `translateX(${entry}px) scale(${scale})`,
          textShadow: "0 14px 70px rgba(0,0,0,0.8)",
        }}
      >
        {shot.copy}
      </div>
      <div
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          color: theme.textFaint,
          fontFamily: FONT_MONO,
          fontSize: Math.max(11, Math.round(16 * f.fontScale)),
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {String(shot.from / 30).padStart(4, "0")} · kinetic overdrive
      </div>
    </div>
  );
};

const PromptShot: React.FC<{ shot: CampaignShot }> = ({ shot }) => {
  const frame = useCurrentFrame();
  const f = useFormat();
  const prompt = 'codex "follow up when trials stall"';
  const visible = Math.max(0, Math.min(prompt.length, Math.floor(frame * 2.4)));
  const cursor = frame % 8 < 4;

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 18 * f.fontScale,
      }}
    >
      <div
        style={{
          color: theme.accent,
          fontFamily: FONT_BODY,
          fontSize: Math.round((f.isPortrait ? 38 : 32) * f.fontScale),
          letterSpacing: typo.tracking,
        }}
      >
        {shot.copy}
      </div>
      <div
        style={{
          border: `1px solid ${theme.hairline}`,
          borderRadius: 10 * f.fontScale,
          background: "rgba(5,1,1,0.9)",
          padding: `${26 * f.fontScale}px ${30 * f.fontScale}px`,
          boxShadow: "0 28px 90px rgba(0,0,0,0.62)",
          fontFamily: FONT_MONO,
          fontSize: Math.round((f.isPortrait ? 38 : 34) * f.fontScale),
          color: theme.text,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <span style={{ color: theme.accent }}>❯ </span>
        {prompt.slice(0, visible)}
        <span style={{ opacity: cursor ? 1 : 0, color: theme.accent }}>▌</span>
      </div>
    </div>
  );
};

const ProofShot: React.FC<{ shot: CampaignShot }> = ({ shot }) => {
  const frame = useCurrentFrame();
  const f = useFormat();
  const isBuild = shot.id === "builds";
  const rows = isBuild
    ? [
        "src/journeys/trial-follow-up.ts",
        "+ trigger: trial.stalled",
        "+ send: welcome-nudge",
      ]
    : [
        "✓ new trial",
        "✓ active customer",
        "✓ returning customer",
        "12 scenarios passed",
      ];

  return (
    <div
      style={{
        width: "100%",
        display: "grid",
        gridTemplateColumns: f.isPortrait ? "1fr" : "0.42fr 1fr",
        alignItems: "center",
        gap: 30 * f.fontScale,
      }}
    >
      <div
        style={{
          color: theme.text,
          fontFamily: FONT_DISPLAY,
          fontSize: Math.round((f.isPortrait ? 168 : 148) * f.fontScale),
          fontWeight: 500,
          lineHeight: 0.86,
          letterSpacing: "-0.07em",
        }}
      >
        {shot.copy}
      </div>
      <div
        style={{
          border: `1px solid ${isBuild ? theme.cardBorder : "rgba(70,220,150,0.28)"}`,
          borderRadius: 10 * f.fontScale,
          background: "rgba(5,1,1,0.88)",
          overflow: "hidden",
          boxShadow: "0 22px 70px rgba(0,0,0,0.55)",
        }}
      >
        {rows.map((row, index) => {
          const progress = interpolate(
            frame,
            [index * 3, index * 3 + 5],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          );
          return (
            <div
              key={row}
              style={{
                padding: `${12 * f.fontScale}px ${18 * f.fontScale}px`,
                borderTop:
                  index === 0 ? undefined : `1px solid ${theme.hairlineFaint}`,
                color:
                  !isBuild || index > 0 ? "rgba(92,225,168,0.92)" : theme.text,
                fontFamily: FONT_MONO,
                fontSize: Math.round(18 * f.fontScale),
                opacity: progress,
                transform: `translateX(${(1 - progress) * 28}px)`,
              }}
            >
              {row}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ProductShot: React.FC<{ shot: CampaignShot; index: number }> = ({
  shot,
  index,
}) => {
  const frame = useCurrentFrame();
  const f = useFormat();
  const duration = shot.to - shot.from;
  const direction = index % 2 === 0 ? -1 : 1;
  const focus = shot.focus ?? { x: 50, y: 50, zoom: 1.2 };
  const portraitZoom = f.isPortrait ? Math.max(focus.zoom, 1.7) : focus.zoom;
  const scale = snapZoom(frame, Math.max(8, duration - 3), portraitZoom);
  const offset = directionalOffset(frame, 7, direction, 42);
  const isHookProduct = shot.id === "by-hand";

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        border: `1px solid ${theme.hairline}`,
        borderRadius: 12 * f.fontScale,
        overflow: "hidden",
        background: theme.paperPure,
        boxShadow: "0 30px 110px rgba(0,0,0,0.62)",
      }}
    >
      <ProductImage
        asset={shot.asset ?? "overview"}
        objectPosition={`${focus.x}% ${focus.y}%`}
        style={{
          transform: `translateX(${offset}px) scale(${scale})`,
          transformOrigin: `${focus.x}% ${focus.y}%`,
          filter: `saturate(${isHookProduct ? 0.4 : 0.82}) contrast(1.08) brightness(${isHookProduct ? 0.58 : 0.75})`,
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(90deg, rgba(5,1,1,0.72), transparent 48%), linear-gradient(0deg, rgba(5,1,1,0.82), transparent 56%)",
        }}
      />
      {isHookProduct ? (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: "-8%",
            top: "44%",
            width: "116%",
            height: Math.max(9, 16 * f.fontScale),
            background: theme.accent,
            transform: `rotate(-5deg) translateX(${directionalOffset(frame, 5, 1, 220)}px)`,
            boxShadow: "0 0 38px rgba(246,72,56,0.72)",
          }}
        />
      ) : null}
      <div
        style={{
          position: "absolute",
          left: 26 * f.fontScale,
          right: 26 * f.fontScale,
          bottom: 24 * f.fontScale,
          color: theme.text,
          fontFamily: FONT_DISPLAY,
          fontSize: Math.round(
            (shot.copy.length > 15
              ? f.isPortrait
                ? 64
                : 52
              : f.isPortrait
                ? 94
                : 82) * f.fontScale,
          ),
          fontWeight: 500,
          lineHeight: 0.92,
          letterSpacing: "-0.055em",
          textTransform:
            shot.copy === shot.copy.toUpperCase() ? "uppercase" : undefined,
          textShadow: "0 7px 34px rgba(0,0,0,0.95)",
        }}
      >
        {shot.copy}
      </div>
      <div
        style={{
          position: "absolute",
          top: 18 * f.fontScale,
          right: 20 * f.fontScale,
          border: `1px solid ${theme.pillBorder}`,
          borderRadius: 999,
          padding: `${7 * f.fontScale}px ${11 * f.fontScale}px`,
          background: "rgba(5,1,1,0.72)",
          color: theme.textMuted,
          fontFamily: FONT_MONO,
          fontSize: Math.round(13 * f.fontScale),
          letterSpacing: "0.07em",
          textTransform: "uppercase",
        }}
      >
        Hogsend Studio
      </div>
    </div>
  );
};

const STACK_ASSETS: ProductAsset[] = [
  "overview",
  "journeys",
  "campaigns",
  "sends",
];

const ProductStackShot: React.FC<{ shot: CampaignShot }> = ({ shot }) => {
  const frame = useCurrentFrame();
  const f = useFormat();

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {STACK_ASSETS.map((asset, index) => {
        const progress = interpolate(
          frame,
          [index * 2, index * 2 + 8],
          [0, 1],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          },
        );
        const spread = (index - 1.5) * (f.isPortrait ? 13 : 9);
        return (
          <div
            key={asset}
            style={{
              position: "absolute",
              left: `${7 + index * 3}%`,
              top: `${8 + index * 5}%`,
              width: `${82 - index * 3}%`,
              height: `${68 - index * 2}%`,
              border: `1px solid ${theme.hairline}`,
              borderRadius: 10 * f.fontScale,
              overflow: "hidden",
              background: theme.paperPure,
              boxShadow: "0 22px 80px rgba(0,0,0,0.72)",
              opacity: progress,
              transform: `translateY(${(1 - progress) * 90}px) rotate(${spread * progress}deg)`,
            }}
          >
            <ProductImage asset={asset} />
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: "4%",
          color: theme.text,
          fontFamily: FONT_DISPLAY,
          fontSize: Math.round((f.isPortrait ? 68 : 86) * f.fontScale),
          fontWeight: 500,
          lineHeight: 0.9,
          letterSpacing: "-0.065em",
          textAlign: "center",
          textShadow: "0 9px 40px #000",
        }}
      >
        {shot.copy}
      </div>
    </div>
  );
};

const CtaShot: React.FC<{ shot: CampaignShot }> = ({ shot }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const settle = interpolate(frame, [0, Math.min(10, fps / 3)], [1.08, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24 * f.fontScale,
        textAlign: "center",
        transform: `scale(${settle})`,
      }}
    >
      <div
        style={{
          color: theme.textMuted,
          fontFamily: FONT_BODY,
          fontSize: Math.round(25 * f.fontScale),
          letterSpacing: typo.tracking,
        }}
      >
        Build with Hogsend.
      </div>
      <div
        style={{
          color: theme.text,
          fontFamily: FONT_DISPLAY,
          fontSize: Math.round((f.isPortrait ? 142 : 146) * f.fontScale),
          fontWeight: 500,
          lineHeight: 0.88,
          letterSpacing: "-0.07em",
        }}
      >
        {shot.copy}
      </div>
      <div
        style={{
          border: `1px solid ${theme.cardBorder}`,
          borderRadius: 8 * f.fontScale,
          padding: `${11 * f.fontScale}px ${18 * f.fontScale}px`,
          background: "rgba(5,1,1,0.72)",
          color: theme.textMuted,
          fontFamily: FONT_MONO,
          fontSize: Math.round(16 * f.fontScale),
        }}
      >
        <span style={{ color: theme.accent }}>❯ </span>
        pnpm dlx create-hogsend@latest
      </div>
    </div>
  );
};

export const KineticShot: React.FC<{
  shot: CampaignShot;
  index: number;
}> = ({ shot, index }) => {
  switch (shot.kind) {
    case "impact":
      return <ImpactShot shot={shot} />;
    case "prompt":
      return <PromptShot shot={shot} />;
    case "proof":
      return <ProofShot shot={shot} />;
    case "product":
      return <ProductShot shot={shot} index={index} />;
    case "stack":
      return <ProductStackShot shot={shot} />;
    case "cta":
      return <CtaShot shot={shot} />;
  }
};
