import type { ReactNode } from "react";

type PageHeaderProps = {
  title: string;
  /** One factual line under the title. */
  description?: string;
  /** Right-aligned actions (buttons, links). */
  actions?: ReactNode;
};

/**
 * Top-of-page frame: title + one-line description on the left, actions on the
 * right, closed by a full-bleed hairline that the first Section sits under.
 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="border-white/[0.08] border-b">
      <div className="container-page flex flex-col gap-4 py-7 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="font-display font-medium text-[26px] text-white leading-[1.15] tracking-[-0.03em] md:text-[30px]">
            {title}
          </h1>
          {description ? (
            <p className="max-w-2xl text-sm text-white/60 leading-6">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-3">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
