// Isolated render entry for "aarrr-lifecycle-map" — bundles ONLY this video's three
// compositions so agents can render in parallel without each other's code.
import { registerRoot } from "remotion";
import { createVideoRoot } from "../lib/compositions";
import { video } from "../videos/aarrr-lifecycle-map";

registerRoot(createVideoRoot(video));
