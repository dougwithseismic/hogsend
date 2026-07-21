"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import {
  PRODUCT_MONO_VALUE_CLASS,
  PRODUCT_ROW_LIST_CLASS,
  ProductCard,
  ProductCardFooter,
  ProductCardHeader,
  ProductLabel,
  ProductStat,
  ProductTag,
  productRowClass,
  productRowLabelClass,
} from "./product-card";

/**
 * Tracked links + QR — the direct-mail demo. Three rows tell the whole story:
 * a public print-run code, a personal per-recipient code, and the re-target
 * (same printed code, new destination).
 *
 * The QR images are REAL: generated server-side in the page with the same
 * `qrcode` library the engine's `GET /v1/admin/links/:id/qr` endpoint uses,
 * and (like the engine) they encode the durable `/v1/t/c/<uid>` URL — never
 * the slug — which is exactly why a printed code can be re-pointed later.
 * Counts are illustrative; every mechanism named is the shipping API.
 */

type LinkKey = "print" | "personal" | "retarget";

const LINK_ORDER: readonly LinkKey[] = ["print", "personal", "retarget"];

interface DemoLink {
  label: string;
  tag: string;
  /** What this row proves, under the QR. */
  body: string;
  stats: Array<{ value: string; label: string; meter?: number }>;
  /** Mono footer readout. */
  readout: { left: string; right: string };
}

const LINKS: Record<LinkKey, DemoLink> = {
  print: {
    label: "/l/spring-mailer",
    tag: "public",
    body: "One code on 5,000 postcards. A public link never carries a person — scans count separately from web clicks, so the mailer reports like a channel.",
    stats: [
      { value: "1,204", label: "qr scans", meter: 0.62 },
      { value: "310", label: "web clicks", meter: 0.16 },
      { value: "9.8%", label: "scan rate", meter: 0.4 },
    ],
    readout: {
      left: 'link.clicked · source: "qr"',
      right: "→ journey enrolled",
    },
  },
  personal: {
    label: "jamie@northwind.io",
    tag: "personal",
    body: "Minted per recipient, the code carries the person. The scan lands in the event stream as Jamie — identified, no typing, no form.",
    stats: [
      { value: "1", label: "recipient" },
      { value: "scanned", label: "status" },
      { value: "identified", label: "arrival" },
    ],
    readout: {
      left: "link.clicked",
      right: "distinct_id: jamie@northwind.io",
    },
  },
  retarget: {
    label: "/l/spring-mailer",
    tag: "re-pointed",
    body: "The exact code you already printed, the QR encodes the durable engine URL, never the slug or destination. One call re-points 5,000 postcards to the new landing page.",
    stats: [
      { value: "0", label: "reprints" },
      { value: "1", label: "api call" },
      { value: "5,000", label: "mailers updated" },
    ],
    readout: {
      left: "hs.links.update(link.id)",
      right: '{ originalUrl: "…/spring-offer-v2" }',
    },
  },
};

type QrLinksCardProps = {
  /** Real QR SVG markup per row, rendered server-side with `qrcode`. */
  qr: Record<LinkKey, string>;
};

export function QrLinksCard({ qr }: QrLinksCardProps) {
  const [selected, setSelected] = useState<LinkKey>("print");
  const active = LINKS[selected];

  return (
    <ProductCard className="mx-auto max-w-[720px]">
      <ProductCardHeader
        title="spring-mailer"
        tag={<ProductTag>tracked link</ProductTag>}
        description="Minted with one call, hs.links.create() or the Studio Links view. SVG and PNG QR straight from the API."
      />

      <fieldset aria-label="Link variant" className={PRODUCT_ROW_LIST_CLASS}>
        {LINK_ORDER.map((key) => {
          const isActive = key === selected;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={isActive}
              onClick={() => setSelected(key)}
              className={cn(
                "flex items-center justify-between gap-3 text-left outline-none transition-colors",
                productRowClass(isActive),
                !isActive && "hover:bg-white/[0.03]",
              )}
            >
              <span
                className={cn(
                  "truncate font-mono transition-colors",
                  productRowLabelClass(isActive),
                )}
              >
                {LINKS[key].label}
              </span>
              <span className="shrink-0 rounded-[4px] bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
                {LINKS[key].tag}
              </span>
            </button>
          );
        })}
      </fieldset>

      <div aria-live="polite" className="px-4 py-5">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          {/* The real QR — white quiet zone, like the print asset. */}
          <div
            aria-label={`QR code for ${active.label}`}
            role="img"
            className="w-[132px] shrink-0 self-center rounded-md bg-white p-2.5 sm:self-start [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: server-generated SVG from the qrcode library, no user input
            dangerouslySetInnerHTML={{ __html: qr[selected] }}
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-white/55 leading-[21px] tracking-[-0.02em]">
              {active.body}
            </p>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {active.stats.map((s) => (
                <ProductStat
                  key={s.label}
                  value={s.value}
                  label={s.label}
                  meter={s.meter}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <ProductCardFooter>
        <ProductLabel className="mb-1.5">on scan</ProductLabel>
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-1",
            PRODUCT_MONO_VALUE_CLASS,
          )}
        >
          <span className="text-white/55">{active.readout.left}</span>
          <span className="text-[#f8a08f]">{active.readout.right}</span>
        </div>
      </ProductCardFooter>
    </ProductCard>
  );
}
