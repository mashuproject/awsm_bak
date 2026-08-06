import type * as React from "react";

export function KeeperMoment({
  src,
  alt = "",
  title,
  children,
}: {
  readonly src?: string;
  readonly alt?: string;
  readonly title: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="grid gap-4 rounded-expressive border-2 border-awsm-ink bg-awsm-sky-panel p-8 text-awsm-ink shadow-[4px_4px_0_var(--awsm-ink)]">
      {src !== undefined ? (
        <img
          src={src}
          alt={alt}
          aria-hidden={alt === "" || undefined}
          className="h-20 w-20 object-contain"
        />
      ) : null}
      <h2 className="font-display text-3xl font-bold leading-tight">{title}</h2>
      <div className="max-w-[60ch] text-base leading-relaxed">{children}</div>
    </section>
  );
}
