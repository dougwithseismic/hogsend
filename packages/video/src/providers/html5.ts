import type { AdapterSink, ProviderAdapter, SourceMetadata } from "../types.js";

/** Adapter over a native <video> (or <audio>) element. */
export function createHtml5Adapter(
  media: HTMLMediaElement,
  source?: Partial<SourceMetadata>,
): ProviderAdapter {
  let detach: (() => void) | undefined;
  return {
    source: {
      provider: "html5",
      url: media.currentSrc || media.getAttribute("src") || undefined,
      ...source,
    },
    attach(sink: AdapterSink) {
      let lastTime = media.currentTime;
      let seekFrom: number | null = null;
      const listeners: Array<[string, () => void]> = [
        ["play", () => sink.onPlay()],
        ["pause", () => !media.ended && sink.onPause()],
        ["ended", () => sink.onEnded()],
        [
          "timeupdate",
          () => {
            // Ignore timeupdate ticks mid-seek; onSeek reports the landing.
            if (seekFrom === null) {
              sink.onTime(media.currentTime, media.duration || 0);
              lastTime = media.currentTime;
            }
          },
        ],
        [
          "seeking",
          () => {
            if (seekFrom === null) seekFrom = lastTime;
          },
        ],
        [
          "seeked",
          () => {
            if (seekFrom !== null) {
              sink.onSeek(seekFrom, media.currentTime);
              seekFrom = null;
              lastTime = media.currentTime;
            }
          },
        ],
        ["ratechange", () => sink.onRate(media.playbackRate)],
        ["volumechange", () => sink.onVolume(media.volume, media.muted)],
        ["waiting", () => sink.onBuffering(true)],
        ["playing", () => sink.onBuffering(false)],
        [
          "loadedmetadata",
          () => sink.onTime(media.currentTime, media.duration || 0),
        ],
      ];
      for (const [name, fn] of listeners) media.addEventListener(name, fn);
      sink.onVolume(media.volume, media.muted);
      detach = () => {
        for (const [name, fn] of listeners) media.removeEventListener(name, fn);
      };
      return detach;
    },
    destroy() {
      detach?.();
      detach = undefined;
    },
  };
}
