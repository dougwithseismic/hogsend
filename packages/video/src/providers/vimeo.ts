import type { AdapterSink, ProviderAdapter, SourceMetadata } from "../types.js";

interface VimeoPlayer {
  on(event: string, handler: (data?: Record<string, unknown>) => void): void;
  getVolume(): Promise<number>;
  getMuted(): Promise<boolean>;
  destroy(): Promise<void>;
}

interface VimeoNamespace {
  Player: new (
    element: HTMLElement | HTMLIFrameElement,
    options?: { id?: number; url?: string },
  ) => VimeoPlayer;
}

declare global {
  interface Window {
    Vimeo?: VimeoNamespace;
  }
}

let apiPromise: Promise<VimeoNamespace> | undefined;

/** Singleton loader for the Vimeo Player SDK script. */
function loadVimeoApi(): Promise<VimeoNamespace> {
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      if (window.Vimeo?.Player) {
        resolve(window.Vimeo);
        return;
      }
      const script = document.createElement("script");
      script.src = "https://player.vimeo.com/api/player.js";
      script.onload = () => resolve(window.Vimeo as VimeoNamespace);
      script.onerror = () => reject(new Error("Failed to load Vimeo SDK"));
      document.head.appendChild(script);
    });
  }
  return apiPromise;
}

export interface VimeoAdapterOptions {
  /** Numeric video id, or an existing player iframe element. */
  videoId?: string | number;
  element: HTMLElement | HTMLIFrameElement;
  source?: Partial<SourceMetadata>;
}

export function createVimeoAdapter(opts: VimeoAdapterOptions): ProviderAdapter {
  let player: VimeoPlayer | undefined;
  let destroyed = false;

  return {
    source: {
      provider: "vimeo",
      ...(opts.videoId !== undefined
        ? {
            videoId: String(opts.videoId),
            url: `https://vimeo.com/${opts.videoId}`,
          }
        : {}),
      ...opts.source,
    },
    attach(sink: AdapterSink) {
      let lastTime = 0;
      void loadVimeoApi().then((Vimeo) => {
        if (destroyed) return;
        player = new Vimeo.Player(
          opts.element,
          opts.videoId !== undefined ? { id: Number(opts.videoId) } : undefined,
        );
        player.on("play", () => sink.onPlay());
        player.on("pause", () => sink.onPause());
        player.on("ended", () => sink.onEnded());
        player.on("timeupdate", (data) => {
          const seconds = Number(data?.seconds ?? 0);
          const duration = Number(data?.duration ?? 0);
          sink.onTime(seconds, duration);
          lastTime = seconds;
        });
        player.on("seeked", (data) => {
          const seconds = Number(data?.seconds ?? 0);
          sink.onSeek(lastTime, seconds);
          lastTime = seconds;
        });
        player.on("volumechange", (data) => {
          const volume = Number(data?.volume ?? 1);
          void player?.getMuted().then((muted) => sink.onVolume(volume, muted));
        });
        player.on("playbackratechange", (data) =>
          sink.onRate(Number(data?.playbackRate ?? 1)),
        );
        player.on("bufferstart", () => sink.onBuffering(true));
        player.on("bufferend", () => sink.onBuffering(false));
      });
      // Cleanup happens in destroy() — the tracker calls both on detach.
      return undefined;
    },
    destroy() {
      destroyed = true;
      void player?.destroy().catch(() => {});
      player = undefined;
    },
  };
}
