import { cn } from "@/lib/cn";

/**
 * Monochrome Hogsend lockup — the boar mark is painted via CSS mask so it
 * inherits `currentColor` and takes the same treatment as the type beside it.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-2 text-white", className)}
    >
      <span
        aria-hidden="true"
        className="block h-[15px] w-[27px] bg-current"
        style={{
          WebkitMaskImage: "url(/images/logos/hogsend-boar.svg)",
          maskImage: "url(/images/logos/hogsend-boar.svg)",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
          WebkitMaskSize: "contain",
          maskSize: "contain",
        }}
      />
      <span className="font-display font-medium text-[17px] leading-none tracking-[-0.02em]">
        Hogsend
      </span>
      <span className="eyebrow text-white/40">Cloud</span>
    </span>
  );
}
