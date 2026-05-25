import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { requireApiKey } from "../../middleware/api-key.js";
import { contactsRouter } from "./contacts.js";
import { journeysRouter } from "./journeys.js";
import { preferencesRouter } from "./preferences.js";

export const adminRouter = new OpenAPIHono<AppEnv>();
adminRouter.use("*", requireApiKey);
adminRouter.route("/contacts", contactsRouter);
adminRouter.route("/contacts", preferencesRouter);
adminRouter.route("/journeys", journeysRouter);
