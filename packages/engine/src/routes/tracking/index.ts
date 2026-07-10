import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { answerRouter } from "./answer.js";
import { arriveRouter } from "./arrive.js";
import { clickRouter } from "./click.js";
import { identifyRouter } from "./identify.js";
import { openRouter } from "./open.js";

export const trackingRouter = new OpenAPIHono<AppEnv>();

trackingRouter.route("/", clickRouter);
trackingRouter.route("/", openRouter);
trackingRouter.route("/", answerRouter);
trackingRouter.route("/", identifyRouter);
trackingRouter.route("/", arriveRouter);
