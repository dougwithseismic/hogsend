/**
 * Environment-free journey authoring surface.
 *
 * Journey files should import from this entry point so deterministic tests can
 * load the original module without validating production database or Hatchet
 * credentials. Importing the main `@hogsend/engine` entry in an API/worker
 * process installs the production Hatchet task binding before tasks are read.
 */
// Narrows ctx.history.email/sms `template` to the registered key unions for
// journey packages that import ONLY this entry. Without it the read path
// silently reverts to an unchecked `string` (see template-key-augmentation.ts).
import "./template-key-augmentation.js";

export * from "@hogsend/core";
export {
  type SendConnectorActionArgs,
  sendConnectorAction,
} from "../lib/connector-actions.js";
export {
  type SendEmailOptions,
  type SendEmailResult,
  sendEmail,
} from "../lib/email.js";
export {
  type SendFeedItemOptions,
  type SendFeedItemResult,
  sendFeedItem,
} from "../lib/feed.js";
export {
  type SendSmsOptions,
  type SendSmsResult,
  sendSms,
} from "../lib/sms.js";
export {
  type DefinedJourney,
  defineJourney,
} from "./define-journey.js";
