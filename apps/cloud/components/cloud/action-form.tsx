"use client";

import type { JSX, ReactNode } from "react";
import { useActionState } from "react";
import { Button } from "@/components/ds/button";
import { FormError } from "@/components/ds/field";
import { cn } from "@/lib/cn";
import { EMPTY_ACTION_STATE, type FormAction } from "@/src/lib/action-state";

type ActionFormProps = {
  action: FormAction;
  /** Row identity (member id, invitation id) posted with the form. */
  hidden?: Record<string, string>;
  submitLabel: string;
  /** Label while the action is in flight — the button never goes silent. */
  pendingLabel: string;
  variant?: "solid" | "outline" | "ghost";
  /** Controls rendered above the button (a role select, a text input). */
  children?: ReactNode;
  className?: string;
};

/**
 * One server action, one form, its own pending + error state.
 *
 * Every mutating control on the settings page is one of these, so a refusal
 * (Better Auth's or the action's own role gate) is printed next to the control
 * that caused it instead of somewhere page-level.
 */
export function ActionForm({
  action,
  hidden,
  submitLabel,
  pendingLabel,
  variant = "outline",
  children,
  className,
}: ActionFormProps): JSX.Element {
  const [state, formAction, pending] = useActionState(
    action,
    EMPTY_ACTION_STATE,
  );

  return (
    <form action={formAction} className={cn("flex flex-col gap-3", className)}>
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant={variant} disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
        {state.notice ? (
          <span className="text-sm text-white/60">{state.notice}</span>
        ) : null}
      </div>
      <FormError>{state.error}</FormError>
    </form>
  );
}

/** Hairline select matching the ds Input's height, radius and border. */
export function Select({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return (
    <select
      className={cn(
        "h-10 rounded-[10px] border border-white/15 bg-white/[0.03] px-3",
        "text-sm text-white tracking-[-0.02em]",
        "transition-colors duration-200 outline-none focus:border-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
