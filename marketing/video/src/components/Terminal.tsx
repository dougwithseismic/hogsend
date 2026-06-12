import type React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_MONO } from "../fonts";
import { pop } from "../lib/anim";
import { useFormat } from "../lib/format";
import { theme } from "../lib/theme";
import { charsVisible, typingDuration } from "../lib/typewriter";
import { CardChrome } from "./CardChrome";

export type TerminalLine = {
  text: string;
  /**
   * - "line": plain output
   * - "task": spinner for `spin` frames, then an accent ✓ tick
   * - "file": file-tree row (use `indent`)
   * - "muted": dimmed output
   */
  kind?: "line" | "task" | "file" | "muted";
  indent?: number;
  /** Frames the spinner spins before ticking (task lines, default 16). */
  spin?: number;
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Terminal card matching CodeScene chrome. Types `command` after the
 * prompt, then reveals `output` lines one by one (spinner→tick tasks,
 * indented file trees).
 *
 *   <Terminal
 *     command="pnpm dlx create-hogsend@latest"
 *     output={[
 *       { text: "Scaffolding hogsend app", kind: "task" },
 *       { text: "src/journeys/welcome.ts", kind: "file", indent: 1 },
 *     ]}
 *   />
 */
export const Terminal: React.FC<{
  command: string;
  output?: TerminalLine[];
  /** Ticks per frame for the command typing. Default 1.6. */
  typeSpeed?: number;
  startDelay?: number;
  /** Frames between output lines appearing. Default 7. */
  lineStagger?: number;
  width?: number | string;
  fontSize?: number;
  title?: string;
}> = ({
  command,
  output = [],
  typeSpeed = 1.6,
  startDelay = 0,
  lineStagger = 7,
  width,
  fontSize,
  title = "zsh — hogsend",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();

  const size =
    fontSize ?? Math.round(26 * f.fontScale * (f.isPortrait ? 1.15 : 1));
  const typed = charsVisible(command, frame, typeSpeed, startDelay);
  const commandDone = typingDuration(command, typeSpeed, startDelay);
  const outputStart = commandDone + 6;
  const cursorOn = Math.floor(frame / 16) % 2 === 0;

  return (
    <CardChrome
      title={title}
      width={width ?? (f.isPortrait ? "100%" : Math.min(f.width * 0.58, 1000))}
      scale={f.fontScale}
    >
      <div
        style={{
          padding: `${Math.round(size * 1.1)}px ${Math.round(size * 1.3)}px`,
          fontFamily: FONT_MONO,
          fontSize: size,
          lineHeight: 1.75,
          whiteSpace: "pre",
          color: theme.text,
        }}
      >
        <div>
          <span style={{ color: theme.accent }}>❯ </span>
          <span>{command.slice(0, typed)}</span>
          {frame < outputStart || cursorOn ? (
            <span
              style={{
                display: "inline-block",
                width: size * 0.55,
                height: size * 1.15,
                verticalAlign: "text-bottom",
                backgroundColor:
                  frame < commandDone ? theme.text : theme.textMuted,
                marginLeft: 2,
              }}
            />
          ) : null}
        </div>
        {output.map((line, i) => {
          const appearAt = outputStart + i * lineStagger;
          if (frame < appearAt) return null;
          const local = frame - appearAt;
          const rise = pop(local, fps);
          const kind = line.kind ?? "line";
          const spin = line.spin ?? 16;
          const ticked = kind !== "task" || local >= spin;
          const glyph =
            kind === "task"
              ? ticked
                ? "✓"
                : SPINNER[Math.floor(local / 3) % SPINNER.length]
              : kind === "file"
                ? "└ "
                : "";
          return (
            <div
              key={`${line.text}-${
                // biome-ignore lint/suspicious/noArrayIndexKey: static
                i
              }`}
              style={{
                opacity: rise,
                paddingLeft: (line.indent ?? 0) * size * 1.2,
                color:
                  kind === "muted" || kind === "file"
                    ? theme.textMuted
                    : theme.text,
              }}
            >
              {kind === "task" ? (
                <span
                  style={{
                    color: ticked ? theme.accent : theme.textMuted,
                  }}
                >
                  {glyph}{" "}
                </span>
              ) : (
                <span style={{ color: theme.textMuted }}>{glyph}</span>
              )}
              {line.text}
            </div>
          );
        })}
      </div>
    </CardChrome>
  );
};
