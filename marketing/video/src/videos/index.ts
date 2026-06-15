// ============================================================================
// VIDEO REGISTRY — only the foundation owner edits this file.
// Video agents: work exclusively inside your own src/videos/<id>/ folder.
// ============================================================================
import type { VideoConfig } from "../lib/define-video";
import { video as aarrrLifecycleMap } from "./aarrr-lifecycle-map";
import { video as byoProvider } from "./byo-provider";
import { DISCORD_CLIPS } from "./discord-clips";
import { DISCORD_PRESENCE_CLIPS } from "./discord-presence";
import { video as firstPartyTracking } from "./first-party-tracking";
import { video as howItWorks } from "./how-it-works";
import { JOURNEY_CLIPS } from "./journey-clips";
import { video as scaffoldDemo } from "./scaffold-demo";
import { video as semanticLinks } from "./semantic-links";
import { video as waitForEvent } from "./wait-for-event";

export const VIDEOS: VideoConfig[] = [
  howItWorks,
  semanticLinks,
  firstPartyTracking,
  byoProvider,
  waitForEvent,
  scaffoldDemo,
  aarrrLifecycleMap,
  ...JOURNEY_CLIPS,
  ...DISCORD_CLIPS,
  ...DISCORD_PRESENCE_CLIPS,
];
