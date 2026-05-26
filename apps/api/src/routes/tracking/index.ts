import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { clickRouter } from "./click.js";
import { openRouter } from "./open.js";

export const trackingRouter = new OpenAPIHono<AppEnv>();

trackingRouter.route("/", clickRouter);
trackingRouter.route("/", openRouter);
