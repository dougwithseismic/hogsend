import type { AdapterSink, ProviderAdapter, SourceMetadata } from "../types.js";

interface YTPlayer {
  getCurrentTime(): number;
  getDuration(): number;
  getPlaybackRate(): number;
  getVolume(): number;
  isMuted(): boolean;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    element: HTMLElement | string,
    options: {
      videoId?: string;
      host?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onPlaybackRateChange?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
  PlayerState: {
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
  };
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | undefined;

/** Singleton loader for the YouTube IFrame API script. */
function loadYouTubeApi(): Promise<YTNamespace> {
  if (!apiPromise) {
    apiPromise = new Promise((resolve) => {
      if (window.YT?.Player) {
        resolve(window.YT);
        return;
      }
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve(window.YT as YTNamespace);
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    });
  }
  return apiPromise;
}

/** Ticks that jump more than this many seconds count as a seek. */
const SEEK_JUMP_SECONDS = 1.5;
const POLL_MS = 250;

export interface YouTubeAdapterOptions {
  videoId: string;
  /** Element (or id) the player iframe replaces / mounts into. */
  element: HTMLElement | string;
  /** Use the privacy-enhanced youtube-nocookie host. Default true. */
  noCookie?: boolean;
  playerVars?: Record<string, string | number>;
  source?: Partial<SourceMetadata>;
}

export function createYouTubeAdapter(
  opts: YouTubeAdapterOptions,
): ProviderAdapter {
  let player: YTPlayer | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;

  const stopPolling = () => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
  };

  return {
    source: {
      provider: "youtube",
      videoId: opts.videoId,
      url: `https://www.youtube.com/watch?v=${opts.videoId}`,
      ...opts.source,
    },
    attach(sink: AdapterSink) {
      let lastTime = 0;
      const startPolling = () => {
        stopPolling();
        poll = setInterval(() => {
          if (!player) return;
          const time = player.getCurrentTime();
          if (Math.abs(time - lastTime) > SEEK_JUMP_SECONDS + POLL_MS / 1000) {
            sink.onSeek(lastTime, time);
          }
          sink.onTime(time, player.getDuration());
          sink.onVolume(player.getVolume() / 100, player.isMuted());
          lastTime = time;
        }, POLL_MS);
      };

      void loadYouTubeApi().then((YT) => {
        if (destroyed) return;
        player = new YT.Player(opts.element, {
          videoId: opts.videoId,
          ...(opts.noCookie !== false
            ? { host: "https://www.youtube-nocookie.com" }
            : {}),
          playerVars: {
            enablejsapi: 1,
            origin: window.location.origin,
            ...opts.playerVars,
          },
          events: {
            onReady: () => {
              if (player) sink.onTime(0, player.getDuration());
            },
            onStateChange: (e) => {
              if (!player) return;
              if (e.data === YT.PlayerState.PLAYING) {
                sink.onBuffering(false);
                sink.onPlay();
                startPolling();
              } else if (e.data === YT.PlayerState.PAUSED) {
                stopPolling();
                sink.onPause();
              } else if (e.data === YT.PlayerState.ENDED) {
                stopPolling();
                sink.onEnded();
              } else if (e.data === YT.PlayerState.BUFFERING) {
                sink.onBuffering(true);
              }
            },
            onPlaybackRateChange: (e) => sink.onRate(e.data),
          },
        });
      });
      return stopPolling;
    },
    destroy() {
      destroyed = true;
      stopPolling();
      player?.destroy();
      player = undefined;
    },
  };
}
