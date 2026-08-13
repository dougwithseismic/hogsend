/**
 * PLACEHOLDER result pages for the hosted account-link flow.
 *
 * **PRD 10 owns the real pages** (shared branding module, `postMessage` to the
 * configured origin allowlist, the headless `resultRedirect` escape hatch, the
 * cold-connect XSS posture). PRD 07 ships this minimum so the callback has
 * somewhere to land, and PRD 10 REPLACES it — do not grow features here.
 *
 * What is NOT placeholder, and must survive the replacement:
 *
 *  - Nothing player-supplied is interpolated. The only dynamic value is the
 *    provider's display name, which comes from the registry (our own config),
 *    and it is escaped anyway.
 *  - The failure page never says WHICH of the four reasons occurred. `denied`,
 *    `vetoed`, `exchange_failed` and `state_invalid` are operator facts on the
 *    `account.link_failed` event, not player-facing copy: telling an attacker
 *    "that state was already used" vs "that signature was wrong" is a probing
 *    oracle.
 *  - `noindex`, because these URLs land in browser history and chat unfurls.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(heading: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(heading)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid;
         place-items: center; min-height: 100vh; color: #111; }
  main { max-width: 32rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #444; }
</style>
</head>
<body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p></main></body>
</html>`;
}

export function accountLinkSuccessPage(providerName: string): string {
  return page(
    `${providerName} account linked`,
    "You can close this window and go back to where you started.",
  );
}

export function accountLinkErrorPage(providerName: string): string {
  return page(
    `We couldn't link your ${providerName} account`,
    "Nothing was changed. You can close this window and try again.",
  );
}
