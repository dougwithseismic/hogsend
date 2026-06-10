import { resolveNs as nodeResolveNs } from "node:dns/promises";
import type { DnsRecord } from "@hogsend/engine";

/**
 * DNS-host smarts for `hogsend domain`: detect WHERE a domain's DNS lives (via
 * its NS records) and render provider DNS records with host-specific guidance
 * + a panel deep link. Pure CLI-local helpers — no engine/provider coupling
 * beyond the neutral {@link DnsRecord} shape.
 */

export type DnsHostId =
  | "cloudflare"
  | "vercel"
  | "route53"
  | "godaddy"
  | "namecheap"
  | "porkbun"
  | "google"
  | "unknown";

export interface DnsHostInfo {
  id: DnsHostId;
  /** Human label, e.g. "Cloudflare". */
  label: string;
  /** Deep link to the host's DNS panel for the domain. */
  panelUrl: (domain: string) => string;
  /** NS hostname suffixes that identify this host. */
  nsSuffixes: string[];
}

/** The known DNS hosts, keyed by id. `unknown` is the registrar-agnostic fallback. */
export const DNS_HOSTS: Record<DnsHostId, DnsHostInfo> = {
  cloudflare: {
    id: "cloudflare",
    label: "Cloudflare",
    nsSuffixes: ["ns.cloudflare.com"],
    panelUrl: (domain) =>
      `https://dash.cloudflare.com/?to=/:account/${domain}/dns/records`,
  },
  vercel: {
    id: "vercel",
    label: "Vercel",
    nsSuffixes: ["vercel-dns.com"],
    panelUrl: (domain) => `https://vercel.com/dashboard/domains/${domain}`,
  },
  route53: {
    id: "route53",
    label: "AWS Route 53",
    nsSuffixes: ["awsdns-"],
    panelUrl: () => "https://console.aws.amazon.com/route53/v2/hostedzones",
  },
  godaddy: {
    id: "godaddy",
    label: "GoDaddy",
    nsSuffixes: ["domaincontrol.com"],
    panelUrl: (domain) =>
      `https://dcc.godaddy.com/control/portfolio/${domain}/settings`,
  },
  namecheap: {
    id: "namecheap",
    label: "Namecheap",
    nsSuffixes: ["registrar-servers.com"],
    panelUrl: (domain) =>
      `https://ap.www.namecheap.com/domains/domaincontrolpanel/${domain}/advancedns`,
  },
  porkbun: {
    id: "porkbun",
    label: "Porkbun",
    nsSuffixes: ["porkbun.com"],
    panelUrl: (domain) => `https://porkbun.com/account/domain/${domain}`,
  },
  google: {
    id: "google",
    label: "Google Domains",
    nsSuffixes: ["googledomains.com", "google.com"],
    panelUrl: () => "https://domains.google.com/registrar",
  },
  unknown: {
    id: "unknown",
    label: "your DNS host",
    nsSuffixes: [],
    panelUrl: (domain) => `https://${domain}`,
  },
};

/** Injectable seams for tests (NEVER hit real DNS in CI). */
export interface DetectDnsHostOptions {
  resolveNs?: (hostname: string) => Promise<string[]>;
}

/**
 * Detect a domain's DNS host by resolving its NS records and suffix-matching
 * against {@link DNS_HOSTS}. Walks UP the labels (`a.b.example.com` →
 * `b.example.com` → `example.com`) until NS records resolve, so subdomains
 * inherit their registrable domain's host. Any resolver failure → `unknown`
 * (this NEVER throws — host detection is best-effort UX, not a gate).
 */
export async function detectDnsHost(
  domain: string,
  opts: DetectDnsHostOptions = {},
): Promise<DnsHostInfo> {
  const resolveNs = opts.resolveNs ?? nodeResolveNs;

  const labels = domain.toLowerCase().split(".").filter(Boolean);
  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join(".");
    let nameservers: string[];
    try {
      nameservers = await resolveNs(candidate);
    } catch {
      continue; // walk up one label and retry
    }
    if (nameservers.length === 0) continue;

    const lowered = nameservers.map((ns) => ns.toLowerCase());
    for (const host of Object.values(DNS_HOSTS)) {
      if (host.id === "unknown") continue;
      const matched = host.nsSuffixes.some((suffix) =>
        lowered.some((ns) => ns.includes(suffix)),
      );
      if (matched) return host;
    }
    // NS resolved but nothing matched — it's a host we don't know.
    return DNS_HOSTS.unknown;
  }
  return DNS_HOSTS.unknown;
}

/** Hosts whose DNS panels expect the record host RELATIVE to the domain. */
const RELATIVE_HOST_IDS = new Set<DnsHostId>(["namecheap", "godaddy"]);

/** Strip a trailing `.domain` (or bare-domain → `@`) for relative-host panels. */
function relativeName(name: string, domain: string): string {
  const lowered = name.toLowerCase();
  const suffix = `.${domain.toLowerCase()}`;
  if (lowered === domain.toLowerCase()) return "@";
  if (lowered.endsWith(suffix))
    return name.slice(0, name.length - suffix.length);
  return name;
}

function renderTable(rows: string[][], header: string[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, col) =>
    Math.max(...all.map((row) => (row[col] ?? "").length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, col) => cell.padEnd(widths[col] ?? 0))
      .join("  ")
      .trimEnd();
  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n");
}

/** Per-host guidance lines appended under the record table. */
function hostGuidance(host: DnsHostInfo, domain: string | undefined): string[] {
  switch (host.id) {
    case "cloudflare":
      return [
        "Cloudflare: set Proxy status to DNS only (grey cloud) on every record —",
        "proxied (orange-cloud) records break email verification.",
      ];
    case "namecheap":
    case "godaddy":
      return [
        `${host.label}: enter the host RELATIVE to ${domain ?? "your domain"} (the table above is already relative).`,
      ];
    case "vercel":
      return [
        "Vercel: add the records under the domain's DNS tab (they apply instantly).",
      ];
    default:
      return [
        "Add these records in your DNS host's panel exactly as shown, then run",
        "`hogsend domain check` to poll verification.",
      ];
  }
}

/**
 * Render the DNS records as an aligned `type/name/value/priority/status` table
 * with host-specific guidance. For relative-host panels (Namecheap, GoDaddy)
 * the record names are stripped to be relative to `opts.domain` (skipped when
 * the domain isn't supplied — the pinned two-arg call stays valid).
 */
export function formatRecordsFor(
  host: DnsHostInfo,
  records: DnsRecord[],
  opts: { domain?: string } = {},
): string {
  if (records.length === 0) {
    return "No DNS records reported by the provider yet.";
  }

  const relative = RELATIVE_HOST_IDS.has(host.id) && opts.domain !== undefined;
  const rows = records.map((r) => [
    r.type,
    relative && opts.domain ? relativeName(r.name, opts.domain) : r.name,
    r.value,
    r.priority !== undefined ? String(r.priority) : "",
    r.status,
  ]);

  const table = renderTable(rows, [
    "type",
    "name",
    "value",
    "priority",
    "status",
  ]);

  return [table, "", ...hostGuidance(host, opts.domain)].join("\n");
}
