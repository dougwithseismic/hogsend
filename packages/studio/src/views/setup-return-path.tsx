import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { DnsRecord, EngineDomainStatus } from "@/lib/admin-api";

/**
 * The branded return path as a labelled upgrade on Setup (PRD 20). The return
 * path carries BOUNCE traffic; switching it on routes bounces through
 * `<label>.<domain>` at the cost of two extra DNS records (MX + SPF). It
 * changes nothing about where a customer's incoming mail lands — no copy in
 * this file may suggest otherwise (the `repl` test pins that).
 *
 * Off is the default and NOT a warning state: a domain without the upgrade is
 * fully verified on its base records, so this card must never render a warning
 * icon, amber styling, or "action required" language for it.
 */

/**
 * Pinned mirror of core's `RETURN_PATH_LABEL_PATTERN` (@hogsend/core
 * providers/domains.ts) — hand-synced like `DOMAIN_RE` in setup-view.tsx,
 * because Studio ships as a standalone SPA and never imports workspace
 * packages. Drift is harmless: the engine re-validates and its 400 names the
 * label too.
 */
export const RETURN_PATH_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The provider default. An empty label input means this. */
export const DEFAULT_RETURN_PATH_LABEL = "send";

/**
 * Every user-facing string this upgrade adds, in one sweepable place. The
 * benefit is stated in the customer's terms FIRST, with the two-record cost in
 * the same breath; the mechanism is a second line for people who want it.
 * Hand-synced word-for-word with the CLI's `hogsend domain return-path`
 * output (packages/cli/src/commands/domain.ts) — two renderers, one text.
 */
export const RETURN_PATH_COPY = {
  title: "Branded return path",
  benefit:
    'Gmail stops showing "via amazonses.com" under your sender name, and ' +
    "SPF passes on your own domain. Costs two more DNS records (MX and SPF).",
  mechanism:
    "Bounce traffic routes through a subdomain of your domain in place of " +
    "the provider's own. Where your incoming mail lands does not change.",
  unavailable:
    "Not available: the active email provider or engine version cannot " +
    "switch the return path. The sending domain verifies fully without it.",
  labelSummary: "Choose the return path subdomain",
  labelHelp:
    "One DNS label in front of your domain. The default is " +
    `${DEFAULT_RETURN_PATH_LABEL}, so bounces route through ` +
    `${DEFAULT_RETURN_PATH_LABEL}.<your domain>.`,
  enabledToastTitle: "Return path on",
  enabledToastBody: "Publish the two new DNS records shown in the table.",
  disabledToastTitle: "Return path off",
  disabledToastBody:
    "Bounces route through the provider default. The domain stays verified " +
    "on its base records.",
  failedToastTitle: "Return path change failed",
  unsupportedToast: "The active email provider cannot switch the return path.",
} as const;

/** The rejection names the offending label, not just a pattern. */
export function returnPathInvalidLabel(label: string): string {
  return (
    `"${label}" is not a valid subdomain label. Use one DNS label: ` +
    "lowercase letters, digits and hyphens, starting and ending " +
    "alphanumeric, 63 characters or fewer, no dots."
  );
}

/**
 * The purposes the return-path records carry (mx + spf today; `return_path`
 * accepted for providers that tag them explicitly). The wire has no boolean
 * for "is the return path on", so presence of these records IS the on state —
 * the engine stops reporting them when it is switched off.
 */
const RETURN_PATH_PURPOSES: ReadonlySet<DnsRecord["purpose"]> = new Set([
  "mx",
  "spf",
  "return_path",
]);

export function returnPathRecordsOf(status: EngineDomainStatus): DnsRecord[] {
  return (status.status?.records ?? []).filter((record) =>
    RETURN_PATH_PURPOSES.has(record.purpose),
  );
}

export function returnPathEnabledFrom(status: EngineDomainStatus): boolean {
  return returnPathRecordsOf(status).length > 0;
}

export type ReturnPathPlan =
  | { kind: "submit"; body: { enabled: boolean; label?: string } }
  | { kind: "reject"; message: string };

/**
 * Decide what a toggle flip should send, or why it must not. Pure so the
 * validation (reject BEFORE any HTTP, naming the label) is testable without a
 * DOM. An empty input means the default label; the default is omitted from
 * the wire so the engine's own default applies.
 */
export function planReturnPathSwitch(opts: {
  turnOn: boolean;
  label: string;
}): ReturnPathPlan {
  if (!opts.turnOn) return { kind: "submit", body: { enabled: false } };

  const raw = opts.label.trim() === "" ? DEFAULT_RETURN_PATH_LABEL : opts.label;
  const normalized = raw.trim().toLowerCase();
  if (!RETURN_PATH_LABEL_RE.test(normalized)) {
    return { kind: "reject", message: returnPathInvalidLabel(opts.label) };
  }
  return {
    kind: "submit",
    body: {
      enabled: true,
      ...(normalized === DEFAULT_RETURN_PATH_LABEL
        ? {}
        : { label: normalized }),
    },
  };
}

/**
 * Presentational card. The parent (SetupView) owns the mutation; this only
 * decides what to render and what body a flip submits. When the capability is
 * absent — `returnPathSupported` false, or missing entirely because Studio is
 * talking to an older engine — it reports the upgrade as unavailable and
 * renders NO control at all (an EARS criterion): a dead toggle would promise
 * a switch the POST would 501.
 */
export function ReturnPathCard({
  data,
  pending,
  onSet,
}: {
  data: EngineDomainStatus;
  pending: boolean;
  onSet: (body: { enabled: boolean; label?: string }) => void;
}) {
  const [label, setLabel] = useState(DEFAULT_RETURN_PATH_LABEL);
  const [labelError, setLabelError] = useState<string | null>(null);

  if (data.returnPathSupported !== true) {
    return (
      <div className="space-y-1 rounded-lg border bg-white/[0.015] p-4">
        <h3 className="text-sm font-medium text-white">
          {RETURN_PATH_COPY.title}
        </h3>
        <p className="text-xs text-white/50">{RETURN_PATH_COPY.unavailable}</p>
      </div>
    );
  }

  const enabled = returnPathEnabledFrom(data);
  const mailFrom = returnPathRecordsOf(data)[0]?.name ?? null;

  const handleToggle = (next: boolean) => {
    const plan = planReturnPathSwitch({ turnOn: next, label });
    if (plan.kind === "reject") {
      setLabelError(plan.message);
      return;
    }
    setLabelError(null);
    onSet(plan.body);
  };

  return (
    <div className="space-y-3 rounded-lg border bg-white/[0.015] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-white">
            {RETURN_PATH_COPY.title}
          </h3>
          <p className="mt-1 text-xs text-white/60">
            {RETURN_PATH_COPY.benefit}
          </p>
          <p className="mt-1 text-xs text-white/40">
            {RETURN_PATH_COPY.mechanism}
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={pending}
          aria-label={RETURN_PATH_COPY.title}
        />
      </div>

      {enabled && mailFrom ? (
        <p className="text-xs text-white/50">
          On. Bounces route through {mailFrom}.
        </p>
      ) : null}

      {enabled ? null : (
        <details className="text-xs">
          <summary className="cursor-pointer text-white/50">
            {RETURN_PATH_COPY.labelSummary}
          </summary>
          <div className="mt-2 max-w-xs space-y-1.5">
            <Label htmlFor="return-path-label">Subdomain label</Label>
            <Input
              id="return-path-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <p className="text-white/40">{RETURN_PATH_COPY.labelHelp}</p>
          </div>
        </details>
      )}

      {labelError ? (
        <p className="text-xs text-destructive">{labelError}</p>
      ) : null}
    </div>
  );
}
