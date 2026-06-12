import type React from "react";

/** Props every video component receives. */
export type VideoProps = {
  /** Persona variant (only meaningful for videos that declare personas). */
  persona?: string;
};

export type VideoConfig = {
  /** Kebab-case id; composition ids are `<id>-169`, `<id>-916`, `<id>-11`. */
  id: string;
  durationInFrames: number;
  fps: 30;
  /** Optional persona variants; defaultProps.persona = "engineer". */
  personas?: string[];
  component: React.ComponentType<VideoProps>;
};

/**
 * The video registration contract. Every video module exports
 * `export const video = defineVideo({ ... })` from
 * src/videos/<id>/index.tsx — see CONVENTIONS.md.
 */
export const defineVideo = (config: VideoConfig): VideoConfig => config;
