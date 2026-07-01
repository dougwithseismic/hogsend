import { createEditHandler } from "@hogsend/inspector/server";

// Dev-only "write edit back to source" endpoint for the inspector overlay. The
// handler hard-404s in production, requires same-origin, allowlists to the app
// root, and only writes on an exactly-one-match (exact or flexible) — else aborts.
export const POST = createEditHandler();
