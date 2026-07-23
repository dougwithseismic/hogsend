import { createStyleHandler } from "@hogsend/inspector/server";

// Dev-only static className endpoint for the inspector overlay. The handler
// hard-404s in production, requires same-origin, and only edits an exact stamped
// JSX element after an optimistic old-value check.
export const POST = createStyleHandler();
