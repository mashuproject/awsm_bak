import type * as React from "react";

import { cn } from "../lib/cn";

export function Card({
  className,
  expressive = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { readonly expressive?: boolean }): React.ReactElement {
  return (
    <section
      className={cn(
        "rounded-control border-2 border-awsm-ink bg-awsm-paper p-6 text-awsm-ink",
        expressive && "rounded-expressive shadow-[4px_4px_0_var(--awsm-ink)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <header className={cn("grid gap-2", className)} {...props} />;
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement {
  return (
    <h2
      className={cn(
        "font-display text-2xl font-bold leading-tight tracking-[-0.015em] text-awsm-ink",
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.ReactElement {
  return (
    <p
      className={cn("max-w-[75ch] text-base leading-relaxed text-awsm-text-muted", className)}
      {...props}
    />
  );
}
