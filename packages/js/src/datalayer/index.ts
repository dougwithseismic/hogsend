/**
 * `@hogsend/js` dataLayer bridge — GTM/GA4 interop. See {@link startDataLayerBridge}.
 */

export {
  isOutbound,
  isSelfOrGtm,
  markOutbound,
  OUTBOUND_MARK,
  OUTBOUND_PREFIX,
  outboundEntry,
  pluckScalars,
  resolveInbound,
  resolveOutbound,
  type StartDataLayerBridgeOptions,
  startDataLayerBridge,
} from "./bridge.js";
