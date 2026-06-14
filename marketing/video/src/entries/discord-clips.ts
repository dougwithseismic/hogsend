// Isolated render entry for the Discord clips family — bundles ONLY the
// Discord clip compositions so they render without the launch videos' code.
import { registerRoot } from "remotion";
import { createVideosRoot } from "../lib/compositions";
import { DISCORD_CLIPS } from "../videos/discord-clips";

registerRoot(createVideosRoot(DISCORD_CLIPS));
