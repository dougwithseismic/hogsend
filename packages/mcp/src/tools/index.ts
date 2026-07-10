import type { ToolDef } from "../registry.js";
import { reportTool } from "./report.js";

/** The whole surface — deliberately tiny (see registry.ts). */
export const allTools: ToolDef[] = [reportTool];
