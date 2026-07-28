"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ds/button";
import { EmptyState } from "@/components/ds/empty-state";

/**
 * The error boundary for every route below the root layout.
 *
 * Two rules it exists to keep. First, the message is FACTUAL: a render or a
 * database read failed, and nothing about the request was necessarily saved —
 * "something went wrong, please try again" would be a guess about both. Second,
 * the digest is shown, because it is the only handle a reader has on the server
 * log entry for their failure; hiding it makes the support conversation start
 * with "roughly when was that?".
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server-side stack stays on the server (Next redacts it in
    // production); this is what the browser can contribute to the record.
    console.error("cloud route error", error);
  }, [error]);

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-2xl">
        <EmptyState
          icon={
            <AlertTriangle aria-hidden className="size-5" strokeWidth={1.75} />
          }
          title="This page did not finish loading"
          description="The server threw while rendering it. Anything you had already submitted was either applied or rejected before this point — retrying the page does not repeat it."
          actions={
            <>
              <Button type="button" onClick={reset}>
                Try again
              </Button>
              <Button href="/" variant="outline">
                Back to the overview
              </Button>
            </>
          }
        >
          {error.digest ? (
            <p className="mt-2 text-white/40 text-xs">
              Server log reference:{" "}
              <code className="font-mono text-white/70">{error.digest}</code>
            </p>
          ) : null}
          <p className="mt-2 text-white/40 text-xs">
            If it keeps happening, the{" "}
            <Link
              href="/settings"
              className="underline underline-offset-4 hover:text-white/70"
            >
              settings page
            </Link>{" "}
            carries your organization id, which pairs the reference above with
            your account.
          </p>
        </EmptyState>
      </div>
    </main>
  );
}
