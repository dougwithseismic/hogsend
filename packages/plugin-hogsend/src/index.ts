// The sending-domain capability (the gate that lights up admin/CLI/Studio).
export {
  createHogsendRelayDomains,
  type HogsendDomainsCapability,
  type HogsendDomainsConfig,
  type HogsendReturnPathResult,
} from "./domains.js";
// Typed relay failures — the shape of a refusal survives to the journey.
export {
  HogsendRelayBatchError,
  type HogsendRelayBatchFailure,
  type HogsendRelayBatchResult,
  HogsendRelayError,
  type HogsendRelayErrorInit,
  HogsendRelayPausedError,
} from "./errors.js";
// The EmailProvider (the wire).
export {
  createHogsendEmailProvider,
  HOGSEND_IDEMPOTENCY_HEADER,
  type HogsendEmailConfig,
} from "./provider.js";
// The relay webhook wire — owned HERE, produced by the control plane.
export {
  assertHogsendRelayFresh,
  classifyHogsendRelayBounce,
  HOGSEND_RELAY_EMAIL_EVENT_TYPES,
  HOGSEND_RELAY_EVENT_VERSION,
  HOGSEND_RELAY_MAX_AGE_MS,
  HOGSEND_RELAY_MAX_FUTURE_MS,
  HOGSEND_RELAY_SIGNATURE_HEADER,
  type HogsendRelayEmailEvent,
  type HogsendRelayEmailEventType,
  hogsendRelayBounceSchema,
  hogsendRelayEmailEventSchema,
  hogsendRelayRejectSchema,
  parseHogsendRelayWebhook,
  signHogsendRelayWebhook,
  verifyHogsendRelaySignature,
} from "./webhook.js";
