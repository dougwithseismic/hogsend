import type {
  AdapterSink,
  PlayerState,
  SourceMetadata,
  TrackerOptions,
  VideoEvent,
  VideoEventName,
  VideoTracker,
} from "./types.js";

const DEFAULT_MILESTONES = [25, 50, 75, 90];

const initialState = (source: SourceMetadata): PlayerState => ({
  status: "idle",
  currentTime: 0,
  duration: 0,
  percentWatched: 0,
  playbackRate: 1,
  muted: false,
  volume: 1,
  buffering: false,
  started: false,
  completed: false,
  replays: 0,
  milestonesReached: [],
  source,
});

export function createVideoTracker(opts: TrackerOptions = {}): VideoTracker {
  const emitters = opts.emitter
    ? Array.isArray(opts.emitter)
      ? [...opts.emitter]
      : [opts.emitter]
    : [];
  const milestones = [...(opts.milestones ?? DEFAULT_MILESTONES)].sort(
    (a, b) => a - b,
  );
  const handlers = new Map<string, Set<(e: VideoEvent) => void>>();
  const stateListeners = new Set<(s: Readonly<PlayerState>) => void>();
  const contextPatch: Record<string, unknown> = {};
  const detachers: Array<() => void> = [];
  let state = initialState(opts.source ?? { provider: "html5" });
  let destroyed = false;

  const context = (): Record<string, unknown> => ({
    ...(typeof opts.context === "function" ? opts.context() : opts.context),
    ...contextPatch,
  });

  const notify = () => {
    for (const listener of stateListeners) listener(state);
  };

  const patch = (changes: Partial<PlayerState>) => {
    state = { ...state, ...changes };
    notify();
  };

  const emit = (name: VideoEventName, extra?: Record<string, unknown>) => {
    if (destroyed) return;
    const { provider, videoId, url, title } = state.source;
    const event: VideoEvent = {
      name,
      state,
      properties: {
        provider,
        ...(videoId !== undefined ? { videoId } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(title !== undefined ? { title } : {}),
        currentTime: state.currentTime,
        duration: state.duration,
        percentWatched: state.percentWatched,
        ...extra,
        ...context(),
      },
      timestamp: Date.now(),
    };
    for (const emitter of emitters) emitter(event);
    for (const handler of handlers.get(name) ?? []) handler(event);
    for (const handler of handlers.get("*") ?? []) handler(event);
  };

  /** Update watch depth and fire every newly crossed milestone, in order. */
  const advanceDepth = (percent: number) => {
    const percentWatched = Math.min(
      100,
      Math.max(state.percentWatched, percent),
    );
    if (percentWatched === state.percentWatched) return;
    patch({ percentWatched });
    for (const milestone of milestones) {
      if (milestone > percentWatched) break;
      if (state.milestonesReached.includes(milestone)) continue;
      patch({ milestonesReached: [...state.milestonesReached, milestone] });
      emit("video.progress", { milestone });
    }
  };

  const sink: AdapterSink = {
    onPlay() {
      const wasEnded = state.status === "ended";
      if (wasEnded) {
        patch({
          replays: state.replays + 1,
          completed: false,
          milestonesReached: [],
          percentWatched: 0,
        });
      }
      patch({ status: "playing", buffering: false });
      if (!state.started) {
        patch({ started: true });
        emit("video.started");
      } else if (wasEnded) {
        emit("video.replay");
      }
      emit("video.play");
    },
    onPause() {
      if (state.status === "ended" || state.status === "paused") return;
      patch({ status: "paused" });
      emit("video.pause");
    },
    onEnded() {
      patch({ status: "ended", buffering: false, completed: true });
      advanceDepth(100);
      emit("video.completed");
    },
    onTime(currentTime, duration) {
      patch({ currentTime, duration: duration || state.duration });
      if (duration > 0) advanceDepth((currentTime / duration) * 100);
    },
    onSeek(from, to) {
      patch({ currentTime: to });
      emit("video.seek", { from, to });
      if (state.duration > 0) advanceDepth((to / state.duration) * 100);
    },
    onRate(rate) {
      if (rate === state.playbackRate) return;
      patch({ playbackRate: rate });
      emit("video.ratechange", { playbackRate: rate });
    },
    onVolume(volume, muted) {
      if (volume === state.volume && muted === state.muted) return;
      patch({ volume, muted });
      emit("video.volumechange", { volume, muted });
    },
    onBuffering(buffering) {
      if (buffering === state.buffering) return;
      patch({
        buffering,
        status:
          buffering && state.status === "playing"
            ? "buffering"
            : !buffering && state.status === "buffering"
              ? "playing"
              : state.status,
      });
      if (buffering) emit("video.buffering");
    },
  };

  return {
    sink,
    getState: () => state,
    on(name, handler) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(handler);
      return () => set.delete(handler);
    },
    subscribe(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    setContext(newPatch) {
      Object.assign(contextPatch, newPatch);
    },
    attach(adapter) {
      state = { ...state, source: adapter.source, status: "loading" };
      notify();
      const detachFromAdapter = adapter.attach(sink);
      const detach = () => {
        detachFromAdapter?.();
        adapter.destroy();
      };
      detachers.push(detach);
      return detach;
    },
    destroy() {
      destroyed = true;
      for (const detach of detachers) detach();
      detachers.length = 0;
      handlers.clear();
      stateListeners.clear();
    },
  };
}
