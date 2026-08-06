import type * as React from "react";

import { cn } from "../lib/cn";

export type NoticeTone = "info" | "success" | "warning" | "danger";

export function Notice({
  tone = "info",
  title,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  readonly tone?: NoticeTone;
  readonly title?: string;
}): React.ReactElement {
  const toneClass = {
    info: "bg-awsm-info-pale",
    success: "border-awsm-green bg-awsm-success-pale",
    warning: "bg-awsm-warning-pale",
    danger: "border-awsm-danger bg-awsm-danger-pale",
  }[tone];
  return (
    <div
      className={cn(
        "rounded-control border-2 border-awsm-ink p-4 text-awsm-ink",
        toneClass,
        className,
      )}
      role={tone === "danger" ? "alert" : "status"}
      {...props}
    >
      {title !== undefined ? <h2 className="font-bold">{title}</h2> : null}
      <div className="mt-1 max-w-[75ch] text-base leading-relaxed">{children}</div>
    </div>
  );
}
