import type { ToolDef } from "../registry.js";
import { manageTool } from "./manage.js";
import { reportTool } from "./report.js";
import { testEmailTool } from "./test-email.js";

/** The whole surface — deliberately tiny (see registry.ts). */
export const allTools: ToolDef[] = [reportTool, manageTool, testEmailTool];
