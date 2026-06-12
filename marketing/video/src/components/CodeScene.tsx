import type React from "react";
import { useCurrentFrame } from "remotion";
import { FONT_MONO } from "../fonts";
import { type TokenKind, tokenize } from "../lib/code-tokenizer";
import { useFormat } from "../lib/format";
import { syntax, theme } from "../lib/theme";
import { charsVisible, typingDuration } from "../lib/typewriter";
import { CardChrome } from "./CardChrome";

const colorFor = (kind: TokenKind, emphasis: boolean): string => {
  if (emphasis) return syntax.emphasis;
  return syntax[kind === "plain" ? "base" : kind];
};

/**
 * Editor card that TYPES pre-tokenized TypeScript with a block cursor.
 * Deterministic tokenizer (no shiki), variable speed with micro-pauses
 * at line ends. Wrap ONE range of the snippet in ⟦…⟧ to render it in
 * the accent colour.
 *
 *   <CodeScene
 *     filename="src/journeys/welcome.ts"
 *     code={`await ctx.sleep({ duration: ⟦days(2)⟧ });`}
 *   />
 *
 * Sizing tip: pair with `typingDuration(code)` from lib/typewriter to
 * size the surrounding beat.
 */
export const CodeScene: React.FC<{
  code: string;
  filename?: string;
  /** Ticks per frame (≈ chars/frame). Default 2.4. */
  typeSpeed?: number;
  /** Frames before typing starts. */
  startDelay?: number;
  /** Render fully typed (no typewriter). */
  instant?: boolean;
  /** Rendered below the code behind a hairline divider (status rows). */
  footer?: React.ReactNode;
  width?: number | string;
  fontSize?: number;
}> = ({
  code,
  filename,
  typeSpeed = 2.4,
  startDelay = 0,
  instant = false,
  footer,
  width,
  fontSize,
}) => {
  const frame = useCurrentFrame();
  const f = useFormat();

  // Strip emphasis markers for typing math; tokenizer re-reads them.
  const plain = code.replaceAll("⟦", "").replaceAll("⟧", "");
  const visible = instant
    ? plain.length
    : charsVisible(plain, frame, typeSpeed, startDelay);
  const doneAt = typingDuration(plain, typeSpeed, startDelay);
  const typingDone = instant || frame >= doneAt;
  // Block cursor: steady while typing, blinks after.
  const cursorOn = !typingDone || Math.floor(frame / 16) % 2 === 0;

  const lines = tokenize(code);
  const size =
    fontSize ?? Math.round(26 * f.fontScale * (f.isPortrait ? 1.15 : 1));

  let consumed = 0;
  return (
    <CardChrome
      title={filename}
      footer={footer}
      width={width ?? (f.isPortrait ? "100%" : Math.min(f.width * 0.62, 1080))}
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
        {lines.map((line, li) => {
          const lineStart = consumed;
          let cursor = lineStart;
          const spans = line.map((token, ti) => {
            const start = cursor;
            cursor += token.text.length;
            const shown = Math.max(
              0,
              Math.min(token.text.length, visible - start),
            );
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: static code
                key={`${li}-${ti}`}
                style={{ color: colorFor(token.kind, token.emphasis) }}
              >
                {token.text.slice(0, shown)}
              </span>
            );
          });
          const lineEnd = cursor;
          consumed = lineEnd + 1; // +1 for the newline char
          const cursorHere =
            !instant &&
            cursorOn &&
            ((visible >= lineStart && visible < lineEnd) ||
              (typingDone && li === lines.length - 1) ||
              (!typingDone && visible >= lineEnd && visible < consumed));
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static code
              key={`l-${li}`}
              style={{ minHeight: size * 1.7 }}
            >
              {spans}
              {cursorHere ? (
                <span
                  style={{
                    display: "inline-block",
                    width: size * 0.55,
                    height: size * 1.15,
                    verticalAlign: "text-bottom",
                    backgroundColor: theme.text,
                    marginLeft: 1,
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </CardChrome>
  );
};
