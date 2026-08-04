import { Globe } from "lucide-react";
import type { JSX } from "react";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { CopyValue } from "./copy-value";

/**
 * Where this instance answers, on the web.
 *
 * One row per hostname, each with the thing you actually want from it: the
 * value to copy, and a link to open. Today an instance has exactly one address
 * — the one the substrate issued — so this panel is a list of one. It is a
 * panel rather than a row on the facts card because customer-supplied domains
 * land here next, and their verification state needs the room.
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
  return (
    <Card className="flex flex-col p-0">
      <div className="flex flex-col gap-1.5 px-6 pt-6 pb-5">
        <h2 className="font-medium text-white tracking-[-0.02em]">
          Networking
        </h2>
        <p className="max-w-prose text-sm text-white/60 leading-6">
          The address your instance answers on. Your app sends events here, and
          the links in your emails are built from it.
        </p>
      </div>

      <Hairline />

      {apiUrl ? (
        <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <span className="flex items-center gap-3">
            <Globe
              aria-hidden
              className="size-4 text-white/40"
              strokeWidth={2}
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-mono text-sm text-white/80">{apiUrl}</span>
              {studioUrl ? (
                <a
                  href={studioUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="w-fit text-white/50 text-xs underline underline-offset-2 transition-colors hover:text-white"
                >
                  Studio runs at {studioUrl}
                </a>
              ) : null}
            </span>
          </span>
          <CopyValue value={apiUrl} label="instance URL" buttonOnly />
        </div>
      ) : (
        <p className="max-w-prose px-6 py-4 text-sm text-white/60 leading-6">
          Your address is issued while the instance is being set up. It appears
          here as soon as it exists.
        </p>
      )}
    </Card>
  );
}
