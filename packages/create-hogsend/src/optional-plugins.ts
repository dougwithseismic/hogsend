/**
 * Opt-in provider plugins the scaffolder can add to a generated app
 * (`--with <id>` / the "Optional providers" multiselect).
 *
 * These are DELIBERATELY not in `HOGSEND_PACKAGES` / `template/_package.json`:
 * they are not scaffold defaults, and `release-doctor` asserts those default
 * lists agree exactly. Selecting one does exactly two things — pins the plugin
 * package as a dependency of the generated app, and surfaces its credential
 * block in `.env.example`. No code wiring: once the package is installed and
 * the credential is set, the engine's env preset registers the provider itself.
 *
 * The package MUST be a DIRECT dependency of the generated app, not merely an
 * engine `optionalDependency`. The app bundles the engine, so the engine's lazy
 * `import("@hogsend/plugin-<id>")` resolves against the APP's node_modules —
 * where an engine-only optional dependency is installed under `.pnpm/` but
 * never linked at the top level. That gap shipped for three releases as
 * "credential set, feature silently inert" (#611); this list is the fix's
 * scaffold-side half.
 */

export type OptionalPluginId = "apollo" | "hogsend" | "postmark" | "twilio";

export interface OptionalPlugin {
  /** The `--with <id>` / multiselect value. */
  id: OptionalPluginId;
  /** npm package name, pinned to the engine line in the emitted package.json. */
  pkg: string;
  /** Multiselect label. */
  label: string;
  /** Multiselect hint. */
  hint: string;
  /**
   * The gating credential key. The env block is only appended when this key is
   * absent from the emitted `.env.example` — the template may already document
   * the credential (Apollo does), and a duplicate block would be noise.
   */
  envKey: string;
  /**
   * Commented credential block appended to `.env.example`. Keys only — NEVER
   * a fake or placeholder credential value.
   */
  envBlock: string;
}

export const OPTIONAL_PLUGINS: OptionalPlugin[] = [
  {
    id: "apollo",
    pkg: "@hogsend/plugin-apollo",
    label: "Apollo enrichment",
    hint: "refineContact() person + company intelligence — needs APOLLO_API_KEY",
    envKey: "APOLLO_API_KEY",
    envBlock: `# Apollo enrichment (selected at scaffold time — @hogsend/plugin-apollo is a
# direct dependency of this app). Set the key and the engine's env preset
# registers the provider on boot; no code change needed.
# APOLLO_API_KEY=`,
  },
  {
    id: "hogsend",
    pkg: "@hogsend/plugin-hogsend",
    label: "Hogsend Email (Hogsend Cloud)",
    hint: "first-party sending through Hogsend Cloud — needs HOGSEND_EMAIL_TOKEN",
    envKey: "HOGSEND_EMAIL_TOKEN",
    envBlock: `# Hogsend Email (selected at scaffold time — @hogsend/plugin-hogsend is a
# direct dependency of this app). Sending through Hogsend Cloud's relay, so the
# credentials come from Cloud: a provisioned environment injects all three, and
# nothing else issues them. Set the token and the engine's env preset registers
# the provider on boot; EMAIL_PROVIDER=hogsend makes it the active sender
# (Resend stays the default otherwise). The webhook secret is what delivery and
# bounce updates are authenticated with — without it they are all rejected.
# HOGSEND_EMAIL_TOKEN=
# HOGSEND_EMAIL_RELAY_URL=
# HOGSEND_EMAIL_WEBHOOK_SECRET=
# EMAIL_PROVIDER=hogsend`,
  },
  {
    id: "postmark",
    pkg: "@hogsend/plugin-postmark",
    label: "Postmark email provider",
    hint: "alternative to Resend — needs POSTMARK_SERVER_TOKEN",
    envKey: "POSTMARK_SERVER_TOKEN",
    envBlock: `# Postmark email provider (selected at scaffold time — @hogsend/plugin-postmark
# is a direct dependency of this app). Set the server token and the engine's
# env preset registers the provider on boot; EMAIL_PROVIDER=postmark makes it
# the active sender (Resend stays the default otherwise).
# POSTMARK_SERVER_TOKEN=
# EMAIL_PROVIDER=postmark`,
  },
  {
    id: "twilio",
    pkg: "@hogsend/plugin-twilio",
    label: "Twilio SMS provider",
    hint: "SMS channel — needs TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN",
    envKey: "TWILIO_ACCOUNT_SID",
    envBlock: `# Twilio SMS provider (selected at scaffold time — @hogsend/plugin-twilio is a
# direct dependency of this app). Set both credentials and the engine's env
# preset registers the provider on boot. Sends also need a sender: SMS_FROM
# (an E.164 number) or TWILIO_MESSAGING_SERVICE_SID.
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# SMS_FROM=`,
  },
];

export const OPTIONAL_PLUGIN_IDS = OPTIONAL_PLUGINS.map((p) => p.id);

export function optionalPlugin(id: OptionalPluginId): OptionalPlugin {
  // The array is the source of truth; ids are validated before this is called.
  const plugin = OPTIONAL_PLUGINS.find((p) => p.id === id);
  if (!plugin) throw new Error(`Unknown optional plugin "${id}".`);
  return plugin;
}

/**
 * Parse `--with` values: the flag is repeatable AND each value may be a
 * comma-separated list (`--with apollo --with twilio` == `--with apollo,twilio`).
 * Order-preserving dedupe; an unknown id throws, naming the valid ids.
 */
export function parseWithFlag(values: string[]): OptionalPluginId[] {
  const ids: OptionalPluginId[] = [];
  for (const raw of values.flatMap((v) => v.split(","))) {
    const id = raw.trim();
    if (id === "") continue;
    if (!(OPTIONAL_PLUGIN_IDS as string[]).includes(id)) {
      throw new Error(
        `Invalid --with "${id}". Expected one of: ${OPTIONAL_PLUGIN_IDS.join(", ")}.`,
      );
    }
    if (!ids.includes(id as OptionalPluginId)) {
      ids.push(id as OptionalPluginId);
    }
  }
  return ids;
}
