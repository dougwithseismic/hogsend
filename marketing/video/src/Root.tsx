import type React from "react";
import { VideoCompositions } from "./lib/compositions";
import { VIDEOS } from "./videos";

/** Full studio root: every video × three formats (-169, -916, -11). */
export const Root: React.FC = () => {
  return (
    <>
      {VIDEOS.map((video) => (
        <VideoCompositions key={video.id} video={video} />
      ))}
    </>
  );
};
