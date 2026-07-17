import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createHtml5Adapter } from "../providers/html5.js";
import { createVimeoAdapter } from "../providers/vimeo.js";
import { createYouTubeAdapter } from "../providers/youtube.js";
import { createVideoTracker } from "../tracker.js";
import type {
  PlayerState,
  ProviderAdapter,
  TrackerOptions,
  VideoEvent,
  VideoTracker,
} from "../types.js";

export type {
  PlayerState,
  ProviderAdapter,
  TrackerOptions,
  VideoEvent,
  VideoTracker,
} from "../types.js";

/** Create a tracker for this component's lifetime and subscribe to its state. */
export function useVideoTracker(
  opts: TrackerOptions & { adapter?: ProviderAdapter },
): { tracker: VideoTracker; state: Readonly<PlayerState> } {
  const [tracker] = useState(() => createVideoTracker(opts));
  const attachedRef = useRef(false);
  useEffect(() => {
    if (opts.adapter && !attachedRef.current) {
      attachedRef.current = true;
      tracker.attach(opts.adapter);
    }
    return () => tracker.destroy();
    // The tracker is created once; options changes after mount are ignored by design.
  }, [tracker, opts.adapter]);
  const state = useVideoState(tracker);
  return { tracker, state };
}

export function useVideoState(tracker: VideoTracker): Readonly<PlayerState> {
  return useSyncExternalStore(
    tracker.subscribe,
    tracker.getState,
    tracker.getState,
  );
}

export type VideoPlayerSrc =
  | { youtube: string }
  | { vimeo: string | number }
  | { url: string };

export interface VideoPlayerProps
  extends Omit<TrackerOptions, "source">,
    Pick<TrackerOptions, "context"> {
  src: VideoPlayerSrc;
  onEvent?: (event: VideoEvent) => void;
  onStateChange?: (state: Readonly<PlayerState>) => void;
  /** Receive the tracker for imperative access (getState, on, setContext). */
  trackerRef?: (tracker: VideoTracker) => void;
  title?: string;
  poster?: string;
  autoplay?: boolean;
  muted?: boolean;
  className?: string;
}

export function VideoPlayer({
  src,
  emitter,
  milestones,
  context,
  onEvent,
  onStateChange,
  trackerRef,
  title,
  poster,
  autoplay,
  muted,
  className,
}: VideoPlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [tracker] = useState(() =>
    createVideoTracker({ emitter, milestones, context }),
  );

  // Stable key: consumers pass `src` as an inline object literal, so the
  // effect must not key on its identity or the player remounts every render.
  const srcKey = JSON.stringify(src);

  useEffect(() => {
    const source = JSON.parse(srcKey) as VideoPlayerSrc;
    let detach: (() => void) | undefined;
    let adapter: ProviderAdapter | undefined;
    // The provider SDKs replace/fill the element they're given; hand them an
    // imperative child so they never touch the React-owned container div.
    let inner: HTMLDivElement | undefined;
    const mount = mountRef.current;
    if (mount && !("url" in source)) {
      inner = document.createElement("div");
      mount.appendChild(inner);
    }
    if ("youtube" in source && inner) {
      adapter = createYouTubeAdapter({
        videoId: source.youtube,
        element: inner,
        playerVars: autoplay ? { autoplay: 1, mute: muted ? 1 : 0 } : {},
        source: title !== undefined ? { title } : undefined,
      });
    } else if ("vimeo" in source && inner) {
      adapter = createVimeoAdapter({
        videoId: source.vimeo,
        element: inner,
        source: title !== undefined ? { title } : undefined,
      });
    } else if ("url" in source && videoRef.current) {
      adapter = createHtml5Adapter(videoRef.current, {
        url: source.url,
        ...(title !== undefined ? { title } : {}),
      });
    }
    if (adapter) detach = tracker.attach(adapter);
    return () => {
      detach?.();
      // The SDK may have replaced `inner` with its own iframe — clear whatever
      // it left behind so a re-run starts from an empty container.
      if (mount) mount.replaceChildren();
    };
  }, [tracker, srcKey, title, muted, autoplay]);

  useEffect(() => {
    trackerRef?.(tracker);
    const offEvent = onEvent ? tracker.on("*", onEvent) : undefined;
    const offState = onStateChange
      ? tracker.subscribe(onStateChange)
      : undefined;
    return () => {
      offEvent?.();
      offState?.();
    };
  }, [tracker, onEvent, onStateChange, trackerRef]);

  useEffect(() => () => tracker.destroy(), [tracker]);

  if ("url" in src) {
    return (
      <video
        ref={videoRef}
        src={src.url}
        poster={poster}
        autoPlay={autoplay}
        muted={muted}
        controls
        playsInline
        className={className}
        title={title}
      />
    );
  }
  return <div ref={mountRef} className={className} title={title} />;
}
