import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";

import { cn } from "../lib/cn";
import { Button } from "./button";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-awsm-ink/70" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 grid w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-6 rounded-expressive border-2 border-awsm-ink bg-awsm-paper p-6 text-awsm-ink shadow-[4px_4px_0_var(--awsm-ink)] focus:outline-none sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-2">
              <DialogPrimitive.Title className="font-display text-2xl font-bold leading-tight">
                {title}
              </DialogPrimitive.Title>
              {description !== undefined ? (
                <DialogPrimitive.Description className="max-w-[65ch] text-base leading-relaxed text-awsm-text-muted">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="quiet" size="icon" aria-label="Close dialog">
                <X aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className={cn("grid gap-4")}>{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
