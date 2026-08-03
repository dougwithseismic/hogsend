import { loadDotEnv } from "./config.js";
import { isLoopbackUrl } from "./loopback-url.js";

/**
 * Where the CLOUD is, as distinct from where an INSTANCE is.
 *
 * `config.ts` resolves `--url` — the Hogsend engine you operate: your own
 * running API, admin key and all. That target is unrelated to the control plane
 * `hogsend login`/`publish` talk to, and conflating them would be a real
 * hazard: a cwd `.env` carrying `HOGSEND_API_URL` for a local instance must
 * never become the host a credential is minted against. So this is a separate
 * resolution with its own flag, its own variable, and its own default, and
 * `resolveConfig` is left exactly as it was.
 *
 * Precedence mirrors the existing law — flag > process.env > .env > default:
 *
 *   --cloud <url> > HOGSEND_CLOUD_URL (env) > HOGSEND_CLOUD_URL (.env)
 *                 > https://cloud.hogsend.com
 */

/** The managed control plane. Overridable for self-hosted/staging clouds. */
export const DEFAULT_CLOUD_URL = "https://cloud.hogsend.com";

export interface ResolvedCloud {
  /** Base URL, no trailing slash. */
  baseUrl: string;
  /**
   * The credentials-file key: `host[:port]`, lowercased. The KEY is the host
   * rather than the whole URL so `https://cloud.hogsend.com` and
   * `https://cloud.hogsend.com/` are one entry rather than two, and so a
   * credential can never be looked up under a path a caller appended.
   *
   * The SCHEME is deliberately absent from the key — and that is only sound
   * because {@link normalizeCloudUrl} refuses plain http to a non-loopback
   * host outright. Without that refusal a host-only key would be a downgrade
   * hole: a token minted over `https://cloud.hogsend.com` would be looked up
   * and sent to `http://cloud.hogsend.com`, i.e. a bearer in cleartext, from
   * nothing louder than a `HOGSEND_CLOUD_URL` line in a cwd `.env`. The two
   * decisions are one decision; do not relax either alone.
   */
  host: string;
  /** True when `--cloud` named it explicitly (vs env / .env / the default). */
  explicit: boolean;
}

/**
 * A cloud URL that would put a session token on the wire in cleartext.
 *
 * Thrown rather than downgraded-silently: `login` mints a `hscli_…` bearer
 * over this connection and every later command sends it, so plain http to a
 * host that is not this machine is never a preference to honour. Mirrors the
 * refusal `hogsend connect discord` already makes for its bot token.
 */
export class InsecureCloudUrlError extends Error {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    // One message, carrying the next move: nothing catches this, so what the
    // router prints is all the operator gets.
    super(
      `${baseUrl} is plain http — refusing to mint or send a Hogsend Cloud ` +
        `session token to a remote host unencrypted. Use https://${new URL(baseUrl).host} ` +
        "instead; plain http is accepted only for a loopback cloud " +
        "(localhost / 127.0.0.1 / ::1).",
    );
    this.name = "InsecureCloudUrlError";
    this.baseUrl = baseUrl;
  }
}

/**
 * Normalise a user-supplied cloud URL, defaulting a missing scheme to https.
 *
 * This is the ONE funnel every cloud base URL passes through (`--cloud`, the
 * env var, the `.env` line, the default), which is why the transport refusal
 * lives here rather than at each call site.
 */
export function normalizeCloudUrl(raw: string): ResolvedCloud["baseUrl"] {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  // Throws on genuinely unparseable input — the caller renders it as a usage
  // error rather than silently minting against something unintended.
  const url = new URL(withScheme);
  const baseUrl = `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}`;
  // Fail closed on a downgrade. Loopback stays plain-http-able: there is no
  // wire to sniff, and `hogsend login --cloud http://localhost:3004` is how
  // the control plane is developed.
  if (url.protocol === "http:" && !isLoopbackUrl(baseUrl)) {
    throw new InsecureCloudUrlError(baseUrl);
  }
  return baseUrl;
}

/** The credentials-file key for a resolved base URL. */
export function cloudHostKey(baseUrl: string): string {
  return new URL(baseUrl).host.toLowerCase();
}

export function resolveCloud(
  flags: { cloud?: string } = {},
  cwd: string = process.cwd(),
): ResolvedCloud {
  const dotenv = loadDotEnv(cwd);
  const raw =
    flags.cloud ??
    process.env.HOGSEND_CLOUD_URL ??
    dotenv.HOGSEND_CLOUD_URL ??
    DEFAULT_CLOUD_URL;

  const baseUrl = normalizeCloudUrl(raw);
  return {
    baseUrl,
    host: cloudHostKey(baseUrl),
    explicit: Boolean(flags.cloud),
  };
}
