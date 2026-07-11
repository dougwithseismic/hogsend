// `twilio` v6 is a CommonJS module: the class/helpers hang off the default
// export (the `twilio(sid, token)` factory), NOT ESM named exports — a named
// `import { Twilio }` type-checks but throws at runtime. Use the default factory
// for the value and a type-only import for the instance type.

import type { Twilio } from "twilio";
import twilio from "twilio";

/** Construct a Twilio REST client. Thin wrapper mirroring plugin-resend. */
export function createTwilioClient(config: {
  accountSid: string;
  authToken: string;
}): Twilio {
  return twilio(config.accountSid, config.authToken);
}
