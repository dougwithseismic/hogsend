import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm font-medium tracking-[-0.02em] transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-white text-[#0a0a0a] hover:bg-white/90",
        destructive: "bg-accent text-white hover:bg-accent-deep",
        outline:
          "border border-hairline-faint bg-transparent text-white/80 hover:border-white/15 hover:bg-white/5 hover:text-white",
        secondary:
          "bg-white/[0.06] text-white/80 hover:bg-white/10 hover:text-white",
        ghost: "text-white/70 hover:bg-white/5 hover:text-white",
        link: "text-white underline-offset-4 hover:text-white/80 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-[8px] px-3 text-xs",
        lg: "h-10 px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        type="button"
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
