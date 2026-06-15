/**
 * Hogsend brand tokens for native marketing clips — ported verbatim from
 * the Remotion theme (marketing/video/src/lib/theme.ts). EXACT values from
 * the apps/docs design system (app/global.css + components/ds). Do not
 * invent new colours; every clip draws from this palette.
 */
export const theme = {
  /** Page background (near-black ink) */
  ink: "#050101",
  /** Card background (code mocks, glass panels) */
  paperPure: "#0a0606",
  /** Glass panel fill — paperPure at 80% (docs mockup.tsx) */
  glass: "rgba(10,6,6,0.8)",
  /** The one red accent */
  accent: "#f64838",
  accentDeep: "#b8281c",
  accentTint: "rgba(246,72,56,0.15)",

  // --- The docs white-opacity ladder -------------------------------------
  /** Page-frame vertical hairlines (docs uses 0.04; video needs a touch
   * more to survive h264) */
  frameLine: "rgba(255,255,255,0.07)",
  /** Card borders / dividers — `border-white/[0.08]` */
  hairlineFaint: "rgba(255,255,255,0.08)",
  /** Glass-panel + code-mock borders — `border-white/10` */
  cardBorder: "rgba(255,255,255,0.1)",
  /** Hover/active borders, traffic-light dots — `white/15` */
  hairline: "rgba(255,255,255,0.15)",
  /** Pill-badge borders — `white/20` */
  pillBorder: "rgba(255,255,255,0.2)",
  /** Card fill — `bg-white/[0.015]` (nearly invisible, adds structure) */
  cardFill: "rgba(255,255,255,0.015)",
  /** Chip fill — `bg-white/[0.02]` */
  chipFill: "rgba(255,255,255,0.02)",
  /** Icon-slot / agent-bubble fill — `bg-white/[0.04]` */
  slotFill: "rgba(255,255,255,0.04)",
  /** Neutral tag-pill fill — `bg-white/[0.06]` */
  tagFill: "rgba(255,255,255,0.06)",

  // --- Text ---------------------------------------------------------------
  text: "#ffffff",
  /** Body copy — `text-white/80` */
  textBody: "rgba(255,255,255,0.8)",
  /** Secondary copy — `text-white/60` */
  textMuted: "rgba(255,255,255,0.6)",
  /** Eyebrows, footer small print — `text-white/50` */
  textFaint: "rgba(255,255,255,0.5)",
  /** Hints, chrome filenames — `text-white/40` */
  textHint: "rgba(255,255,255,0.4)",
  /** Ghost numbers — `text-white/20` */
  textGhost: "rgba(255,255,255,0.2)",
} as const;

/**
 * Type metrics from the docs site. Letter-spacing is the signature: hero
 * −0.06em, everything else −0.02em.
 */
export const typo = {
  /** Hero / KineticText xl — Inter Display 500 */
  heroTracking: "-0.055em",
  /** Section headings / body — global `-0.02em` */
  tracking: "-0.02em",
  /** Eyebrow labels — uppercase, `0.04em` at 12px (wider reads better
   * at video sizes) */
  eyebrowTracking: "0.08em",
} as const;

/**
 * Syntax palette for the code panel — the EXACT github-dark Shiki colours
 * the site's code blocks render with (sampled from hogsend.com), plus the
 * accent for the single author-marked ⟦emphasis⟧ range.
 */
export const syntax = {
  base: "#e1e4e8",
  keyword: "#f97583",
  string: "#9ecbff",
  func: "#b392f0",
  number: "#79b8ff",
  comment: "#6a737d",
  punctuation: "#e1e4e8",
  property: "#e1e4e8",
  emphasis: theme.accent,
} as const;
