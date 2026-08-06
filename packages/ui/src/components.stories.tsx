import type { Meta, StoryObj } from "@storybook/react-vite";
import { Archive, BookOpen, Cable, Settings } from "lucide-react";
import * as React from "react";

import {
  AppearanceControl,
  AppShell,
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Field,
  inputClassName,
  KeeperMoment,
  Notice,
  PageHeader,
  Progress,
  SidebarNav,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./index";

const meta = {
  title: "AWSM/Primitives",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;

export const Buttons: StoryObj = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Button>Archive this page</Button>
      <Button variant="secondary">Open Library</Button>
      <Button variant="quiet">Settings</Button>
      <Button variant="danger">Close Vault</Button>
      <Button busy>Saving…</Button>
      <Badge>Local</Badge>
    </div>
  ),
};

export const ReadingSurfaces: StoryObj = {
  render: () => (
    <div className="grid max-w-3xl gap-4">
      <Card expressive>
        <CardHeader>
          <CardTitle>A calm place for useful pages</CardTitle>
          <CardDescription>
            Readable copy keeps the decision visible without turning every surface into a floating
            card.
          </CardDescription>
        </CardHeader>
      </Card>
      <Notice tone="success" title="Saved locally">
        This Capture is available in the selected Vault.
      </Notice>
      <Notice tone="warning" title="Connection unavailable">
        The local Vault remains usable. Synchronization can resume later.
      </Notice>
      <Notice tone="danger" title="This action changes history">
        Review the consequence before continuing.
      </Notice>
    </div>
  ),
};

export const FormAndAppearance: StoryObj = {
  render: () => (
    <div className="grid max-w-xl gap-6">
      <PageHeader
        eyebrow="Settings"
        title="Appearance"
        description="Choose how this client looks. The setting never enters Vault data."
      />
      <Field label="Vault name" description="Use a short name that helps you recognize this Vault.">
        <input className={inputClassName} defaultValue="Personal archive" />
      </Field>
      <AppearanceControl />
    </div>
  ),
};

export const Navigation: StoryObj = {
  render: () => (
    <div className="min-h-[32rem]">
      <AppShell
        sidebar={
          <>
            <div className="mb-8 grid gap-1">
              <span className="font-display text-2xl font-extrabold">AWSM</span>
              <span className="text-sm text-awsm-text-muted">Personal archive</span>
            </div>
            <SidebarNav
              items={[
                { id: "vaults", label: "Vaults", icon: <Archive />, active: true },
                { id: "library", label: "Library", icon: <BookOpen /> },
                { id: "connections", label: "Connections", icon: <Cable /> },
                { id: "settings", label: "Settings", icon: <Settings /> },
              ]}
            />
          </>
        }
      >
        <PageHeader
          title="Vaults"
          description="Choose the encrypted Vault managed by this client."
        />
        <EmptyState title="No captures yet">
          Capture a page from the browser extension to begin building this Vault.
        </EmptyState>
      </AppShell>
    </div>
  ),
};

export const MeaningfulMoment: StoryObj = {
  render: () => (
    <KeeperMoment title="Your archive is ready">
      The Recovery Phrase is the secure access to this Vault. Keep it somewhere safe.
    </KeeperMoment>
  ),
};

export const ProgressAndTabs: StoryObj = {
  render: () => (
    <div className="grid max-w-xl gap-8">
      <Progress label="Preparing a Capture" value={68} />
      <Tabs defaultValue="local">
        <TabsList aria-label="Storage view">
          <TabsTrigger value="local">Local</TabsTrigger>
          <TabsTrigger value="hosted">Hosted Replica</TabsTrigger>
        </TabsList>
        <TabsContent value="local">
          <p className="text-base leading-relaxed">This copy is available in the selected Vault.</p>
        </TabsContent>
        <TabsContent value="hosted">
          <p className="text-base leading-relaxed">
            The hosted copy contains opaque encrypted data.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  ),
};

export const DestructiveDialog: StoryObj = {
  render: function DialogStory() {
    const [open, setOpen] = React.useState(true);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open confirmation</Button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Close this Vault?"
          description="Closing stops new Events. Members can still fork a copy from a remaining Replica."
        >
          <p className="text-base leading-relaxed">
            This cannot be undone for this Vault. Review the other Replicas before continuing.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="danger" onClick={() => setOpen(false)}>
              Confirm closure
            </Button>
            <Button variant="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </Dialog>
      </>
    );
  },
};
