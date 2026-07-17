// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createHtml5Adapter } from "../providers/html5.js";
import { createVideoTracker } from "../tracker.js";
import type { VideoEvent } from "../types.js";

function setup() {
  const video = document.createElement("video");
  video.setAttribute("src", "https://example.com/demo.mp4");
  // jsdom media elements have no real playback; fake the readable fields.
  Object.defineProperty(video, "duration", { value: 100, writable: true });
  const events: VideoEvent[] = [];
  const tracker = createVideoTracker({ emitter: (e) => events.push(e) });
  tracker.attach(createHtml5Adapter(video, { title: "Demo" }));
  return { video, events, tracker };
}

describe("createHtml5Adapter", () => {
  it("maps element events through the tracker", () => {
    const { video, events, tracker } = setup();
    video.dispatchEvent(new Event("play"));
    video.currentTime = 30;
    video.dispatchEvent(new Event("timeupdate"));
    video.dispatchEvent(new Event("pause"));
    expect(events.map((e) => e.name)).toEqual([
      "video.started",
      "video.play",
      "video.progress",
      "video.pause",
    ]);
    expect(tracker.getState().source).toMatchObject({
      provider: "html5",
      url: "https://example.com/demo.mp4",
      title: "Demo",
    });
    expect(tracker.getState().percentWatched).toBe(30);
  });

  it("reports seek with from/to and stops listening after destroy", () => {
    const { video, events, tracker } = setup();
    video.dispatchEvent(new Event("play"));
    video.currentTime = 10;
    video.dispatchEvent(new Event("timeupdate"));
    video.dispatchEvent(new Event("seeking"));
    video.currentTime = 80;
    video.dispatchEvent(new Event("seeked"));
    const seek = events.find((e) => e.name === "video.seek");
    expect(seek?.properties).toMatchObject({ from: 10, to: 80 });

    tracker.destroy();
    const count = events.length;
    video.dispatchEvent(new Event("pause"));
    expect(events.length).toBe(count);
  });
});
