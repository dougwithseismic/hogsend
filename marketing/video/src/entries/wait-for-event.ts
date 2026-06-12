// Isolated render entry for "wait-for-event" — bundles ONLY this video's three
// compositions so agents can render in parallel without each other's code.
import { registerRoot } from "remotion";
import { createVideoRoot } from "../lib/compositions";
import { video } from "../videos/wait-for-event";

registerRoot(createVideoRoot(video));
