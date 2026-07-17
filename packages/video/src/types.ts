export interface SourceMetadata {
  provider: "youtube" | "vimeo" | "html5" | (string & {});
  videoId?: string;
  url?: string;
  title?: string;
  [key: string]: unknown;
}

export type PlayerStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "buffering"
  | "ended";

export interface PlayerState {
  status: PlayerStatus;
  currentTime: number;
  duration: number;
  /** Max depth reached as a 0-100 percentage — monotonic, seek-back-proof. */
  percentWatched: number;
  playbackRate: number;
  muted: boolean;
  volume: number;
  buffering: boolean;
  started: boolean;
  completed: boolean;
  replays: number;
  milestonesReached: number[];
  source: SourceMetadata;
}

export type VideoEventName =
  | "video.started"
  | "video.play"
  | "video.pause"
  | "video.seek"
  | "video.progress"
  | "video.completed"
  | "video.replay"
  | "video.ratechange"
  | "video.volumechange"
  | "video.buffering";

export interface VideoEvent {
  name: VideoEventName;
  state: Readonly<PlayerState>;
  /** Flattened for analytics sinks: source fields, currentTime, duration,
   * percentWatched, event extras (milestone, from/to), and the context bag. */
  properties: Record<string, unknown>;
  timestamp: number;
}

export type VideoEmitter = (event: VideoEvent) => void;

/** Raw player signals an adapter pushes into the tracker. */
export interface AdapterSink {
  onPlay(): void;
  onPause(): void;
  onEnded(): void;
  onTime(currentTime: number, duration: number): void;
  onSeek(from: number, to: number): void;
  onRate(rate: number): void;
  onVolume(volume: number, muted: boolean): void;
  onBuffering(buffering: boolean): void;
}

export interface ProviderAdapter {
  readonly source: SourceMetadata;
  attach(sink: AdapterSink): undefined | (() => void);
  destroy(): void;
}

export interface TrackerOptions {
  emitter?: VideoEmitter | VideoEmitter[];
  /** Percent milestones that fire `video.progress`, each once. Default [25, 50, 75, 90]. */
  milestones?: number[];
  /** Merged into every event's properties — viewer/variant/experiment tagging. */
  context?: Record<string, unknown> | (() => Record<string, unknown>);
  source?: SourceMetadata;
}

export interface VideoTracker {
  getState(): Readonly<PlayerState>;
  /** Listen to a specific event or "*" for all — the custom-JS hook point. */
  on(
    name: VideoEventName | "*",
    handler: (event: VideoEvent) => void,
  ): () => void;
  /** Fires on EVERY state change (including sub-milestone time updates). */
  subscribe(listener: (state: Readonly<PlayerState>) => void): () => void;
  setContext(patch: Record<string, unknown>): void;
  attach(adapter: ProviderAdapter): () => void;
  /** The sink adapters feed — exposed so custom integrations can drive the
   * tracker directly without a ProviderAdapter. */
  sink: AdapterSink;
  destroy(): void;
}
