// Hogsend client-side config for the docs site. Both are public, build-time
// inlined (NEXT_PUBLIC_*). Point them at the engine that serves /v1/feed/* and
// a `pk_` publishable key whose allowed_origins includes this site's origin.
//
//   local dev:  apps/api on :3002 + a local pk_ key (allowed_origins localhost)
//   production: the dogfood engine (t.hogsend.com) + a prod pk_ key
//
// When unset, the whole Hogsend nav surface no-ops (renders nothing) — so the
// docs site builds + deploys cleanly before the key exists.
export const HOGSEND_API_URL = process.env.NEXT_PUBLIC_HOGSEND_API_URL ?? "";
export const HOGSEND_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_HOGSEND_PUBLISHABLE_KEY ?? "";

/** True only when both the engine URL and a publishable key are configured. */
export const isHogsendConfigured =
  HOGSEND_API_URL.length > 0 && HOGSEND_PUBLISHABLE_KEY.startsWith("pk_");
