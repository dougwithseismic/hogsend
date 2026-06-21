import { type CreateAppOptions, ingestEvent } from "@hogsend/engine";
import {
  consumeTelegramConfirmToken,
  peekTelegramConfirmToken,
} from "@hogsend/plugin-telegram";

type RoutesFn = NonNullable<CreateAppOptions["routes"]>;

/**
 * Email-confirmation connect page + exchange, mounted via `createApp({ routes })`.
 *
 * Domain-agnostic: served on the customer's own `API_PUBLIC_URL`; posthog-js
 * inits with the customer's own `POSTHOG_API_KEY`/`POSTHOG_HOST` (the phc_ key is
 * write-only by PostHog's design — safe in a browser). No literal domain anywhere
 * (the exchange URL is relative).
 *
 * Security (from the adversarial review):
 *  - The bind happens on a human button CLICK (POST), NEVER on GET — so an
 *    email/Telegram link-preview prefetch can't complete it.
 *  - The token seals { telegramUserId, email } server-side and is single-use
 *    (Redis GETDEL). The web caller never names either id.
 *  - The client identifies CLIENT-side (real geo/IP) keyed to the SERVER-proven
 *    `contactKey` the exchange returns — the page never sends a distinct_id the
 *    server resolves a contact on, so there is no graft/takeover vector.
 */
export const registerTelegramConnectRoutes: RoutesFn = (app) => {
  app.get("/connect/telegram", (c) => {
    const { env } = c.get("container");
    return c.html(
      connectPageHtml({
        posthogKey: env.POSTHOG_API_KEY ?? null,
        posthogHost: env.POSTHOG_HOST ?? null,
      }),
    );
  });

  app.post("/connect/telegram/exchange", async (c) => {
    const container = c.get("container");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "bad_json" }, 400);
    }
    const tok =
      body && typeof (body as { tok?: unknown }).tok === "string"
        ? (body as { tok: string }).tok
        : "";
    if (!tok) return c.json({ ok: false, error: "missing_token" }, 400);

    const binding = await peekTelegramConfirmToken(tok);
    if (!binding) return c.json({ ok: false, error: "invalid_or_used" }, 410);

    // Authoritative bind: telegram:<id> + email folded onto one contact. Returns
    // the canonical contact key the page hands to posthog.identify() so the web
    // session joins the SAME person the contact's email events land on. If this
    // throws (Hatchet/DB blip → 500), the token is NOT consumed below, so the
    // user's retry still works (peek, not consume-on-read).
    const result = await ingestEvent({
      db: container.db,
      registry: container.registry,
      hatchet: container.hatchet,
      logger: container.logger,
      analytics: container.analytics,
      event: {
        event: "telegram.linked",
        userId: `telegram:${binding.telegramUserId}`,
        userEmail: binding.email,
        eventProperties: {
          source: "telegram",
          chatId: binding.telegramUserId,
          fromId: binding.telegramUserId,
          via: "email_confirm",
        },
        // chat_id === user id for a private chat. `telegram` is in
        // DEEP_MERGE_KEYS, so this never clobbers richer fields (username/etc.)
        // set by inbound messages — it merges.
        contactProperties: {
          telegram: {
            id: binding.telegramUserId,
            chat_id: binding.telegramUserId,
          },
        },
        idempotencyKey: `telegram:confirm:${binding.telegramUserId}:${tok}`,
      },
    });

    // Single-use: consume only AFTER the bind ingest committed.
    await consumeTelegramConfirmToken(tok);

    return c.json({
      ok: true,
      key: result.contactKey,
      telegramId: binding.telegramUserId,
    });
  });
};

/**
 * Self-contained dark connect page. `?tok=` is read CLIENT-side (never reflected
 * into the markup), the config is JSON-embedded (JS-string-safe), and the bind
 * runs only on the explicit button click.
 */
function connectPageHtml(cfg: {
  posthogKey: string | null;
  posthogHost: string | null;
}): string {
  const config = JSON.stringify({
    posthogKey: cfg.posthogKey,
    // posthog-js falls back to US when host is null; an EU deploy must set
    // POSTHOG_HOST. (Relay note: for an ad-block-heavy audience, front this with
    // a first-party /relay — out of scope for the local proof.)
    posthogHost: cfg.posthogHost,
    exchangeUrl: "/connect/telegram/exchange",
  });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Connect Telegram</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; display: flex; align-items: center;
        justify-content: center; background: #09090b; color: #fafafa;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
          Helvetica, Arial, sans-serif; padding: 24px;
      }
      .card {
        max-width: 440px; width: 100%; text-align: center;
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
        border-radius: 16px; padding: 40px 32px;
      }
      .badge {
        width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 9999px;
        display: flex; align-items: center; justify-content: center;
        background: rgba(56,139,253,0.15); font-size: 28px;
      }
      h1 { font-size: 20px; margin: 0 0 8px; font-weight: 600; }
      p { margin: 0 0 24px; color: rgba(250,250,250,0.7); line-height: 1.6; }
      button {
        appearance: none; border: 0; border-radius: 10px; cursor: pointer;
        background: #2f81f7; color: #fff; font-size: 15px; font-weight: 600;
        padding: 12px 20px; width: 100%;
      }
      button:disabled { opacity: 0.6; cursor: default; }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="badge" aria-hidden="true">✈️</div>
      <h1 id="h">Connect your Telegram</h1>
      <p id="p">Tap below to finish linking your Telegram account to your contact.</p>
      <button id="btn" type="button">Confirm connection</button>
    </main>
    <script>
      var CFG = ${config};
      var tok = new URLSearchParams(location.search).get("tok");
      var btn = document.getElementById("btn");
      var h = document.getElementById("h");
      var p = document.getElementById("p");

      function loadPosthog(host) {
        !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
        window.posthog.init(CFG.posthogKey, { api_host: host, person_profiles: "always" });
      }

      function done(ok, key, tgId) {
        btn.style.display = "none";
        if (ok && CFG.posthogKey) {
          try {
            loadPosthog(CFG.posthogHost || "https://us.i.posthog.com");
            window.posthog.identify(key, { telegram_id: tgId });
          } catch (e) {}
        }
        h.textContent = ok ? "You're connected ✓" : "Link unavailable";
        p.textContent = ok
          ? "Your Telegram is now linked. You can close this tab and head back to Telegram."
          : "This link is invalid or already used. Send /link again in Telegram for a fresh one.";
      }

      btn.addEventListener("click", function () {
        if (!tok) { done(false); return; }
        btn.disabled = true;
        btn.textContent = "Connecting…";
        fetch(CFG.exchangeUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tok: tok }),
        })
          .then(function (r) { return r.json(); })
          .then(function (j) { done(!!j.ok, j.key, j.telegramId); })
          .catch(function () { done(false); });
      });
    </script>
  </body>
</html>`;
}
