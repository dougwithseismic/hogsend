import type { RoutesFn } from "@hogsend/engine";
import { hogsendTokenRoutes } from "./hogsend-token.js";

/**
 * Custom routers mounted onto the app AFTER the engine's built-in routes, via
 * `createApp(client, { routes })` in `src/index.ts`. Each is a `RoutesFn` —
 * `(app) => { app.post(...); }` — and they run in array order.
 *
 * Ships with one REFERENCE route (`hogsendTokenRoutes`, a userToken mint) that
 * is inert until you wire your own end-user auth into it. Edit freely — this is
 * your content. Add a route, then it's already threaded through this barrel.
 */
export const routes: RoutesFn[] = [hogsendTokenRoutes];
