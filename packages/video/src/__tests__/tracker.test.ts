import { describe, expect, it } from "vitest";
import { createVideoTracker } from "../tracker.js";
import type { VideoEvent } from "../types.js";

function collect() {
  const events: VideoEvent[] = [];
  const tracker = createVideoTracker({
    emitter: (e) => events.push(e),
    source: { provider: "html5", title: "Test video" },
  });
  return { events, tracker, names: () => events.map((e) => e.name) };
}

describe("createVideoTracker", () => {
  it("emits started then play on first play, plain play after pause", () => {
    const { tracker, names } = collect();
    tracker.sink.onPlay();
    tracker.sink.onPause();
    tracker.sink.onPlay();
    expect(names()).toEqual([
      "video.started",
      "video.play",
      "video.pause",
      "video.play",
    ]);
  });

  it("fires each milestone once with monotonic percentWatched", () => {
    const { tracker, events } = collect();
    tracker.sink.onPlay();
    tracker.sink.onTime(30, 100); // crosses 25
    tracker.sink.onTime(10, 100); // seek-back: no regression, no re-fire
    tracker.sink.onTime(55, 100); // crosses 50
    const progress = events.filter((e) => e.name === "video.progress");
    expect(progress.map((e) => e.properties.milestone)).toEqual([25, 50]);
    expect(tracker.getState().percentWatched).toBeCloseTo(55);
  });

  it("emits every crossed milestone on a seek jump, in order", () => {
    const { tracker, events } = collect();
    tracker.sink.onPlay();
    tracker.sink.onTime(1, 100);
    tracker.sink.onSeek(1, 95);
    const progress = events.filter((e) => e.name === "video.progress");
    expect(progress.map((e) => e.properties.milestone)).toEqual([
      25, 50, 75, 90,
    ]);
    expect(events.some((e) => e.name === "video.seek")).toBe(true);
  });

  it("completes with percentWatched 100 and supports replay", () => {
    const { tracker, events, names } = collect();
    tracker.sink.onPlay();
    tracker.sink.onTime(100, 100);
    tracker.sink.onEnded();
    const completed = events.find((e) => e.name === "video.completed");
    expect(completed?.properties.percentWatched).toBe(100);
    expect(tracker.getState().completed).toBe(true);

    tracker.sink.onPlay();
    expect(names()).toContain("video.replay");
    expect(tracker.getState().replays).toBe(1);
    expect(tracker.getState().milestonesReached).toEqual([]);
    expect(tracker.getState().completed).toBe(false);
  });

  it("merges context (static + setContext patch) into properties", () => {
    const events: VideoEvent[] = [];
    const tracker = createVideoTracker({
      emitter: (e) => events.push(e),
      context: { courseVideo: true },
    });
    tracker.setContext({ variant: "b" });
    tracker.sink.onPlay();
    expect(events[0]?.properties).toMatchObject({
      courseVideo: true,
      variant: "b",
    });
  });

  it("notifies subscribe() on sub-milestone time updates", () => {
    const { tracker } = collect();
    let ticks = 0;
    tracker.subscribe(() => ticks++);
    tracker.sink.onTime(1, 100);
    tracker.sink.onTime(2, 100);
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(tracker.getState().currentTime).toBe(2);
  });

  it("on('*') and named handlers both fire; unsubscribe works", () => {
    const { tracker } = collect();
    const seen: string[] = [];
    const off = tracker.on("*", (e) => seen.push(e.name));
    tracker.on("video.pause", (e) => seen.push(`named:${e.name}`));
    tracker.sink.onPlay();
    off();
    tracker.sink.onPause();
    expect(seen).toEqual(["video.started", "video.play", "named:video.pause"]);
  });

  it("dedupes rate/volume no-ops and reports buffering transitions", () => {
    const { tracker, names } = collect();
    tracker.sink.onRate(1); // no-op (initial rate)
    tracker.sink.onRate(2);
    tracker.sink.onVolume(1, false); // no-op (initial)
    tracker.sink.onPlay();
    tracker.sink.onBuffering(true);
    expect(tracker.getState().status).toBe("buffering");
    tracker.sink.onBuffering(false);
    expect(tracker.getState().status).toBe("playing");
    expect(names()).toEqual([
      "video.ratechange",
      "video.started",
      "video.play",
      "video.buffering",
    ]);
  });
});
