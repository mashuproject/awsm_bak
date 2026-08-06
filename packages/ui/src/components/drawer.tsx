import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";

import { cn } from "../lib/cn";
import { Button } from "./button";

export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  visuallyHiddenTitle = false,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly visuallyHiddenTitle?: boolean;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-awsm-ink/70" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-6 overflow-y-auto border-r-2 border-awsm-ink bg-awsm-cream p-6 text-awsm-ink shadow-[4px_0_0_var(--awsm-ink)] focus:outline-none">
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <Dialog.Title
                className={cn(
                  "font-display text-2xl font-bold leading-tight",
                  visuallyHiddenTitle && "awsm-sr-only",
                )}
              >
                {title}
              </Dialog.Title>
              {description !== undefined ? (
                <Dialog.Description className="max-w-[35ch] text-sm leading-relaxed text-awsm-text-muted">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <Button variant="quiet" size="icon" aria-label="Close navigation">
                <X aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SidebarNav({
  items,
  onNavigate,
  className,
}: {
  readonly items: readonly {
    readonly id: string;
    readonly label: string;
    readonly icon?: React.ReactNode;
    readonly active?: boolean;
  }[];
  readonly onNavigate?: (id: string) => void;
  readonly className?: string;
}): React.ReactElement {
  return (
    <nav aria-label="Primary" className={cn("grid gap-2", className)}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "flex min-h-11 items-center gap-3 rounded-compact px-3 text-left text-sm font-bold text-awsm-ink hover:bg-awsm-selected focus-visible:awsm-focus-ring",
            item.active && "border-2 border-awsm-ink bg-awsm-selected",
          )}
          onClick={() => onNavigate?.(item.id)}
        >
          {item.icon !== undefined ? <span aria-hidden="true">{item.icon}</span> : null}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
