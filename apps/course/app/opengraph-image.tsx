import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Hogsend Courses — Build your growth in code";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Static brand card, crimzon-styled — mirrors apps/docs/app/opengraph-image.tsx
 * (near-black #050101 canvas, a red #F64838 planet-horizon glow, white Inter
 * wordmark + headline). Fonts are vendored TTFs read from disk at build time
 * (the route is static, so the fs read only runs during prerender).
 */
const ogFont = (file: string) =>
  readFile(join(process.cwd(), "lib/fonts/og", file));

export default async function OpengraphImage() {
  const [interMedium, interRegular] = await Promise.all([
    ogFont("Inter-Medium.ttf"),
    ogFont("Inter-Regular.ttf"),
  ]);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: "#050101",
        padding: "72px 80px",
        fontFamily: "Inter",
        position: "relative",
      }}
    >
      {/* Red planet-horizon glow rising from the bottom edge. */}
      <div
        style={{
          position: "absolute",
          left: -200,
          right: -200,
          bottom: -560,
          height: 800,
          borderRadius: 9999,
          background:
            "radial-gradient(circle at 50% 0%, rgba(246,72,56,0.55) 0%, rgba(246,72,56,0.18) 38%, rgba(5,1,1,0) 68%)",
          display: "flex",
        }}
      />
      {/* Hairline frame echo: left + right verticals. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 48,
          width: 1,
          backgroundColor: "rgba(255,255,255,0.16)",
          display: "flex",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: 48,
          width: 1,
          backgroundColor: "rgba(255,255,255,0.16)",
          display: "flex",
        }}
      />

      {/* Brand lockup */}
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 52,
            height: 52,
            borderRadius: 12,
            backgroundColor: "#F64838",
          }}
        >
          {/* Minimal "send" glyph */}
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path d="M3.5 12 20 4.5 14 20l-3.2-6.4L3.5 12Z" fill="#050101" />
          </svg>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 34,
            fontWeight: 500,
            color: "#ffffff",
            letterSpacing: "-0.02em",
          }}
        >
          Hogsend Courses
        </div>
      </div>

      {/* Headline */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 28,
          maxWidth: 1040,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 72,
            fontWeight: 500,
            lineHeight: 1.04,
            letterSpacing: "-0.05em",
            color: "#ffffff",
          }}
        >
          <span>Build your growth</span>
          <span>in code</span>
        </div>
      </div>

      {/* Footer micro line */}
      <div
        style={{
          display: "flex",
          fontSize: 22,
          fontWeight: 400,
          letterSpacing: "0.08em",
          color: "#F64838",
        }}
      >
        POSTHOG · LIFECYCLE MESSAGING · AUDIENCE YOU OWN · FREE TO START
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Inter", data: interMedium, weight: 500, style: "normal" },
        { name: "Inter", data: interRegular, weight: 400, style: "normal" },
      ],
    },
  );
}
