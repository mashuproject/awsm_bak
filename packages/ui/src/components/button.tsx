import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";

const buttonVariants = cva(
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-control border-2 border-awsm-ink px-4 py-2 text-center text-sm font-bold leading-tight text-awsm-accent-foreground shadow-[4px_4px_0_var(--awsm-ink)] transition-[translate,box-shadow,background-color] duration-[var(--awsm-duration-press)] focus-visible:awsm-focus-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-awsm-border-subtle disabled:bg-awsm-disabled disabled:text-awsm-text-muted disabled:shadow-none",
  {
    variants: {
      variant: {
        primary:
          "bg-awsm-coral hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-awsm-yellow hover:shadow-[6px_6px_0_var(--awsm-ink)] active:translate-x-0.5 active:translate-y-0.5 active:shadow-[1px_1px_0_var(--awsm-ink)]",
        secondary: "bg-awsm-paper text-awsm-ink hover:bg-awsm-surface-subtle",
        quiet:
          "border-transparent bg-transparent text-awsm-link shadow-none hover:underline hover:decoration-2 hover:underline-offset-4",
        danger: "bg-awsm-danger text-awsm-paper hover:bg-awsm-danger",
      },
      size: {
        default: "",
        icon: "px-2",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  readonly asChild?: boolean;
  readonly busy?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, busy = false, children, disabled, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        {...props}
      >
        {children}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
