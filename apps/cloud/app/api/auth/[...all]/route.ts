import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/src/lib/auth";

// Auth reads and writes cookies + the database on every call; a cached or
// prerendered response would hand one visitor another's session.
export const dynamic = "force-dynamic";

export const { GET, POST } = toNextJsHandler(auth.handler);
