export const SITE_URL = "https://hogsend.com";
export const GITHUB_URL = "https://github.com/dougwithseismic/hogsend";
export const NPM_URL = "https://www.npmjs.com/package/@hogsend/engine";
export const DISCORD_INVITE_URL = "https://discord.gg/rv6eZNvYrr";
// Stable per-OS download URLs (published by apps/desktop/scripts/release.sh to
// the `desktop-latest` release). The Windows asset lands with the first Windows
// release; until then that link 404s, so the nav only shows the link for the
// platform(s) we've shipped — see DownloadNavLink.
export const DESKTOP_DOWNLOAD_URL_MAC =
  "https://github.com/dougwithseismic/hogsend/releases/download/desktop-latest/Hogsend.dmg";
export const DESKTOP_DOWNLOAD_URL_WIN =
  "https://github.com/dougwithseismic/hogsend/releases/download/desktop-latest/Hogsend-setup.exe";
/** @deprecated Use the per-OS constants. Kept as the macOS alias. */
export const DESKTOP_DOWNLOAD_URL = DESKTOP_DOWNLOAD_URL_MAC;
/** Which desktop builds we actually ship. Flip `windows` once the first
 *  Windows release is cut so the nav link stops 404-ing. */
export const DESKTOP_BUILDS = { mac: true, windows: true } as const;
export const RAILWAY_DEPLOY_URL =
  "https://railway.com/deploy/hogsend-posthog-audience-stack";
export const ENGINE_VERSION = "0.26.0"; // bump per release
export const CONTACT_EMAIL = "doug@withseismic.com";
export const LINKEDIN_URL = "https://www.linkedin.com/in/dougsilkstone/";
