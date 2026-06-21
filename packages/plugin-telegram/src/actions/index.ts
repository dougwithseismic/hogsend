import type { DefinedConnectorAction } from "@hogsend/engine";
import { dm } from "./dm.js";
import { sendMessage } from "./send-message.js";

export { type DmArgs, type DmResult, dm } from "./dm.js";
export {
  type SendMessageArgs,
  type SendMessageResult,
  sendMessage,
} from "./send-message.js";

/** The Telegram outbound action bundle — pass to `createHogsendClient({ connectorActions })`. */
export const telegramActions: DefinedConnectorAction[] = [sendMessage, dm];
