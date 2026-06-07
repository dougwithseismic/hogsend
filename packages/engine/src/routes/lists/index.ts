import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { listListRouter } from "./list.js";
import { listSubscribeRouter } from "./subscribe.js";

// The lists router does NOT re-apply auth internally — the guarded `dataPlane`
// sub-app (S8, decision #16) applies `requireApiKey` + `requireScope("ingest")`
// for the whole data plane. Mounting auth here too would double the middleware.
export const listsRouter = new OpenAPIHono<AppEnv>();
listsRouter.route("/", listListRouter);
listsRouter.route("/", listSubscribeRouter);
