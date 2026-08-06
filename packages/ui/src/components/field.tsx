import * as React from "react";

import { cn } from "../lib/cn";

export function Field({
  label,
  description,
  error,
  children,
  className,
}: {
  readonly label: string;
  readonly description?: string;
  readonly error?: string;
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.ReactElement {
  const descriptionId = React.useId();
  const errorId = React.useId();
  const inputId = React.useId();
  const describedBy =
    [
      description !== undefined ? descriptionId : undefined,
      error !== undefined ? errorId : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const inputProps: { "aria-describedby"?: string; "aria-invalid"?: boolean } = {};
  if (describedBy !== undefined) inputProps["aria-describedby"] = describedBy;
  if (error !== undefined) inputProps["aria-invalid"] = true;
  return (
    <div className={cn("grid gap-2", className)}>
      <label className="text-sm font-bold leading-tight text-awsm-ink" htmlFor={inputId}>
        {label}
      </label>
      {React.isValidElement(children)
        ? React.cloneElement(
            children as React.ReactElement<{
              id?: string;
              "aria-describedby"?: string;
              "aria-invalid"?: boolean;
            }>,
            { id: inputId, ...inputProps },
          )
        : children}
      {description !== undefined ? (
        <p id={descriptionId} className="max-w-[75ch] text-sm leading-relaxed text-awsm-text-muted">
          {description}
        </p>
      ) : null}
      {error !== undefined ? (
        <p
          id={errorId}
          className="max-w-[75ch] text-sm font-semibold leading-relaxed text-awsm-ink"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const FormField = Field;

export const inputClassName =
  "min-h-11 w-full rounded-compact border-2 border-awsm-ink bg-awsm-paper px-3 text-base text-awsm-ink outline-none placeholder:text-awsm-text-muted focus:awsm-focus-ring disabled:cursor-not-allowed disabled:bg-awsm-disabled";
