// Isolated render entry for the journey clips family — bundles ONLY the
// clip compositions so they render without the launch videos' code.
import { registerRoot } from "remotion";
import { createVideosRoot } from "../lib/compositions";
import { JOURNEY_CLIPS } from "../videos/journey-clips";

registerRoot(createVideosRoot(JOURNEY_CLIPS));
