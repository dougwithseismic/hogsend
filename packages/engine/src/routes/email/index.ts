import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { preferencesRouter } from "./preferences.js";
import { unsubscribeRouter } from "./unsubscribe.js";

export const emailRouter = new OpenAPIHono<AppEnv>();
emailRouter.route("/", unsubscribeRouter);
emailRouter.route("/", preferencesRouter);
