import type * as React from "react";

import { cn } from "../lib/cn";

export function Badge({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex min-h-7 items-center rounded-full border-2 border-awsm-ink bg-awsm-yellow px-3 py-0.5 text-xs font-extrabold text-awsm-accent-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
