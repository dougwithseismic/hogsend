// Isolated render entry for the discord-presence clip — bundles ONLY the
// discord-presence composition so it renders without the launch videos' code.
import { registerRoot } from "remotion";
import { createVideosRoot } from "../lib/compositions";
import { DISCORD_PRESENCE_CLIPS } from "../videos/discord-presence";

registerRoot(createVideosRoot(DISCORD_PRESENCE_CLIPS));
