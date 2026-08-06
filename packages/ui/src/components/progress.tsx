import type * as React from "react";

import { cn } from "../lib/cn";

export function Progress({
  value,
  max = 100,
  label,
  className,
}: {
  readonly value: number;
  readonly max?: number;
  readonly label: string;
  readonly className?: string;
}): React.ReactElement {
  const boundedMax = max > 0 ? max : 100;
  const boundedValue = Math.min(Math.max(value, 0), boundedMax);
  const percentage = (boundedValue / boundedMax) * 100;

  return (
    <div className={cn("grid gap-2", className)}>
      <div className="flex items-center justify-between gap-3 text-sm font-bold text-awsm-ink">
        <span>{label}</span>
        <span aria-hidden="true">{Math.round(percentage)}%</span>
      </div>
      <div
        aria-label={label}
        aria-valuemax={boundedMax}
        aria-valuemin={0}
        aria-valuenow={boundedValue}
        className="h-3 overflow-hidden rounded-full border-2 border-awsm-ink bg-awsm-paper"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-awsm-yellow transition-[width] duration-200 ease-out motion-reduce:transition-none"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
