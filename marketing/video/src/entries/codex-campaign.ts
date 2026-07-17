import { registerRoot } from "remotion";
import { createVideoRoot } from "../lib/compositions";
import { video } from "../videos/codex-campaign";

registerRoot(createVideoRoot(video));
