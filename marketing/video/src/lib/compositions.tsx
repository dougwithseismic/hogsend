import type React from "react";
import { Composition } from "remotion";
// Side-effect: loads all three brand fonts (blocks render until ready)
import "../fonts";
import type { VideoConfig } from "./define-video";

const FORMATS = [
  { suffix: "169", width: 1920, height: 1080 },
  { suffix: "916", width: 1080, height: 1920 },
  { suffix: "11", width: 1080, height: 1080 },
] as const;

/** Registers a video's three Compositions (-169, -916, -11). */
export const VideoCompositions: React.FC<{ video: VideoConfig }> = ({
  video,
}) => {
  const defaultProps = video.personas ? { persona: "engineer" } : {};
  return (
    <>
      {FORMATS.map(({ suffix, width, height }) => (
        <Composition
          key={suffix}
          id={`${video.id}-${suffix}`}
          component={video.component}
          durationInFrames={video.durationInFrames}
          fps={video.fps}
          width={width}
          height={height}
          defaultProps={defaultProps}
        />
      ))}
    </>
  );
};

/**
 * Builds a registerRoot()-able component containing ONLY one video's
 * compositions — used by src/entries/<id>.ts so each video can be
 * bundled and rendered in isolation.
 */
export const createVideoRoot = (video: VideoConfig): React.FC => {
  const IsolatedRoot: React.FC = () => <VideoCompositions video={video} />;
  return IsolatedRoot;
};

/**
 * Same, for a family of videos sharing one entry (e.g. the journey
 * clips) — registers every video's three compositions.
 */
export const createVideosRoot = (videos: VideoConfig[]): React.FC => {
  const IsolatedRoot: React.FC = () => (
    <>
      {videos.map((v) => (
        <VideoCompositions key={v.id} video={v} />
      ))}
    </>
  );
  return IsolatedRoot;
};
