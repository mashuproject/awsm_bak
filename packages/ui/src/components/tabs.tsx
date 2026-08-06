import * as TabsPrimitive from "@radix-ui/react-tabs";
import type * as React from "react";

import { cn } from "../lib/cn";

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>): React.ReactElement {
  return (
    <TabsPrimitive.List
      className={cn(
        "inline-flex min-h-11 flex-wrap gap-1 rounded-control border-2 border-awsm-ink bg-awsm-paper p-1",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>): React.ReactElement {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "min-h-9 rounded-compact px-3 text-sm font-bold text-awsm-ink hover:bg-awsm-selected focus-visible:awsm-focus-ring data-[state=active]:bg-awsm-selected",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>): React.ReactElement {
  return <TabsPrimitive.Content className={cn("mt-4 focus:outline-none", className)} {...props} />;
}
