import { Hogsend } from "@hogsend/client";

/**
 * A configured Hogsend data-plane client for talking to THIS app's HTTP API
 * from your own product code (a signup handler, a billing webhook, a cron job).
 *
 * It is the typed counterpart to the data-plane routes the engine mounts:
 *   - `hs.contacts.upsert(...)` → `PUT  /v1/contacts`
 *   - `hs.contacts.find(...)`   → `GET  /v1/contacts/find`
 *   - `hs.events.send(...)`     → `POST /v1/events`   (alias: `hs.events.track`)
 *   - `hs.emails.send(...)`     → `POST /v1/emails`
 *   - `hs.lists.*`              → `/v1/lists` (+ subscribe / unsubscribe)
 *
 * Auth: the data plane requires an API key carrying the `ingest` scope (see
 * `HOGSEND_API_KEY` in `.env`). `pnpm bootstrap` mints one for local dev and
 * writes it for you; in production, create a key with the `ingest` scope and
 * set `HOGSEND_API_KEY`. `API_PUBLIC_URL` points at your deployed API; it
 * defaults to the local dev server.
 *
 * This is plain content — import `hs` wherever you ingest events or upsert
 * contacts. (Inside a journey's `run()`, prefer the engine's `sendEmail()` /
 * `ctx.trigger()` primitives; this client is for code OUTSIDE the engine.)
 */
export const hs = new Hogsend({
  baseUrl: process.env.API_PUBLIC_URL ?? "http://localhost:3002",
  apiKey: process.env.HOGSEND_API_KEY ?? "",
});
