"use client";

import Link from "next/link";
import { type JSX, useEffect, useState } from "react";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import {
  PRODUCT_MONO_VALUE_CLASS,
  ProductCard,
  ProductCardFooter,
  ProductCardHeader,
  ProductTag,
} from "./product-card";

/** Session-scoped dismissal — closing the card keeps it closed for the visit,
 * not forever; a returning visitor is exactly who the offer is for. */
const DISMISSED_KEY = "hs:dfy-callout-dismissed";

/**
 * DfyCallout — the done-for-you service card, fixed bottom-right on the
 * homepage, built on the ProductCard kit so it reads as one of the landing
 * page's product surfaces (the flag card, the timing card). Desktop-only
 * (`lg:block`), it fades in once the visitor has scrolled a viewport past
 * the hero and fades back out when the footer enters view (the footer
 * carries its own "Done-for-you setup" link, so the card would be redundant
 * noise there). Bottom-LEFT belongs to the cookie banner — no collision.
 *
 * The hero component varies by day/query (wired / field / matchday /
 * classic), so visibility keys on scroll depth rather than observing a
 * specific hero node.
 */
export function DfyCallout(): JSX.Element | null {
  const [dismissed, setDismissed] = useState(true);
  const [scrolledPastHero, setScrolledPastHero] = useState(false);
  const [footerInView, setFooterInView] = useState(false);

  useEffect(() => {
    setDismissed(window.sessionStorage.getItem(DISMISSED_KEY) === "1");

    const sync = () => setScrolledPastHero(window.scrollY > window.innerHeight);
    sync();
    window.addEventListener("scroll", sync, { passive: true });

    // The homepage's PsFooter is the page's only <footer>; query generically
    // so this survives footer refactors.
    const footer = document.querySelector("footer");
    let observer: IntersectionObserver | undefined;
    if (footer && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(([entry]) => {
        setFooterInView(entry?.isIntersecting ?? false);
      });
      observer.observe(footer);
    }
    return () => {
      window.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  }, []);

  if (dismissed) return null;

  const visible = scrolledPastHero && !footerInView;

  return (
    <aside
      aria-label="Done-for-you service"
      aria-hidden={!visible}
      className={cn(
        "fixed right-4 bottom-4 z-40 hidden w-[360px] transition-[opacity,translate] duration-300 lg:block",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0",
      )}
    >
      <ProductCard>
        <ProductCardHeader
          title="hire-doug"
          tag={
            <span className="flex shrink-0 items-center gap-1.5">
              <ProductTag tone="crimzon" pulse>
                done-for-you
              </ProductTag>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => {
                  window.sessionStorage.setItem(DISMISSED_KEY, "1");
                  setDismissed(true);
                }}
                className="flex h-5 w-5 items-center justify-center rounded text-white/35 transition-colors hover:text-white"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M1.5 1.5l7 7M8.5 1.5l-7 7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </span>
          }
          description="Hire Doug to build your growth engine — designed, built, and run in your repo."
        />

        <ProductCardFooter>
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-2 gap-y-1",
              PRODUCT_MONO_VALUE_CLASS,
            )}
          >
            <span className="text-white/55">Audit $2,000</span>
            <span className="text-white/30">·</span>
            <span className="text-[#f8a08f]">Run from $4,000/mo</span>
          </div>
          <Link
            href="/service"
            onClick={() =>
              capture(AnalyticsEvent.SERVICE_CALLOUT_CLICKED, {
                placement: "home-floating",
              })
            }
            className="mt-3 flex h-9 w-full items-center justify-center rounded-[8px] bg-white px-4 font-medium text-[#0a0a0a] text-sm transition-colors hover:bg-white/90"
          >
            Start with an audit&nbsp;→
          </Link>
        </ProductCardFooter>
      </ProductCard>
    </aside>
  );
}
