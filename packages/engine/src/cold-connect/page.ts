/**
 * Branding for the cold-connect page. Every field is plain text (NOT HTML) — the
 * page JSON-embeds them into a JS-string-safe config and writes them via
 * `textContent`, so no field can inject markup. `accentColor` is regex-validated
 * to a 6-digit hex before it ever reaches a stylesheet.
 */
export interface ColdConnectBranding {
  /** Page `<title>` + heading before the user confirms. */
  title: string;
  /** Body copy under the heading. */
  blurb: string;
  /** Heading + body shown after a successful bind. */
  successCopy: { heading: string; body: string };
  /** Heading + body shown after a failed/expired bind. */
  errorCopy: { heading: string; body: string };
  /** A short emoji/glyph rendered in the badge. */
  badge: string;
  /** Accent color (`#rrggbb`); validated, falls back to a safe blue. */
  accentColor?: string;
}

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_ACCENT = "#2f81f7";

/**
 * Self-contained dark connect page, generalized from the Telegram connect page.
 *
 * Security (from the adversarial review):
 *  - `?tok=` is read CLIENT-side and never reflected into the markup.
 *  - The bind happens on a human button CLICK (POST), NEVER on GET — an email
 *    link-preview prefetch can't complete it.
 *  - The page identifies CLIENT-side (real geo/IP) keyed to the SERVER-proven
 *    `contactKey` the exchange returns — it never sends a distinct_id the server
 *    resolves a contact on, so there is no graft/takeover vector.
 *  - posthog-js inits with `cross_subdomain_cookie: true` so it reads the
 *    visitor's existing `.hogsend.com` distinct_id and folds their prior
 *    anonymous browsing into the now-identified person.
 *
 * Branding is plain-text/JSON-embedded; `accentColor` is regex-validated.
 */
export function coldConnectPageHtml(
  branding: ColdConnectBranding,
  opts: {
    posthogKey: string | null;
    posthogHost: string | null;
    exchangeUrl: string;
    identifyPropKey: string;
  },
): string {
  const accent =
    branding.accentColor && ACCENT_RE.test(branding.accentColor)
      ? branding.accentColor
      : DEFAULT_ACCENT;

  const config = JSON.stringify({
    posthogKey: opts.posthogKey,
    // posthog-js falls back to US when host is null; an EU deploy must set
    // POSTHOG_HOST.
    posthogHost: opts.posthogHost,
    exchangeUrl: opts.exchangeUrl,
    identifyPropKey: opts.identifyPropKey,
    badge: branding.badge,
    title: branding.title,
    blurb: branding.blurb,
    successCopy: branding.successCopy,
    errorCopy: branding.errorCopy,
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Connect</title>
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
        background: ${accent}26; font-size: 28px;
      }
      h1 { font-size: 20px; margin: 0 0 8px; font-weight: 600; }
      p { margin: 0 0 24px; color: rgba(250,250,250,0.7); line-height: 1.6; }
      button {
        appearance: none; border: 0; border-radius: 10px; cursor: pointer;
        background: ${accent}; color: #fff; font-size: 15px; font-weight: 600;
        padding: 12px 20px; width: 100%;
      }
      button:disabled { opacity: 0.6; cursor: default; }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="badge" id="badge" aria-hidden="true"></div>
      <h1 id="h"></h1>
      <p id="p"></p>
      <button id="btn" type="button">Confirm connection</button>
    </main>
    <script>
      var CFG = ${config};
      var tok = new URLSearchParams(location.search).get("tok");
      var btn = document.getElementById("btn");
      var h = document.getElementById("h");
      var p = document.getElementById("p");
      var badge = document.getElementById("badge");

      badge.textContent = CFG.badge;
      h.textContent = CFG.title;
      p.textContent = CFG.blurb;

      function loadPosthog(host) {
        !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
        window.posthog.init(CFG.posthogKey, {
          api_host: host,
          person_profiles: "always",
          cross_subdomain_cookie: true,
        });
      }

      function done(ok, key, platformUserId) {
        btn.style.display = "none";
        if (ok && CFG.posthogKey) {
          try {
            loadPosthog(CFG.posthogHost || "https://us.i.posthog.com");
            var props = {};
            props[CFG.identifyPropKey] = platformUserId;
            window.posthog.identify(key, props);
          } catch (e) {}
        }
        var copy = ok ? CFG.successCopy : CFG.errorCopy;
        h.textContent = copy.heading;
        p.textContent = copy.body;
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
          .then(function (j) { done(!!j.ok, j.key, j.platformUserId); })
          .catch(function () { done(false); });
      });
    </script>
  </body>
</html>`;
}
