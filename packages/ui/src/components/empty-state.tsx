import type * as React from "react";

import { cn } from "../lib/cn";

export function EmptyState({
  className,
  title,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { readonly title: string }): React.ReactElement {
  return (
    <section
      className={cn(
        "grid justify-items-start gap-4 rounded-expressive border-2 border-dashed border-awsm-ink bg-awsm-surface-subtle p-8 text-awsm-ink",
        className,
      )}
      {...props}
    >
      <h2 className="font-display text-2xl font-bold leading-tight">{title}</h2>
      <div className="max-w-[60ch] text-base leading-relaxed">{children}</div>
    </section>
  );
}
