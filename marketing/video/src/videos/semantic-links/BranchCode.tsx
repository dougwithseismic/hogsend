import type React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { CardChrome } from "../../components/CardChrome";
import { FONT_MONO } from "../../fonts";
import { SPRING_SNAPPY } from "../../lib/anim";
import { type TokenKind, tokenize } from "../../lib/code-tokenizer";
import { useFormat } from "../../lib/format";
import { syntax, theme } from "../../lib/theme";

/**
 * Beat 4 (frames 180–239): SNIPPET SL-1 fully present on a hard cut.
 * A highlight sweep crosses the `if` line, then the `sendEmail` line
 * pulses once. Code is real — the ctx.waitForEvent → properties pattern.
 */

const CODE = `const answer = await ctx.waitForEvent({
  event: "onboarding.call_answered",
  timeout: days(3),
});
if (answer.properties?.answer === ⟦"yes"⟧) {
  await sendEmail({ template: "booking-link" });
}`;

const IF_LINE = 4;
const SEND_LINE = 5;
const SWEEP_START = 8;

const colorFor = (kind: TokenKind, emphasis: boolean): string =>
  emphasis ? syntax.emphasis : syntax[kind === "plain" ? "base" : kind];

export const BranchCode: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();

  const size = Math.round(26 * f.fontScale * (f.isPortrait ? 1.15 : 1));
  const lines = tokenize(CODE);

  // Sweep crosses the `if` line, holds, then yields to the pulse.
  const sweep = spring({
    frame: frame - SWEEP_START,
    fps,
    config: SPRING_SNAPPY,
    durationInFrames: 16,
  });
  const sweepFade = interpolate(frame, [34, 46], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // The sendEmail line pulses once.
  const pulse = interpolate(frame, [38, 46, 58], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const highlightBase = {
    position: "absolute",
    top: size * 0.08,
    bottom: size * 0.08,
    left: -size * 0.55,
    right: -size * 0.55,
    borderRadius: 6,
    pointerEvents: "none",
  } as const;

  return (
    <CardChrome
      title="src/journeys/onboarding.ts"
      width={f.isPortrait ? "100%" : f.ratio === "11" ? 660 : 880}
      scale={f.fontScale}
    >
      <div
        style={{
          padding: `${Math.round(size * 1.1)}px ${Math.round(size * 1.3)}px`,
          fontFamily: FONT_MONO,
          fontSize: size,
          fontWeight: 400,
          lineHeight: 1.7,
          whiteSpace: "pre",
          color: syntax.base,
        }}
      >
        {lines.map((line, li) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static code
            key={`l-${li}`}
            style={{ minHeight: size * 1.7, position: "relative" }}
          >
            {li === IF_LINE ? (
              <div
                style={{
                  ...highlightBase,
                  backgroundColor: theme.accentTint,
                  borderLeft: `3px solid ${theme.accent}`,
                  opacity: sweepFade,
                  transform: `scaleX(${sweep})`,
                  transformOrigin: "left center",
                }}
              />
            ) : null}
            {li === SEND_LINE ? (
              <div
                style={{
                  ...highlightBase,
                  backgroundColor: theme.accentTint,
                  opacity: pulse,
                }}
              />
            ) : null}
            <span style={{ position: "relative" }}>
              {line.map((token, ti) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: static code
                  key={`${li}-${ti}`}
                  style={{ color: colorFor(token.kind, token.emphasis) }}
                >
                  {token.text}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </CardChrome>
  );
};
