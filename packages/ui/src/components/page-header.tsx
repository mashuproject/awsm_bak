import type * as React from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description?: string;
  readonly actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <header className="grid gap-3 border-b-2 border-awsm-border-subtle pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-2">
          {eyebrow !== undefined ? (
            <p className="text-xs font-extrabold uppercase tracking-[0.08em] text-awsm-text-muted">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="font-display text-4xl font-bold leading-tight tracking-[-0.025em] text-awsm-ink">
            {title}
          </h1>
          {description !== undefined ? (
            <p className="max-w-[65ch] text-base leading-relaxed text-awsm-text-muted">
              {description}
            </p>
          ) : null}
        </div>
        {actions !== undefined ? (
          <div className="flex flex-wrap items-center gap-3">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
