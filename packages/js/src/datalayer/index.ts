/**
 * `@hogsend/js` dataLayer bridge — GTM/GA4 interop. See {@link startDataLayerBridge}.
 */

export {
  isSelfOrGtm,
  OUTBOUND_PREFIX,
  outboundEntry,
  pluckScalars,
  resolveInbound,
  type StartDataLayerBridgeOptions,
  startDataLayerBridge,
} from "./bridge.js";
