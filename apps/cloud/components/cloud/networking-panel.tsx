import { ArrowUpRight } from "lucide-react";
import type { JSX } from "react";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { CopyValue } from "./copy-value";

/**
 * Where this instance answers, on the web.
 *
 * The address leads. It is the one thing anybody opens this panel for, so it is
 * the largest type on the card and the heading is demoted to a caption above
 * it. The one sentence that survives carries a fact you cannot read off the URL
 * — that this address is both the ingest endpoint and the base of every link in
 * your email.
 *
 * Today an instance has exactly one address — the one the substrate issued — so
 * this panel is a list of one. It is a panel rather than a row on the facts card
 * because customer-supplied domains land here next, and their verification state
 * needs the room.
 */
export function NetworkingPanel({
  apiUrl,
  studioUrl,
}: {
  /** The instance's public API URL, or null before provisioning issued one. */
  apiUrl: string | null;
  /** `<apiUrl>/studio`, or null for the same reason. */
  studioUrl: string | null;
}): JSX.Element {
  if (!apiUrl) {
    return (
      <Card className="flex flex-col gap-2">
        <h2 className="eyebrow text-white/40">Instance URL</h2>
        <p className="max-w-prose text-sm text-white/60 leading-6">
          Your address is issued while the instance is being set up. It appears
          here as soon as it exists.
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col p-0">
      <div className="flex flex-col gap-3 px-6 pt-5 pb-5">
        <h2 className="eyebrow text-white/40">Instance URL</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="break-all font-mono text-lg text-white leading-7 tracking-[-0.01em]">
            {apiUrl}
          </span>
          <CopyValue value={apiUrl} label="instance URL" buttonOnly />
        </div>
        <p className="max-w-prose text-white/45 text-xs leading-5">
          Your app sends events here, and the links in your emails are built
          from it.
        </p>
      </div>

      {studioUrl ? (
        <>
          <Hairline />
          <a
            href={studioUrl}
            target="_blank"
            rel="noreferrer"
            className="group flex items-center justify-between gap-4 px-6 py-3 text-sm transition-colors hover:bg-white/[0.03]"
          >
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="eyebrow text-white/40">Studio</span>
              <span className="break-all font-mono text-white/60 group-hover:text-white/80">
                {studioUrl}
              </span>
            </span>
            <ArrowUpRight
              aria-hidden
              className="size-4 shrink-0 text-white/40 group-hover:text-white"
              strokeWidth={2}
            />
          </a>
        </>
      ) : null}
    </Card>
  );
}
