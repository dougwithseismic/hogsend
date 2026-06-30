import type { JSX } from "react";
import { cn } from "@/lib/cn";

/**
 * A no-JS Stripe checkout submit: posts the SKU (a course slug or "all-access")
 * plus an optional return path to /api/checkout, styled as the DS primary
 * button. The single place a checkout form is rendered, so the buy CTA looks
 * identical on the catalog, the overview, and the pricing page.
 */
export function CheckoutButton({
  sku,
  label,
  next,
  fullWidth = false,
}: {
  sku: string;
  label: string;
  next?: string;
  fullWidth?: boolean;
}): JSX.Element {
  return (
    <form
      method="post"
      action="/api/checkout"
      className={cn(fullWidth && "w-full")}
    >
      <input type="hidden" name="course" value={sku} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <button
        type="submit"
        className={cn(
          "group inline-flex h-12 select-none items-center justify-center gap-2 rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] text-base tracking-[-0.02em] transition-colors duration-200 hover:bg-white/90",
          fullWidth && "w-full",
        )}
      >
        {label}
      </button>
    </form>
  );
}
