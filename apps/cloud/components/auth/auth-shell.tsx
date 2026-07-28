import type { ReactNode } from "react";
import { Card } from "@/components/ds/card";
import { Wordmark } from "@/components/ds/wordmark";

type AuthShellProps = {
  title: string;
  /** One factual line — what this screen does, not why it is exciting. */
  description: string;
  children: ReactNode;
  /** Cross-link to the other auth screen. */
  footer?: ReactNode;
};

/** Centred single-card frame shared by /login and /signup. */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: AuthShellProps) {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-[26rem] flex-col gap-8">
        <Wordmark />
        <Card className="flex flex-col gap-6 hover:border-white/[0.08]">
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-[24px] text-white leading-[1.2] tracking-[-0.02em]">
              {title}
            </h1>
            <p className="text-sm text-white/60 leading-6">{description}</p>
          </div>
          {children}
        </Card>
        {footer ? (
          <p className="text-center text-sm text-white/50">{footer}</p>
        ) : null}
      </div>
    </main>
  );
}
