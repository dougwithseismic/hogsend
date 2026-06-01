// @hogsend/cli — programmatic entry. The `hogsend` bin lives in ./bin.ts.

export type { Command, CommandContext } from "./commands/types.js";
export {
  EjectError,
  type EjectOptions,
  type EjectResult,
  eject,
} from "./eject.js";
