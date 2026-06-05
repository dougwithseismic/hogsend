import { ImageResponse } from "next/og";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";

export const alt = `${SITE_NAME} — ${SITE_TAGLINE}`;

// Resolve an EB Garamond .ttf URL from the Google Fonts CSS endpoint at runtime,
// then fetch the binary. Wrapped so a network/parse failure never throws — the
// OG image just renders with the platform default serif instead.
async function loadGaramond(): Promise<ArrayBuffer | null> {
  try {
    const cssUrl =
      "https://fonts.googleapis.com/css2?family=EB+Garamond:wght@500&display=swap";
    const cssRes = await fetch(cssUrl, {
      // A non-modern UA makes Google return a .ttf src (not woff2), which
      // satori/@vercel/og can parse.
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_6_8) AppleWebKit/535.1",
      },
    });
    if (!cssRes.ok) return null;

    const css = await cssRes.text();
    const match = css.match(/src:\s*url\((https:\/\/[^)]+\.ttf)\)/);
    const fontUrl = match?.[1];
    if (!fontUrl) return null;

    const fontRes = await fetch(fontUrl);
    if (!fontRes.ok) return null;

    return await fontRes.arrayBuffer();
  } catch {
    return null;
  }
}

export default async function Image() {
  const garamond = await loadGaramond();

  const serifStack =
    '"EB Garamond", "Iowan Old Style", "Apple Garamond", Georgia, "Times New Roman", serif';

  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#fbf3e1",
        padding: "80px",
        position: "relative",
      }}
    >
      {/* berry + grape accent bar */}
      <div
        style={{
          display: "flex",
          gap: "12px",
          marginBottom: "40px",
        }}
      >
        <div
          style={{
            width: "72px",
            height: "12px",
            borderRadius: "9999px",
            backgroundColor: "#e8688f",
          }}
        />
        <div
          style={{
            width: "40px",
            height: "12px",
            borderRadius: "9999px",
            backgroundColor: "#c3a0ee",
          }}
        />
      </div>

      <div
        style={{
          display: "flex",
          fontFamily: serifStack,
          fontSize: "84px",
          lineHeight: 1.05,
          fontWeight: 500,
          color: "#3a2418",
          textAlign: "center",
          maxWidth: "960px",
          letterSpacing: "-0.02em",
        }}
      >
        {SITE_TAGLINE}
      </div>

      <div
        style={{
          display: "flex",
          marginTop: "36px",
          fontSize: "30px",
          color: "#a8385f",
          fontWeight: 600,
          letterSpacing: "0.01em",
        }}
      >
        {SITE_NAME} · PostHog → Resend
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginTop: "48px",
          padding: "16px 28px",
          borderRadius: "9999px",
          backgroundColor: "#3a2418",
          color: "#fbf3e1",
          fontSize: "26px",
          fontFamily:
            'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
        }}
      >
        pnpm dlx create-hogsend@latest
      </div>
    </div>,
    {
      ...size,
      fonts: garamond
        ? [
            {
              name: "EB Garamond",
              data: garamond,
              weight: 500 as const,
              style: "normal" as const,
            },
          ]
        : undefined,
    },
  );
}
