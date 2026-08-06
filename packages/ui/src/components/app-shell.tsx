import { Menu } from "lucide-react";
import * as React from "react";

import { Button } from "./button";
import { Drawer } from "./drawer";

export function AppShell({
  brand = "AWSM",
  sidebar,
  children,
}: {
  readonly brand?: string;
  readonly sidebar: React.ReactNode;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  return (
    <div className="awsm-app-root flex min-h-screen">
      <aside className="hidden w-64 shrink-0 border-r-2 border-awsm-ink bg-awsm-cream p-4 lg:flex lg:flex-col">
        {sidebar}
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex min-h-16 items-center gap-4 border-b-2 border-awsm-ink bg-awsm-cream/95 px-4 backdrop-blur lg:hidden">
          <Button
            variant="quiet"
            size="icon"
            aria-label="Open navigation"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden="true" />
          </Button>
          <span className="font-display text-xl font-extrabold tracking-tight">{brand}</span>
        </header>
        <main className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
      <div className="lg:hidden">
        <Drawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          title={`${brand} navigation`}
          visuallyHiddenTitle
        >
          {sidebar}
        </Drawer>
      </div>
    </div>
  );
}
