import { Check } from "lucide-react";
import { CopyButton } from "@/components/ds/copy-button";
import { skuTitle } from "@/lib/courses";
import { listLicensePacks } from "@/lib/licenses";

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Server component: the user's team-licence packs with per-code redemption
 * state — the durable home of the codes (the purchase email is the other
 * copy). Renders nothing when the user has never bought a pack, so the
 * account page carries no empty section for the common case.
 */
export async function LicenseSection({ userId }: { userId: string }) {
  const packs = await listLicensePacks(userId);
  if (packs.length === 0) return null;

  return (
    <section className="border-white/[0.08] border-t pt-8">
      <h2 className="font-display text-xl tracking-[-0.02em]">Team licences</h2>
      <p className="mt-1 text-sm text-white/50 leading-6">
        Each code unlocks one copy — send one to each person on your team. They
        redeem it in the promo-code field at checkout.
      </p>
      <div className="mt-5 flex flex-col gap-4">
        {packs.map((pack) => {
          const redeemed = pack.codes.filter((c) => c.redeemedAt).length;
          return (
            <div
              key={pack.id}
              className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5"
            >
              <div className="flex items-center justify-between gap-4">
                <p className="font-display text-sm tracking-[-0.02em]">
                  {skuTitle(pack.courseSlug)}
                </p>
                <span className="shrink-0 text-sm text-white/50">
                  {redeemed}/{pack.seats} redeemed · {fmtDate(pack.createdAt)}
                </span>
              </div>
              <ul className="mt-4 flex flex-col gap-2">
                {pack.codes.map((c) => (
                  <li
                    key={c.code}
                    className="flex items-center justify-between gap-3 rounded-[10px] border border-white/[0.08] bg-white/[0.02] px-3 py-2"
                  >
                    <span
                      className={`font-mono text-[13px] tracking-wide ${
                        c.redeemedAt ? "text-white/35 line-through" : ""
                      }`}
                    >
                      {c.code}
                    </span>
                    {c.redeemedAt ? (
                      <span className="inline-flex items-center gap-1.5 text-white/40 text-xs">
                        <Check
                          className="size-3.5 text-accent"
                          strokeWidth={2.5}
                          aria-hidden
                        />
                        Redeemed {fmtDate(c.redeemedAt)}
                      </span>
                    ) : (
                      <CopyButton value={c.code} />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
