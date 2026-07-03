/**
 * Small brand-marked chips for the "send to an LLM" buttons — an original,
 * minimal glyph on each service's brand colour (not a copy of a proprietary
 * vector), paired with the service name on the button so it's unambiguous.
 * 18px, decorative (aria-hidden); the button carries the accessible label.
 */

function Chip({
  bg,
  label,
  children,
}: {
  bg: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px]"
      style={{ background: bg }}
    >
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" role="img">
        <title>{label}</title>
        {children}
      </svg>
    </span>
  );
}

/** Claude — a radial sunburst, in Anthropic's clay. */
export function ClaudeMark() {
  const rays = Array.from({ length: 12 }, (_, i) => {
    const a = (i * Math.PI) / 6;
    const cx = 12;
    const cy = 12;
    return (
      <line
        key={a}
        x1={cx + Math.cos(a) * 3}
        y1={cy + Math.sin(a) * 3}
        x2={cx + Math.cos(a) * 9}
        y2={cy + Math.sin(a) * 9}
        stroke="white"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    );
  });
  return (
    <Chip bg="#D97757" label="Claude">
      {rays}
    </Chip>
  );
}

/** ChatGPT — a stroked hexafoil ring, on near-black. */
export function ChatGptMark() {
  return (
    <Chip bg="#0D0D0D" label="ChatGPT">
      <path
        d="M12 4.2c2 0 3.4 1.2 3.9 2.9 1.7.2 3 1.6 3 3.5 0 1-.4 1.9-1.1 2.5.3 1.7-.6 3.4-2.3 4-1 1.4-2.9 1.8-4.4 1-1.5.8-3.4.4-4.4-1-1.7-.6-2.6-2.3-2.3-4C7 14.5 6.6 13.6 6.6 12.6c0-1.9 1.3-3.3 3-3.5C10.1 7.4 11.5 6.2 13.5 6.2"
        stroke="white"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </Chip>
  );
}

/** Perplexity — overlapping angular strokes, on teal. */
export function PerplexityMark() {
  return (
    <Chip bg="#20808D" label="Perplexity">
      <g stroke="white" strokeWidth="1.7" strokeLinecap="round">
        <path d="M12 5v14" />
        <path d="M12 8.5 6.5 5v7.5H12" />
        <path d="M12 8.5 17.5 5v7.5H12" />
        <path d="M6.5 12.5 12 16l5.5-3.5" />
      </g>
    </Chip>
  );
}
