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
  /** A short emoji/glyph rendered in the badge (fallback when `iconSvg` is unset). */
  badge: string;
  /**
   * Inline platform-logo SVG rendered in the badge instead of `badge`.
   *
   * SECURITY: unlike every other field here (plain text, written via
   * `textContent`), this is inlined into the page markup verbatim. It MUST be a
   * static, developer-authored `<svg>…</svg>` from connector source — NEVER
   * runtime/user input. Author it with `fill="currentColor"`; the badge tints it
   * white.
   */
  iconSvg?: string;
  /** Accent color (`#rrggbb`); validated, falls back to a safe blue. */
  accentColor?: string;
  /** Uppercase micro-label above the badge (Studio `.eyebrow`). Defaults to "Hogsend". */
  eyebrow?: string;
  /**
   * Reassurance footnote under the button ("didn't request this? ignore it").
   * Hidden once the bind resolves. Has a safe default if omitted.
   */
  reassurance?: string;
}

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
// AA-safe default (white-on-accent ≥ 4.5:1) for the Confirm button label.
const DEFAULT_ACCENT = "#1f6feb";
const DEFAULT_EYEBROW = "Hogsend";
const DEFAULT_REASSURANCE =
  "Didn't request this? You can safely close this tab — nothing is linked until you tap Confirm.";

// Faint film-grain matching the Studio surface; pure CSS, no external request.
const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

// Escapes a value for embedding inside an inline <script> as a JS literal.
// JSON.stringify does NOT escape `<`, so an embedded `</script>` would close the
// tag early; neutralizing `<`/`>`/`&` closes that breakout on this CSP-less page.
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

// Fail-closed shape check for the one raw-inlined field (`iconSvg`). It is
// documented as trusted, developer-authored markup; a malformed value falls back
// to the emoji badge rather than inlining anything unexpected.
function isSafeIconSvg(svg: string | undefined): svg is string {
  if (!svg) return false;
  const t = svg.trim();
  return t.startsWith("<svg") && !/<script|\son\w+\s*=|javascript:/i.test(t);
}

/**
 * Self-contained connect page, styled to the Hogsend Studio "Crimzon" design
 * language (ink background, hairline-bordered surface card, Inter, eyebrow
 * micro-label, faint grain) while keeping each connector's platform accent on
 * the badge tint + Confirm button.
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

  // Trusted, developer-authored static markup (see `iconSvg` security note);
  // fail-closed to the emoji badge if it doesn't look like a bare <svg>.
  const safeIconSvg = isSafeIconSvg(branding.iconSvg)
    ? branding.iconSvg
    : undefined;
  if (branding.iconSvg && !safeIconSvg) {
    console.warn(
      "[cold-connect] iconSvg failed the safe-shape check; falling back to the emoji badge",
    );
  }
  const badgeInner = safeIconSvg ?? "";

  const config = jsonForScript({
    posthogKey: opts.posthogKey,
    // posthog-js falls back to US when host is null; an EU deploy must set
    // POSTHOG_HOST.
    posthogHost: opts.posthogHost,
    exchangeUrl: opts.exchangeUrl,
    identifyPropKey: opts.identifyPropKey,
    // SVG takes precedence; emoji only fills in when there's no inline logo.
    badge: safeIconSvg ? null : branding.badge,
    eyebrow: branding.eyebrow || DEFAULT_EYEBROW,
    title: branding.title,
    blurb: branding.blurb,
    reassurance: branding.reassurance || DEFAULT_REASSURANCE,
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
      :root {
        color-scheme: dark;
        --ink: #050101;
        --surface: rgba(255, 255, 255, 0.02);
        --hairline: rgba(255, 255, 255, 0.08);
        --text: #ffffff;
        --muted: rgba(255, 255, 255, 0.6);
        /* 0.5 (not Studio's 0.4) so the 12px eyebrow clears WCAG AA. */
        --faint: rgba(255, 255, 255, 0.5);
        --accent: ${accent};
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0; min-height: 100vh; display: flex; align-items: center;
        justify-content: center; padding: 24px; position: relative;
        background: var(--ink); color: var(--text);
        font-family: "Inter", ui-sans-serif, system-ui, -apple-system,
          "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-feature-settings: "cv11", "ss01"; letter-spacing: -0.02em;
        -webkit-font-smoothing: antialiased;
      }
      /* Studio film-grain overlay. */
      body::before {
        content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
        opacity: 0.025; background-image: url("${GRAIN}");
      }
      .card {
        position: relative; z-index: 1; max-width: 400px; width: 100%;
        text-align: center; background: var(--surface);
        border: 1px solid var(--hairline); border-radius: 6px;
        padding: 40px 32px 32px;
        box-shadow: 0 24px 60px -24px rgba(0, 0, 0, 0.7);
      }
      .eyebrow {
        margin: 0 0 24px; font-size: 12px; line-height: 1; font-weight: 500;
        letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint);
      }
      .badge {
        width: 56px; height: 56px; margin: 0 auto 20px; border-radius: 9999px;
        display: flex; align-items: center; justify-content: center;
        font-size: 26px; color: #fff; background: ${accent}24;
        border: 1px solid ${accent}40;
      }
      .badge svg { width: 28px; height: 28px; display: block; }
      h1 {
        font-family: "Inter Display", "InterDisplay", "Inter", ui-sans-serif,
          system-ui, sans-serif;
        font-size: 22px; line-height: 1.2; margin: 0 0 10px; font-weight: 600;
        letter-spacing: -0.02em;
      }
      .blurb {
        margin: 0 0 24px; font-size: 14px; line-height: 1.6; color: var(--muted);
      }
      button {
        appearance: none; border: 0; border-radius: 10px; cursor: pointer;
        background: var(--accent); color: #fff; font-size: 15px; font-weight: 600;
        padding: 12px 20px; width: 100%;
        transition: filter 0.2s ease, opacity 0.2s ease;
      }
      button:hover { filter: brightness(1.08); }
      button:disabled { opacity: 0.6; cursor: default; }
      button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
      .note {
        margin: 20px 0 0; padding-top: 20px; border-top: 1px solid var(--hairline);
        font-size: 12px; line-height: 1.6; color: var(--muted);
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          transition-duration: 0.001ms !important;
          animation-duration: 0.001ms !important;
        }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <p class="eyebrow" id="eyebrow"></p>
      <div class="badge" id="badge" aria-hidden="true">${badgeInner}</div>
      <h1 id="h"></h1>
      <p class="blurb" id="p"></p>
      <button id="btn" type="button">Confirm connection</button>
      <p class="note" id="note"></p>
    </main>
    <script>
      var CFG = ${config};
      var tok = new URLSearchParams(location.search).get("tok");
      var btn = document.getElementById("btn");
      var h = document.getElementById("h");
      var p = document.getElementById("p");
      var badge = document.getElementById("badge");
      var eyebrow = document.getElementById("eyebrow");
      var note = document.getElementById("note");

      if (CFG.badge) { badge.textContent = CFG.badge; }
      eyebrow.textContent = CFG.eyebrow;
      h.textContent = CFG.title;
      p.textContent = CFG.blurb;
      note.textContent = CFG.reassurance;
      document.title = CFG.title;

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
        note.style.display = "none";
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
