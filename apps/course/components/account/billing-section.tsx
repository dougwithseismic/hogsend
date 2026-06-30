import Link from "next/link";
import { listInvoices, listPurchases } from "@/lib/billing";
import { skuTitle } from "@/lib/courses";

/** Money in minor units → display string. */
function fmtAmount(amount: number | null, currency: string | null): string {
  if (amount == null || !currency) return "";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function fmtDate(d: Date | number): string {
  const date = typeof d === "number" ? new Date(d * 1000) : d;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Server component: the user's purchases (DB truth) plus downloadable Stripe
 *  invoices where they exist. */
export async function BillingSection({ userId }: { userId: string }) {
  const [purchases, invoices] = await Promise.all([
    listPurchases(userId),
    listInvoices(userId),
  ]);

  if (purchases.length === 0) {
    return (
      <p className="text-sm text-white/50 leading-6">
        No purchases yet.{" "}
        <Link href="/" className="text-accent hover:underline">
          Browse courses →
        </Link>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-col gap-3">
        {purchases.map((p) => (
          <li
            key={`${p.courseSlug}-${p.createdAt.toISOString()}`}
            className="flex items-center justify-between gap-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4"
          >
            <div>
              <p className="font-display text-sm tracking-[-0.02em]">
                {skuTitle(p.courseSlug)}
              </p>
              <p className="mt-0.5 text-white/50 text-xs">
                {fmtDate(p.createdAt)}
                {p.status === "refunded" ? " · refunded" : ""}
              </p>
            </div>
            <span className="shrink-0 text-sm text-white/70">
              {fmtAmount(p.amount, p.currency)}
            </span>
          </li>
        ))}
      </ul>

      {invoices.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-white/60">Invoices</p>
          <ul className="flex flex-col gap-2">
            {invoices.map((inv) => (
              <li
                key={`${inv.number ?? inv.created}`}
                className="flex items-center justify-between gap-4 text-sm"
              >
                <span className="text-white/70">
                  {inv.number ? `#${inv.number}` : fmtDate(inv.created)} ·{" "}
                  {fmtAmount(inv.amount, inv.currency)}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {inv.hostedUrl ? (
                    <a
                      href={inv.hostedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-white/60 transition-colors hover:text-white"
                    >
                      View
                    </a>
                  ) : null}
                  {inv.pdfUrl ? (
                    <a
                      href={inv.pdfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-white/60 transition-colors hover:text-white"
                    >
                      PDF
                    </a>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
