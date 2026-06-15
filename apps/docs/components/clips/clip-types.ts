/**
 * Clip spec + step types — ported verbatim from the Remotion
 * journey-trace engine (marketing/video/src/videos/journey-clips/trace.tsx).
 *
 * The journey-trace engine behind every clip: real journey code on one
 * side, the run executing it on the other. Clips are bare — no hooks, no
 * end cards — so they can loop in a landing-page section or doc.
 */

export type ClipStep =
  | { kind: "event"; event: string; who?: string; band: [number, number] }
  | {
      kind: "send";
      subject: string;
      clicked?: boolean;
      accent?: boolean;
      band: [number, number];
    }
  | {
      kind: "sleep";
      label: string;
      /** Show a "day n of N" counter while the bar fills. */
      days?: number;
      band: [number, number];
    }
  | {
      kind: "check";
      question: string;
      sub?: string;
      /** Candidate events looked at (struck unless `found`). */
      candidates?: string[];
      /** Verdict pill text, e.g. `found: true` or `plan: "paid"`. */
      verdict: string;
      band: [number, number];
    }
  | {
      kind: "wait";
      event: string;
      timeout: string;
      /** What arrives, e.g. `score: 9`. */
      resolve: string;
      band: [number, number];
    }
  | { kind: "exit"; event: string; note: string; band: [number, number] }
  | {
      kind: "fanout";
      /** Kind-chip label (default "emit"). */
      label?: string;
      /** Payloads that fly out, in order. */
      events: string[];
      /** Destination name + logo (public/logos). */
      dest?: string;
      logo?: string;
      band: [number, number];
    };

export type ClipSpec = {
  id: string;
  file: string;
  code: string;
  steps: ClipStep[];
};
