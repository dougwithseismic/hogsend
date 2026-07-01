import { createOpenHandler } from "@hogsend/inspector/server";

// Dev-only "open in editor" endpoint for the inspector overlay. The handler
// hard-404s in production, requires same-origin, and allowlists to the app root.
export const POST = createOpenHandler();
