// Isolated render entry for "semantic-links" — bundles ONLY this video's three
// compositions so agents can render in parallel without each other's code.
import { registerRoot } from "remotion";
import { createVideoRoot } from "../lib/compositions";
import { video } from "../videos/semantic-links";

registerRoot(createVideoRoot(video));
