import type { InputHTMLAttributes, JSX, ReactNode } from "react";
import { cn } from "@/lib/cn";

type FieldProps = {
  /** Wired to the input via htmlFor/id — the label is always real, never a placeholder. */
  htmlFor: string;
  label: string;
  /** One factual line under the control (format, constraint). */
  hint?: string;
  children: ReactNode;
  className?: string;
};

/** Label + control + optional hint, in the 8px vertical rhythm. */
export function Field({
  htmlFor,
  label,
  hint,
  children,
  className,
}: FieldProps): JSX.Element {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <label
        htmlFor={htmlFor}
        className="font-medium text-sm text-white/80 tracking-[-0.02em]"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="text-white/40 text-xs leading-5">{hint}</p> : null}
    </div>
  );
}

/**
 * Hairline text input on the ink page — same 10px radius and 40px height as
 * the Button, so a field and a button line up in a form.
 */
export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-[10px] border border-white/15 bg-white/[0.03] px-3",
        "text-sm text-white tracking-[-0.02em] placeholder:text-white/30",
        "transition-colors duration-200 outline-none",
        "focus:border-accent focus:bg-white/[0.05]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Form-level error line. `role="alert"` so a failed sign-in is announced, not
 * just coloured.
 */
export function FormError({
  children,
}: {
  children: ReactNode;
}): JSX.Element | null {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-accent/40 bg-accent-tint px-3 py-2 text-sm text-white"
    >
      {children}
    </p>
  );
}
