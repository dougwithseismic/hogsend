import type { VideoEmitter } from "./types.js";

export function combineEmitters(...emitters: VideoEmitter[]): VideoEmitter {
  return (event) => {
    for (const emitter of emitters) emitter(event);
  };
}

export const consoleEmitter: VideoEmitter = (event) => {
  console.log(`[@hogsend/video] ${event.name}`, event.properties);
};
