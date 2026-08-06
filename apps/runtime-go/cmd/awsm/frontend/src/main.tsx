import {
  AppearanceControl,
  AppearanceProvider,
  AppShell,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  inputClassName,
  Notice,
  PageHeader,
  SidebarNav,
} from "@awsm/ui";
import {
  BookOpen,
  ChevronDown,
  Link2,
  RefreshCw,
  Settings,
  ShieldCheck,
  Vault,
} from "lucide-react";
import * as React from "react";
import { createRoot } from "react-dom/client";

import "@awsm/ui/styles.css";

type MaybePromise<T> = T | Promise<T>;

type VaultSummary = {
  readonly vaultId: string;
  readonly label: string | null;
  readonly lifecycle: string;
  readonly access: string;
  readonly selected: boolean;
};

type PendingCreation = {
  readonly setupId: string;
  readonly expectedVaultId: string | null;
};

type RuntimeState = {
  readonly selectedVaultId?: string;
  readonly vaults: readonly VaultSummary[];
  readonly pendingVaultCreation?: PendingCreation;
};

type LibraryItem = {
  readonly bundleId: string;
  readonly collectionId: string;
  readonly artifactId: string;
  readonly capturedAt: number | bigint;
  readonly originalUrl: string;
  readonly title: string | null;
  readonly finalUrl: string;
  readonly availableLocally: boolean;
  readonly lifecycle: string;
};

type LibraryCollection = {
  readonly collectionId: string;
  readonly explicitTitle: string | null;
  readonly title: string;
  readonly tailBundleId: string | null;
  readonly activeCaptureCount: number;
  readonly redirectedTo: string | null;
  readonly folderId: string | null;
};

type LibraryFolder = {
  readonly folderId: string;
  readonly name: string;
  readonly parentFolderId: string | null;
  readonly effectiveParentFolderId: string | null;
  readonly lifecycle: string;
};

type LibraryTag = {
  readonly tagId: string;
  readonly name: string;
  readonly lifecycle: string;
  readonly redirectedTo: string | null;
};

type LibraryTagAssignment = {
  readonly assignmentId: string;
  readonly tagId: string;
  readonly targetKind: number;
  readonly targetId: string;
  readonly active: boolean;
};

type LibraryNoteVersion = {
  readonly headCauseId: string;
  readonly contentObjectId: string | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly bodyDialect: string | null;
  readonly assertedAt: number | bigint;
};

type LibraryNote = {
  readonly noteId: string;
  readonly targetKind: number;
  readonly targetId: string;
  readonly state: string;
  readonly versions: readonly LibraryNoteVersion[];
};

type LibraryConflict = {
  readonly kind: string;
  readonly reason: string;
  readonly subjectIds: readonly string[];
  readonly candidateRecordIds: readonly string[];
};

type LibraryProjection = {
  readonly captures: readonly LibraryItem[];
  readonly collections: readonly LibraryCollection[];
  readonly folders: readonly LibraryFolder[];
  readonly tags: readonly LibraryTag[];
  readonly tagAssignments: readonly LibraryTagAssignment[];
  readonly notes: readonly LibraryNote[];
  readonly conflicts: readonly LibraryConflict[];
};

type AuthorityState = {
  readonly vaultId: string;
  readonly activeMemberIds: readonly string[];
  readonly administratorIds: readonly string[];
  readonly administratorConflicts: readonly unknown[];
  readonly activeInvitationIds: readonly string[];
  readonly invitationConflictIds: readonly string[];
  readonly activeClientCredentialIds: readonly string[];
  readonly effectiveRecoveryCredentialIds: readonly string[];
  readonly recoveryConflicts: readonly unknown[];
  readonly keyEpochConflicts: readonly unknown[];
  readonly featureSetConflict?: unknown;
  readonly currentKeyEpochIds: readonly string[];
  readonly lifecycle: string;
};

type Remote = {
  readonly remoteId: string;
  readonly name: string;
  readonly endpoint: string;
  readonly enabled: boolean;
  readonly replicaHandle: string;
};

type Pairing = {
  readonly pairingId: string;
  readonly clientName: string;
  readonly scopes: readonly string[];
};

type Grant = {
  readonly grantId: string;
  readonly clientName: string;
  readonly scopes: readonly string[];
  readonly revoked: boolean;
};

type Transfer = {
  readonly transferId: string;
  readonly vaultId: string;
  readonly byteLength: number;
  readonly digest: string;
};

type DesktopBinding = {
  PendingPairings: () => MaybePromise<readonly Pairing[]>;
  ApprovePairing: (pairingId: string) => MaybePromise<void>;
  RevokeGrant: (grantId: string) => MaybePromise<void>;
  ListGrants: () => MaybePromise<readonly Grant[]>;
  RuntimeAddress: () => MaybePromise<string>;
  RuntimeVersion?: () => MaybePromise<string>;
  VaultCommand?: (request: Record<string, unknown>) => MaybePromise<unknown>;
  PendingTransfers?: () => MaybePromise<readonly Transfer[]>;
  AcceptTransfer?: (transferId: string) => MaybePromise<void>;
  RejectTransfer?: (transferId: string) => MaybePromise<void>;
};

declare global {
  var go:
    | {
        readonly main?: { readonly desktopBinding?: DesktopBinding };
      }
    | undefined;
}

type Section = "vaults" | "library" | "connections" | "settings";
type PhraseAction = "fork" | "replace";

type PhraseSetup = {
  readonly setupId: string;
  readonly recoveryPhrase: string;
  readonly action: PhraseAction;
};

function getBinding(): DesktopBinding | undefined {
  return globalThis.go?.main?.desktopBinding;
}

function displayVaultLabel(label: string | null | undefined): string {
  return label === null || label === undefined || label.length === 0 ? "Untitled Vault" : label;
}

function displayCaptureTitle(title: string | null, finalUrl: string): string {
  if (title !== null && title.length > 0) return title;
  try {
    return new URL(finalUrl).hostname;
  } catch {
    return finalUrl;
  }
}

function displayIdentifier(identifier: string): string {
  return identifier.length <= 16 ? identifier : `${identifier.slice(0, 12)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The requested Runtime action failed.";
}

function vaultContext(state: RuntimeState | undefined): VaultSummary | undefined {
  if (state?.selectedVaultId === undefined) return undefined;
  return state.vaults.find(({ vaultId }) => vaultId === state.selectedVaultId);
}

function SectionIcon({ section }: { readonly section: Section }): React.ReactElement {
  const Icon =
    section === "vaults"
      ? Vault
      : section === "library"
        ? BookOpen
        : section === "connections"
          ? Link2
          : Settings;
  return <Icon aria-hidden="true" className="size-4" />;
}

function DesktopSidebar({
  activeSection,
  onNavigate,
  state,
  onSelectVault,
}: {
  readonly activeSection: Section;
  readonly onNavigate: (section: Section) => void;
  readonly state: RuntimeState | undefined;
  readonly onSelectVault: (vaultId: string) => void;
}): React.ReactElement {
  const vault = vaultContext(state);
  const sections: readonly { id: Section; label: string }[] = [
    { id: "vaults", label: "Vaults" },
    { id: "library", label: "Library" },
    { id: "connections", label: "Connections" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <div className="grid gap-8">
      <div className="grid gap-1">
        <span className="font-display text-3xl font-extrabold tracking-tight text-awsm-ink">
          AWSM
        </span>
        <span className="text-sm text-awsm-text-muted">Desktop Client</span>
      </div>
      <div className="grid gap-2">
        <label
          className="grid gap-2 text-xs font-extrabold uppercase tracking-[0.08em] text-awsm-text-muted"
          htmlFor="sidebar-vault"
        >
          Selected Vault
          <span className="relative">
            <select
              id="sidebar-vault"
              className={`${inputClassName} appearance-none pr-10 text-sm font-semibold`}
              value={state?.selectedVaultId ?? ""}
              onChange={(event) => onSelectVault(event.target.value)}
              disabled={state === undefined || state.vaults.length === 0}
            >
              {state?.vaults.length === 0 ? <option value="">No Vaults yet</option> : null}
              {state?.vaults.map((candidate) => (
                <option key={candidate.vaultId} value={candidate.vaultId}>
                  {displayVaultLabel(candidate.label)}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-awsm-ink"
            />
          </span>
        </label>
        {vault !== undefined ? (
          <span className="text-sm text-awsm-text-muted">
            {vault.lifecycle} · {vault.access}
          </span>
        ) : null}
      </div>
      <SidebarNav
        items={sections.map((section) => ({
          ...section,
          icon: <SectionIcon section={section.id} />,
          active: activeSection === section.id,
        }))}
        onNavigate={(id) => onNavigate(id as Section)}
      />
      <AppearanceControl />
    </div>
  );
}

function LoadingNotice(): React.ReactElement {
  return <Notice title="Loading">Checking the local Runtime and Vault state…</Notice>;
}

function ActionRow({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

function VaultCreationPanel({
  binding,
  expectedVaultId,
  onComplete,
  onError,
}: {
  readonly binding: DesktopBinding;
  readonly expectedVaultId: string | null;
  readonly onComplete: () => void;
  readonly onError: (error: unknown) => void;
}): React.ReactElement {
  const [label, setLabel] = React.useState("");
  const [setup, setSetup] = React.useState<{ setupId: string; recoveryPhrase?: string }>();
  const [phrase, setPhrase] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const begin = async () => {
    setBusy(true);
    try {
      const created = await binding.VaultCommand?.({
        type: "BeginVaultCreation",
        expectedVaultId,
        label: label.trim() === "" ? null : label.trim(),
      });
      const next = created as { setupId: string; recoveryPhrase?: string };
      setSetup(next);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (setup === undefined) return onComplete();
    setBusy(true);
    try {
      await binding.VaultCommand?.({ type: "CancelVaultCreation", setupId: setup.setupId });
      setSetup(undefined);
      setPhrase("");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (setup === undefined) return;
    setBusy(true);
    try {
      await binding.VaultCommand?.({
        type: "ConfirmVaultCreation",
        setupId: setup.setupId,
        recoveryPhrase: phrase,
      });
      onComplete();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  if (setup === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Create a Vault on this desktop Client.</CardTitle>
          <CardDescription>
            The Recovery Phrase is the secure access to the Vault. It is never stored by this
            Client.
          </CardDescription>
        </CardHeader>
        <form
          className="mt-6 grid max-w-xl gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void begin();
          }}
        >
          <Field
            label="Vault name"
            description="Use a name that helps you recognize this Vault on this Client."
          >
            <input
              className={inputClassName}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Personal archive"
              required
            />
          </Field>
          <Button type="submit" busy={busy}>
            Create Vault
          </Button>
        </form>
      </Card>
    );
  }
  return (
    <Card expressive>
      <CardHeader>
        <CardTitle>Confirm your Recovery Phrase</CardTitle>
        <CardDescription>
          Write this phrase down somewhere safe. Anyone who has it can access the Vault.
        </CardDescription>
      </CardHeader>
      {setup.recoveryPhrase !== undefined ? (
        <textarea
          className={`${inputClassName} mt-6 min-h-24 resize-y font-mono`}
          value={setup.recoveryPhrase}
          readOnly
          aria-label="Recovery Phrase"
        />
      ) : (
        <Notice tone="warning" className="mt-6">
          A Vault creation is already in progress. The Recovery Phrase is not stored by this Client;
          enter the phrase you recorded.
        </Notice>
      )}
      <form className="mt-6 grid max-w-xl gap-5" onSubmit={(event) => void confirm(event)}>
        <Field label="Type the Recovery Phrase to continue">
          <input
            className={inputClassName}
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            autoComplete="off"
            required
          />
        </Field>
        <ActionRow>
          <Button type="submit" busy={busy}>
            Confirm Recovery Phrase
          </Button>
          <Button type="button" variant="quiet" onClick={() => void cancel()} disabled={busy}>
            Cancel
          </Button>
        </ActionRow>
      </form>
    </Card>
  );
}

function PendingCreationPanel({
  binding,
  setupId,
  onComplete,
  onError,
}: {
  readonly binding: DesktopBinding;
  readonly setupId: string;
  readonly onComplete: () => void;
  readonly onError: (error: unknown) => void;
}): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const cancel = async () => {
    setBusy(true);
    try {
      await binding.VaultCommand?.({ type: "CancelVaultCreation", setupId });
      onComplete();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card expressive>
      <CardHeader>
        <CardTitle>Create a Vault</CardTitle>
        <CardDescription>
          A Vault creation is already in progress. The Recovery Phrase is not stored by this Client;
          enter the phrase you recorded or cancel this setup.
        </CardDescription>
      </CardHeader>
      <ActionRow>
        <Button variant="quiet" busy={busy} onClick={() => void cancel()}>
          Cancel
        </Button>
      </ActionRow>
    </Card>
  );
}

function PhrasePanel({
  binding,
  vaultId,
  setup,
  onDone,
  onError,
}: {
  readonly binding: DesktopBinding;
  readonly vaultId: string;
  readonly setup: PhraseSetup;
  readonly onDone: () => void;
  readonly onError: (error: unknown) => void;
}): React.ReactElement {
  const [phrase, setPhrase] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const confirmType =
    setup.action === "fork" ? "ConfirmVaultFork" : "ConfirmRecoveryPhraseReplacement";
  const cancelType =
    setup.action === "fork" ? "CancelVaultFork" : "CancelRecoveryPhraseReplacement";
  const confirm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      await binding.VaultCommand?.({
        type: confirmType,
        setupId: setup.setupId,
        recoveryPhrase: phrase,
      });
      onDone();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await binding.VaultCommand?.({
        type: cancelType,
        setupId: setup.setupId,
        expectedVaultId: vaultId,
      });
      onDone();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card expressive>
      <CardHeader>
        <CardTitle>
          {setup.action === "fork" ? "Fork this Vault" : "Change Recovery Phrase"}
        </CardTitle>
        <CardDescription>
          Record this new Recovery Phrase before continuing. It is not stored by this Client.
        </CardDescription>
      </CardHeader>
      <textarea
        className={`${inputClassName} mt-6 min-h-24 resize-y font-mono`}
        value={setup.recoveryPhrase}
        readOnly
        aria-label="Recovery Phrase"
      />
      <form className="mt-6 grid max-w-xl gap-5" onSubmit={(event) => void confirm(event)}>
        <Field label="Type the Recovery Phrase to continue">
          <input
            className={inputClassName}
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            autoComplete="off"
            required
          />
        </Field>
        <ActionRow>
          <Button type="submit" busy={busy}>
            {setup.action === "fork" ? "Confirm Fork" : "Confirm Recovery Phrase"}
          </Button>
          <Button type="button" variant="quiet" onClick={() => void cancel()} disabled={busy}>
            Cancel
          </Button>
        </ActionRow>
      </form>
    </Card>
  );
}

function LibraryList({
  items,
  binding,
  vaultId,
  onRefresh,
  onError,
  onStatus,
}: {
  readonly items: readonly LibraryItem[];
  readonly binding: DesktopBinding;
  readonly vaultId: string;
  readonly onRefresh: () => void;
  readonly onError: (error: unknown) => void;
  readonly onStatus: (message: string) => void;
}): React.ReactElement {
  const [hydrating, setHydrating] = React.useState<string>();
  const [relieving, setRelieving] = React.useState<string>();
  const activeItems = items.filter(({ lifecycle }) => lifecycle === "Active");
  if (activeItems.length === 0)
    return (
      <EmptyState title="No captures yet">
        <p>No captures are stored in this Vault yet.</p>
        <p className="mt-2">
          Capture is available from the browser extension. The desktop Client manages the Vault but
          does not acquire pages.
        </p>
      </EmptyState>
    );
  return (
    <ul className="grid gap-3">
      {activeItems.map((item) => (
        <li key={item.bundleId} className="grid gap-2 border-t-2 border-awsm-border-subtle py-4">
          <strong className="break-words text-base text-awsm-ink">
            {displayCaptureTitle(item.title, item.finalUrl)}
          </strong>
          <span className="break-all text-sm text-awsm-text-muted">{item.finalUrl}</span>
          <span className="text-sm font-semibold text-awsm-ink">
            {item.availableLocally ? "Available locally" : "Needs hydration"}
          </span>
          <ActionRow>
            {item.availableLocally ? (
              <Button
                variant="secondary"
                busy={relieving === item.artifactId}
                disabled={relieving !== undefined || hydrating !== undefined}
                onClick={() => {
                  if (
                    !window.confirm(
                      "Release this Artifact's local bytes? Without another retained Replica or export, the data may be unrecoverable.",
                    )
                  )
                    return;
                  setRelieving(item.artifactId);
                  void Promise.resolve(
                    binding.VaultCommand?.({
                      type: "StorageRelief",
                      expectedVaultId: vaultId,
                      objectIds: [item.artifactId],
                    }),
                  )
                    .then((result) => {
                      const summary = result as
                        | { releasedObjectIds?: readonly string[]; warning?: string }
                        | undefined;
                      const count = summary?.releasedObjectIds?.length ?? 0;
                      onRefresh();
                      onStatus(
                        `Storage Relief completed. ${count} local Object${count === 1 ? "" : "s"} released.${summary?.warning === undefined ? "" : ` ${summary.warning}`}`,
                      );
                    })
                    .catch(onError)
                    .finally(() => setRelieving(undefined));
                }}
              >
                Release local bytes
              </Button>
            ) : null}
            {!item.availableLocally ? (
              <Button
                variant="secondary"
                busy={hydrating === item.artifactId}
                disabled={relieving !== undefined || hydrating !== undefined}
                onClick={() => {
                  setHydrating(item.artifactId);
                  void Promise.resolve(
                    binding.VaultCommand?.({
                      type: "HydrateArtifact",
                      expectedVaultId: vaultId,
                      artifactId: item.artifactId,
                    }),
                  )
                    .then(() => {
                      onRefresh();
                      onStatus("Artifact hydrated.");
                    })
                    .catch(onError)
                    .finally(() => setHydrating(undefined));
                }}
              >
                Hydrate Artifact
              </Button>
            ) : null}
          </ActionRow>
        </li>
      ))}
    </ul>
  );
}

function LibrarySemanticSummary({
  projection,
}: {
  readonly projection: LibraryProjection;
}): React.ReactElement {
  return (
    <section className="grid gap-4" aria-label="Vault organization">
      {projection.conflicts.length > 0 ? (
        <Notice tone="warning" title="Library conflicts need attention">
          {projection.conflicts.length} organization conflict
          {projection.conflicts.length === 1 ? "" : "s"} remain visible in this Vault.
        </Notice>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Collections</CardTitle>
            <CardDescription>Stable groups and their current organization.</CardDescription>
          </CardHeader>
          {projection.collections.length === 0 ? (
            <p className="text-sm text-awsm-text-muted">No Collections yet.</p>
          ) : (
            <ul className="grid gap-2 text-sm">
              {projection.collections.map((collection) => (
                <li
                  key={collection.collectionId}
                  className="grid gap-1 border-t border-awsm-border-subtle pt-2"
                >
                  <strong className="text-awsm-ink">{collection.title}</strong>
                  <span className="text-awsm-text-muted">
                    {collection.activeCaptureCount} active capture
                    {collection.activeCaptureCount === 1 ? "" : "s"}
                    {collection.redirectedTo === null ? "" : " · merged view"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Organization</CardTitle>
            <CardDescription>Folders, Tags, and Notes derived from Vault Events.</CardDescription>
          </CardHeader>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-semibold text-awsm-ink">Folders</dt>
              <dd className="text-awsm-text-muted">{projection.folders.length}</dd>
            </div>
            <div>
              <dt className="font-semibold text-awsm-ink">Tags</dt>
              <dd className="text-awsm-text-muted">{projection.tags.length}</dd>
            </div>
            <div>
              <dt className="font-semibold text-awsm-ink">Assignments</dt>
              <dd className="text-awsm-text-muted">{projection.tagAssignments.length}</dd>
            </div>
            <div>
              <dt className="font-semibold text-awsm-ink">Notes</dt>
              <dd className="text-awsm-text-muted">{projection.notes.length}</dd>
            </div>
          </dl>
        </Card>
      </div>
    </section>
  );
}

function AuthoritySummary({
  authority,
}: {
  readonly authority: AuthorityState;
}): React.ReactElement {
  const conflictCount =
    authority.administratorConflicts.length +
    authority.invitationConflictIds.length +
    authority.recoveryConflicts.length +
    authority.keyEpochConflicts.length +
    (authority.featureSetConflict === undefined ? 0 : 1);
  return (
    <section className="grid gap-4" aria-labelledby="authority-heading">
      <div className="grid gap-2">
        <h3
          id="authority-heading"
          className="font-display text-2xl font-bold leading-tight text-awsm-ink"
        >
          Vault authority
        </h3>
        <p className="max-w-[65ch] text-base leading-relaxed text-awsm-text-muted">
          Membership, credentials, Administrators, and Key Epochs are derived from authenticated
          Vault Events. This view is read-only.
        </p>
      </div>
      {conflictCount > 0 ? (
        <Notice tone="warning" title="Authority conflicts need attention">
          {conflictCount} authority conflict{conflictCount === 1 ? "" : "s"} remain visible in this
          Vault.
        </Notice>
      ) : null}
      <Card>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="font-semibold text-awsm-ink">Lifecycle</dt>
            <dd className="text-awsm-text-muted">{authority.lifecycle}</dd>
          </div>
          <div>
            <dt className="font-semibold text-awsm-ink">Active members</dt>
            <dd className="text-awsm-text-muted">{authority.activeMemberIds.length}</dd>
          </div>
          <div>
            <dt className="font-semibold text-awsm-ink">Administrators</dt>
            <dd className="text-awsm-text-muted">{authority.administratorIds.length}</dd>
          </div>
          <div>
            <dt className="font-semibold text-awsm-ink">Active invitations</dt>
            <dd className="text-awsm-text-muted">{authority.activeInvitationIds.length}</dd>
          </div>
          <div>
            <dt className="font-semibold text-awsm-ink">Client credentials</dt>
            <dd className="text-awsm-text-muted">{authority.activeClientCredentialIds.length}</dd>
          </div>
          <div>
            <dt className="font-semibold text-awsm-ink">Recovery credentials</dt>
            <dd className="text-awsm-text-muted">
              {authority.effectiveRecoveryCredentialIds.length}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-awsm-ink">Current Key Epochs</dt>
            <dd className="grid gap-1 font-mono text-xs text-awsm-text-muted">
              {authority.currentKeyEpochIds.length === 0
                ? "None"
                : authority.currentKeyEpochIds.map((id) => (
                    <span key={id} title={id}>
                      {displayIdentifier(id)}
                    </span>
                  ))}
            </dd>
          </div>
        </dl>
      </Card>
    </section>
  );
}

function HostedReplicas({
  binding,
  vaultId,
  remotes,
  onRefresh,
  onError,
  onStatus,
}: {
  readonly binding: DesktopBinding;
  readonly vaultId: string;
  readonly remotes: readonly Remote[];
  readonly onRefresh: () => void;
  readonly onError: (error: unknown) => void;
  readonly onStatus: (message: string) => void;
}): React.ReactElement {
  const [endpoint, setEndpoint] = React.useState("");
  const [name, setName] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      await binding.VaultCommand?.({
        type: "CreateHostedReplica",
        expectedVaultId: vaultId,
        endpoint,
        name,
        username,
        password,
      });
      setPassword("");
      onRefresh();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (remote: Remote) => {
    setBusy(true);
    try {
      await binding.VaultCommand?.({
        type: "SetRemoteEnabled",
        expectedVaultId: vaultId,
        remoteId: remote.remoteId,
        enabled: !remote.enabled,
      });
      onRefresh();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const materialize = async (remote: Remote) => {
    setBusy(true);
    try {
      await binding.VaultCommand?.({
        type: "MaterializeHostedReplica",
        expectedVaultId: vaultId,
        remoteId: remote.remoteId,
      });
      onRefresh();
      onStatus("Hosted Replica materialized.");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const pull = async () => {
    setBusy(true);
    try {
      await binding.VaultCommand?.({
        type: "PullHostedReplicas",
        expectedVaultId: vaultId,
      });
      onRefresh();
      onStatus("Hosted Replica pull completed.");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-5" aria-labelledby="hosted-replicas-heading">
      <div className="grid gap-2">
        <h3
          id="hosted-replicas-heading"
          className="font-display text-2xl font-bold leading-tight text-awsm-ink"
        >
          Hosted Replicas
        </h3>
        <p className="max-w-[65ch] text-base leading-relaxed text-awsm-text-muted">
          This Client records access settings. The Hosted Replica remains another copy of the Vault;
          it is not a special Vault member.
        </p>
      </div>
      <ActionRow>
        <Button
          variant="secondary"
          busy={busy}
          disabled={remotes.length === 0}
          onClick={() => void pull()}
        >
          Check for updates
        </Button>
      </ActionRow>
      {remotes.length === 0 ? (
        <EmptyState title="No Hosted Replicas">
          <p>No Hosted Replicas are configured on this Client.</p>
        </EmptyState>
      ) : (
        <ul className="grid gap-3">
          {remotes.map((remote) => (
            <li
              key={remote.remoteId}
              className="grid gap-2 border-t-2 border-awsm-border-subtle py-4"
            >
              <strong className="text-base text-awsm-ink">{remote.name}</strong>
              <span className="break-all text-sm text-awsm-text-muted">{remote.endpoint}</span>
              <span className="text-sm font-semibold text-awsm-ink">
                {remote.enabled ? "Enabled" : "Paused"}
              </span>
              <ActionRow>
                <Button
                  variant="secondary"
                  busy={busy}
                  disabled={!remote.enabled}
                  onClick={() => void materialize(remote)}
                >
                  Materialize now
                </Button>
                <Button variant="quiet" busy={busy} onClick={() => void toggle(remote)}>
                  {remote.enabled ? "Pause" : "Resume"}
                </Button>
              </ActionRow>
            </li>
          ))}
        </ul>
      )}
      <form className="grid max-w-xl gap-5" onSubmit={(event) => void save(event)}>
        <Field label="Hosted Replica HTTPS address">
          <input
            className={inputClassName}
            type="url"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            required
          />
        </Field>
        <Field label="Hosted Replica name">
          <input
            className={inputClassName}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field label="Account username">
          <input
            className={inputClassName}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </Field>
        <Field label="Account password">
          <input
            className={inputClassName}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <Button type="submit" busy={busy}>
          Save Hosted Replica
        </Button>
      </form>
    </section>
  );
}

function CompleteExportPanel({
  binding,
  vaultId,
  refresh,
  onError,
  onStatus,
}: {
  readonly binding: DesktopBinding;
  readonly vaultId: string;
  readonly refresh: () => void;
  readonly onError: (error: unknown) => void;
  readonly onStatus: (message: string) => void;
}): React.ReactElement {
  const [exportPassphrase, setExportPassphrase] = React.useState("");
  const [exportedPackage, setExportedPackage] = React.useState("");
  const [importPassphrase, setImportPassphrase] = React.useState("");
  const [importPackage, setImportPackage] = React.useState("");
  const [busy, setBusy] = React.useState<"export" | "import">();

  const exportComplete = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (binding.VaultCommand === undefined)
      return onError(new Error("Vault commands are unavailable."));
    setBusy("export");
    try {
      const result = (await binding.VaultCommand({
        type: "ExportComplete",
        expectedVaultId: vaultId,
        passphrase: exportPassphrase,
      })) as { package?: string } | undefined;
      if (result?.package === undefined || result.package.length === 0) {
        throw new Error("The Complete Export did not return a package.");
      }
      setExportedPackage(result.package);
      onStatus("Complete Export created.");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(undefined);
    }
  };

  const importComplete = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (binding.VaultCommand === undefined)
      return onError(new Error("Vault commands are unavailable."));
    setBusy("import");
    try {
      await binding.VaultCommand({
        type: "ImportComplete",
        passphrase: importPassphrase,
        package: importPackage,
      });
      setImportPassphrase("");
      setImportPackage("");
      refresh();
      onStatus("Complete Import completed.");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="grid gap-5" aria-labelledby="complete-export-heading">
      <div className="grid gap-2">
        <h3
          id="complete-export-heading"
          className="font-display text-2xl font-bold leading-tight text-awsm-ink"
        >
          Complete Export and Import
        </h3>
        <p className="max-w-[65ch] text-base leading-relaxed text-awsm-text-muted">
          A Complete Export is an encrypted package for one Vault state. It does not include this
          Client&apos;s login, local credentials, or Hosted Replica sessions.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <form className="grid gap-5" onSubmit={(event) => void exportComplete(event)}>
          <Field
            label="Export passphrase"
            description="Use the same passphrase when importing this package on another Client."
          >
            <input
              className={inputClassName}
              type="password"
              value={exportPassphrase}
              onChange={(event) => setExportPassphrase(event.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          <Button type="submit" busy={busy === "export"} disabled={busy !== undefined}>
            Create Complete Export
          </Button>
          {exportedPackage !== "" ? (
            <Field label="Complete Export package">
              <textarea
                className={`${inputClassName} min-h-32 resize-y font-mono text-xs`}
                value={exportedPackage}
                readOnly
                spellCheck={false}
                aria-label="Complete Export package"
              />
            </Field>
          ) : null}
        </form>
        <form className="grid gap-5" onSubmit={(event) => void importComplete(event)}>
          <Field label="Import passphrase">
            <input
              className={inputClassName}
              type="password"
              value={importPassphrase}
              onChange={(event) => setImportPassphrase(event.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          <Field label="Complete Export package to import">
            <textarea
              className={`${inputClassName} min-h-32 resize-y font-mono text-xs`}
              value={importPackage}
              onChange={(event) => setImportPackage(event.target.value)}
              spellCheck={false}
              aria-label="Complete Export package to import"
              required
            />
          </Field>
          <Button type="submit" busy={busy === "import"} disabled={busy !== undefined}>
            Import Complete Export
          </Button>
        </form>
      </div>
    </section>
  );
}

function VaultsView({
  binding,
  state,
  authority,
  libraryProjection,
  remotes,
  refresh,
  onError,
  onStatus,
}: {
  readonly binding: DesktopBinding;
  readonly state: RuntimeState | undefined;
  readonly authority: AuthorityState | undefined;
  readonly libraryProjection: LibraryProjection;
  readonly remotes: readonly Remote[];
  readonly refresh: () => void;
  readonly onError: (error: unknown) => void;
  readonly onStatus: (message: string) => void;
}): React.ReactElement {
  const selected = vaultContext(state);
  const [phraseSetup, setPhraseSetup] = React.useState<PhraseSetup>();
  const [busy, setBusy] = React.useState(false);
  const beginPhraseAction = async (action: PhraseAction) => {
    if (selected === undefined) return;
    setBusy(true);
    try {
      const command = action === "fork" ? "BeginVaultFork" : "BeginRecoveryPhraseReplacement";
      const setup = await binding.VaultCommand?.({
        type: command,
        expectedVaultId: selected.vaultId,
      });
      setPhraseSetup({ ...(setup as { setupId: string; recoveryPhrase: string }), action });
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const destructive = async (type: "VacuumVault" | "CloseVault", prompt: string) => {
    if (selected === undefined || !window.confirm(prompt)) return;
    setBusy(true);
    try {
      await binding.VaultCommand?.({ type, expectedVaultId: selected.vaultId });
      refresh();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const garbageCollect = async () => {
    if (selected === undefined || !window.confirm("Remove unreferenced local opaque items?"))
      return;
    setBusy(true);
    try {
      const result = (await binding.VaultCommand?.({
        type: "GarbageCollect",
        expectedVaultId: selected.vaultId,
      })) as { deletedStorageItemIds?: readonly string[] } | undefined;
      const count = result?.deletedStorageItemIds?.length ?? 0;
      refresh();
      onStatus(
        `Garbage Collection completed. ${count} unreferenced item${count === 1 ? "" : "s"} removed.`,
      );
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  if (state?.pendingVaultCreation !== undefined)
    return (
      <PendingCreationPanel
        binding={binding}
        setupId={state.pendingVaultCreation.setupId}
        onComplete={refresh}
        onError={onError}
      />
    );
  if (phraseSetup !== undefined && selected !== undefined)
    return (
      <PhrasePanel
        binding={binding}
        vaultId={selected.vaultId}
        setup={phraseSetup}
        onDone={() => {
          setPhraseSetup(undefined);
          refresh();
        }}
        onError={onError}
      />
    );
  if (state === undefined || state.vaults.length === 0)
    return (
      <VaultCreationPanel
        binding={binding}
        expectedVaultId={null}
        onComplete={refresh}
        onError={onError}
      />
    );
  return (
    <div className="grid gap-8">
      <section className="grid gap-4" aria-labelledby="vaults-heading">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2
            id="vaults-heading"
            className="font-display text-2xl font-bold leading-tight text-awsm-ink"
          >
            Vaults
          </h2>
          <Button
            variant="secondary"
            onClick={() => void beginPhraseAction("fork")}
            disabled={selected === undefined}
          >
            Fork this Vault
          </Button>
        </div>
        <ul className="grid gap-3">
          {state.vaults.map((vault) => (
            <li
              key={vault.vaultId}
              className={`grid gap-2 border-2 p-4 ${vault.selected ? "border-awsm-ink bg-awsm-selected" : "border-awsm-border-subtle bg-awsm-paper"}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <strong className="text-base text-awsm-ink">
                  {displayVaultLabel(vault.label)}
                </strong>
                <span className="text-sm font-semibold text-awsm-text-muted">
                  {displayVaultLabel(vault.label)} · {vault.lifecycle} · {vault.access}
                </span>
              </div>
              {vault.selected ? (
                <BadgeLike>Selected</BadgeLike>
              ) : (
                <Button
                  variant="quiet"
                  onClick={() => {
                    if (binding.VaultCommand === undefined) return;
                    void Promise.resolve(
                      binding.VaultCommand({
                        type: "SelectVault",
                        expectedVaultId: state.selectedVaultId ?? null,
                        vaultId: vault.vaultId,
                      }),
                    )
                      .then(refresh)
                      .catch(onError);
                  }}
                >
                  Use Vault
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      {selected === undefined ? (
        <EmptyState title="Choose a Vault">Select a Vault to manage it.</EmptyState>
      ) : (
        <section className="grid gap-6" aria-labelledby="vault-detail-heading">
          <div className="grid gap-2">
            <h2
              id="vault-detail-heading"
              className="font-display text-2xl font-bold leading-tight text-awsm-ink"
            >
              {displayVaultLabel(selected.label)}
            </h2>
            <p className="text-base leading-relaxed text-awsm-text-muted">
              {selected.lifecycle} · {selected.access}
            </p>
          </div>
          <ActionRow>
            <Button
              variant="secondary"
              busy={busy}
              onClick={() => void beginPhraseAction("replace")}
            >
              Change Recovery Phrase
            </Button>
            {selected.lifecycle === "Open" ? (
              <>
                <Button
                  variant="secondary"
                  busy={busy}
                  onClick={() =>
                    void destructive("VacuumVault", "Vacuum creates a new baseline. Continue?")
                  }
                >
                  Vacuum this Vault
                </Button>
                <Button variant="secondary" busy={busy} onClick={() => void garbageCollect()}>
                  Run Garbage Collection
                </Button>
                <Button
                  variant="danger"
                  busy={busy}
                  onClick={() =>
                    void destructive(
                      "CloseVault",
                      "Closing stops new Events in this Vault. Continue?",
                    )
                  }
                >
                  Close Vault
                </Button>
              </>
            ) : null}
          </ActionRow>
          {authority !== undefined ? <AuthoritySummary authority={authority} /> : null}
          <section className="grid gap-4" aria-labelledby="library-heading">
            <h3
              id="library-heading"
              className="font-display text-2xl font-bold leading-tight text-awsm-ink"
            >
              Library
            </h3>
            <LibraryList
              items={libraryProjection.captures}
              binding={binding}
              vaultId={selected.vaultId}
              onRefresh={refresh}
              onError={onError}
              onStatus={onStatus}
            />
            <LibrarySemanticSummary projection={libraryProjection} />
          </section>
          <HostedReplicas
            binding={binding}
            vaultId={selected.vaultId}
            remotes={remotes}
            onRefresh={refresh}
            onError={onError}
            onStatus={onStatus}
          />
          <CompleteExportPanel
            binding={binding}
            vaultId={selected.vaultId}
            refresh={refresh}
            onError={onError}
            onStatus={onStatus}
          />
        </section>
      )}
    </div>
  );
}

function BadgeLike({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return (
    <span className="inline-flex min-h-7 items-center rounded-full border-2 border-awsm-ink bg-awsm-yellow px-3 py-0.5 text-xs font-extrabold text-awsm-accent-foreground">
      {children}
    </span>
  );
}

function LibraryView({
  binding,
  state,
  libraryProjection,
  refresh,
  onError,
  onStatus,
}: {
  readonly binding: DesktopBinding;
  readonly state: RuntimeState | undefined;
  readonly libraryProjection: LibraryProjection;
  readonly refresh: () => void;
  readonly onError: (error: unknown) => void;
  readonly onStatus: (message: string) => void;
}): React.ReactElement {
  const vault = vaultContext(state);
  if (vault === undefined)
    return (
      <EmptyState title="Choose a Vault">Select a Vault before opening its Library.</EmptyState>
    );
  return (
    <section className="grid gap-5" aria-labelledby="library-page-heading">
      <div className="grid gap-2">
        <h2
          id="library-page-heading"
          className="font-display text-2xl font-bold leading-tight text-awsm-ink"
        >
          Library
        </h2>
        <p className="text-base leading-relaxed text-awsm-text-muted">
          {displayVaultLabel(vault.label)} · Captures remain in the Vault and are not copied into
          the browser extension.
        </p>
      </div>
      <LibraryList
        items={libraryProjection.captures}
        binding={binding}
        vaultId={vault.vaultId}
        onRefresh={refresh}
        onError={onError}
        onStatus={onStatus}
      />
      <LibrarySemanticSummary projection={libraryProjection} />
    </section>
  );
}

function ConnectionsView({
  binding,
  pairings,
  grants,
  transfers,
  address,
  refresh,
  onError,
}: {
  readonly binding: DesktopBinding;
  readonly pairings: readonly Pairing[];
  readonly grants: readonly Grant[];
  readonly transfers: readonly Transfer[];
  readonly address: string;
  readonly refresh: () => void;
  readonly onError: (error: unknown) => void;
}): React.ReactElement {
  const [busy, setBusy] = React.useState<string>();
  const invoke = async (key: string, action: () => MaybePromise<void>) => {
    setBusy(key);
    try {
      await action();
      refresh();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="grid gap-8">
      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <CardDescription>
            The desktop Runtime is a Client and a loopback API for explicitly paired Clients.
            Pairing does not create Vault membership.
          </CardDescription>
        </CardHeader>
        <p className="mt-5 flex items-center gap-2 text-sm font-semibold text-awsm-text-muted">
          <ShieldCheck aria-hidden="true" className="size-4 text-awsm-green" />
          Listening on {address}
        </p>
      </Card>
      <section className="grid gap-4" aria-labelledby="pairings-heading">
        <h2
          id="pairings-heading"
          className="font-display text-2xl font-bold leading-tight text-awsm-ink"
        >
          Pending pairing requests
        </h2>
        {pairings.length === 0 ? (
          <p className="text-base leading-relaxed text-awsm-text-muted">
            No pending pairing requests.
          </p>
        ) : (
          <ul className="grid gap-3">
            {pairings.map((pairing) => (
              <li
                key={pairing.pairingId}
                className="grid gap-2 border-t-2 border-awsm-border-subtle py-4"
              >
                <strong className="text-base text-awsm-ink">{pairing.clientName}</strong>
                <span className="text-sm text-awsm-text-muted">
                  Scopes: {pairing.scopes.join(", ")}
                </span>
                <Button
                  busy={busy === pairing.pairingId}
                  onClick={() =>
                    void invoke(pairing.pairingId, () => binding.ApprovePairing(pairing.pairingId))
                  }
                >
                  Approve pairing
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="grid gap-4" aria-labelledby="grants-heading">
        <h2
          id="grants-heading"
          className="font-display text-2xl font-bold leading-tight text-awsm-ink"
        >
          Active grants
        </h2>
        {grants.length === 0 ? (
          <p className="text-base leading-relaxed text-awsm-text-muted">No grants yet.</p>
        ) : (
          <ul className="grid gap-3">
            {grants.map((grant) => (
              <li
                key={grant.grantId}
                className="grid gap-2 border-t-2 border-awsm-border-subtle py-4"
              >
                <strong className="text-base text-awsm-ink">{grant.clientName}</strong>
                <span className="text-sm text-awsm-text-muted">
                  Scopes: {grant.scopes.join(", ")}
                </span>
                <span className="text-sm font-semibold text-awsm-ink">
                  {grant.revoked ? "Revoked" : "Active"}
                </span>
                {!grant.revoked ? (
                  <Button
                    variant="danger"
                    busy={busy === grant.grantId}
                    onClick={() =>
                      void invoke(grant.grantId, () => binding.RevokeGrant(grant.grantId))
                    }
                  >
                    Revoke grant
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {transfers.length > 0 ? (
        <section className="grid gap-4" aria-labelledby="transfers-heading">
          <h2
            id="transfers-heading"
            className="font-display text-2xl font-bold leading-tight text-awsm-ink"
          >
            Pending Vault moves
          </h2>
          <ul className="grid gap-3">
            {transfers.map((transfer) => (
              <li
                key={transfer.transferId}
                className="grid gap-2 border-t-2 border-awsm-border-subtle py-4"
              >
                <strong className="text-base text-awsm-ink">Vault {transfer.vaultId}</strong>
                <span className="text-sm text-awsm-text-muted">
                  {transfer.byteLength} bytes · {transfer.digest}
                </span>
                <ActionRow>
                  <Button
                    busy={busy === transfer.transferId}
                    onClick={() =>
                      binding.AcceptTransfer === undefined
                        ? undefined
                        : void invoke(transfer.transferId, () =>
                            binding.AcceptTransfer?.(transfer.transferId),
                          )
                    }
                  >
                    Accept move
                  </Button>
                  <Button
                    variant="danger"
                    busy={busy === transfer.transferId}
                    onClick={() =>
                      binding.RejectTransfer === undefined
                        ? undefined
                        : void invoke(transfer.transferId, () =>
                            binding.RejectTransfer?.(transfer.transferId),
                          )
                    }
                  >
                    Reject move
                  </Button>
                </ActionRow>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function SettingsView({
  address,
  version,
}: {
  readonly address: string;
  readonly version: string | undefined;
}): React.ReactElement {
  return (
    <div className="grid gap-8">
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>
            Appearance is stored on this Client installation. It is not Vault data and is never
            synchronized.
          </CardDescription>
        </CardHeader>
        <div className="mt-6 max-w-sm">
          <AppearanceControl />
        </div>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Runtime details</CardTitle>
          <CardDescription>
            Keep this process on loopback unless a separately authenticated Host adapter is
            configured.
          </CardDescription>
        </CardHeader>
        <dl className="mt-6 grid gap-4 text-sm">
          <div>
            <dt className="font-bold text-awsm-ink">Runtime address</dt>
            <dd className="mt-1 break-all font-mono text-awsm-text-muted">{address}</dd>
          </div>
          <div>
            <dt className="font-bold text-awsm-ink">Runtime version</dt>
            <dd className="mt-1 font-mono text-awsm-text-muted">{version ?? "development"}</dd>
          </div>
        </dl>
      </Card>
      <Notice tone="info" title="Capture remains a browser action">
        This desktop Client manages Vaults and can serve paired API Clients. Page acquisition
        remains in the browser extension for this release.
      </Notice>
    </div>
  );
}

function DesktopApp(): React.ReactElement {
  const initialBinding = getBinding();
  const [activeSection, setActiveSection] = React.useState<Section>(
    initialBinding?.VaultCommand === undefined ? "connections" : "vaults",
  );
  const [binding, setBinding] = React.useState<DesktopBinding | undefined>(initialBinding);
  const [state, setState] = React.useState<RuntimeState>();
  const emptyLibraryProjection: LibraryProjection = React.useMemo(
    () => ({
      captures: [],
      collections: [],
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [],
      conflicts: [],
    }),
    [],
  );
  const [libraryProjection, setLibraryProjection] =
    React.useState<LibraryProjection>(emptyLibraryProjection);
  const [authority, setAuthority] = React.useState<AuthorityState>();
  const [remotes, setRemotes] = React.useState<readonly Remote[]>([]);
  const [pairings, setPairings] = React.useState<readonly Pairing[]>([]);
  const [grants, setGrants] = React.useState<readonly Grant[]>([]);
  const [transfers, setTransfers] = React.useState<readonly Transfer[]>([]);
  const [address, setAddress] = React.useState("127.0.0.1:37373");
  const [version, setVersion] = React.useState<string>();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [status, setStatus] = React.useState<string>();
  const [announce, setAnnounce] = React.useState("");

  const refresh = React.useCallback(async () => {
    const nextBinding = getBinding();
    setBinding(nextBinding);
    if (nextBinding === undefined) {
      setLoading(false);
      setError("Desktop Runtime bindings are unavailable.");
      return;
    }
    try {
      const nextAddress = await nextBinding.RuntimeAddress();
      setAddress(nextAddress);
      if (nextBinding.RuntimeVersion !== undefined) setVersion(await nextBinding.RuntimeVersion());
      setPairings(await nextBinding.PendingPairings());
      setGrants(await nextBinding.ListGrants());
      if (nextBinding.PendingTransfers !== undefined)
        setTransfers(await nextBinding.PendingTransfers());
      if (nextBinding.VaultCommand !== undefined) {
        const nextState = (await nextBinding.VaultCommand({ type: "GetState" })) as RuntimeState;
        setState(nextState);
        if (nextState.selectedVaultId !== undefined) {
          const [nextLibraryProjection, nextRemotes, nextAuthority] = await Promise.all([
            nextBinding.VaultCommand({
              type: "ListLibraryProjection",
              expectedVaultId: nextState.selectedVaultId,
            }) as Promise<LibraryProjection>,
            nextBinding.VaultCommand({
              type: "ListRemotes",
              expectedVaultId: nextState.selectedVaultId,
            }) as Promise<readonly Remote[]>,
            nextBinding.VaultCommand({
              type: "GetAuthorityState",
              expectedVaultId: nextState.selectedVaultId,
            }) as Promise<AuthorityState>,
          ]);
          setLibraryProjection(nextLibraryProjection);
          setRemotes(nextRemotes);
          setAuthority(nextAuthority);
        } else {
          setLibraryProjection(emptyLibraryProjection);
          setRemotes([]);
          setAuthority(undefined);
        }
      }
      setError(undefined);
      setAnnounce("Runtime state updated");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const setErrorFromUnknown = (reason: unknown) => setError(errorMessage(reason));
  const setStatusMessage = (message: string) => {
    setStatus(message);
    setAnnounce(message);
  };
  const selectVault = (vaultId: string) => {
    if (binding?.VaultCommand === undefined || state?.selectedVaultId === vaultId) return;
    void Promise.resolve(
      binding.VaultCommand({
        type: "SelectVault",
        expectedVaultId: state?.selectedVaultId ?? null,
        vaultId,
      }),
    )
      .then(refresh)
      .catch(setErrorFromUnknown);
  };
  const selected = vaultContext(state);
  const sectionTitle =
    activeSection === "vaults"
      ? "Vaults"
      : activeSection === "library"
        ? "Library"
        : activeSection === "connections"
          ? "Connections"
          : "Settings";
  return (
    <AppearanceProvider>
      <AppShell
        sidebar={
          <DesktopSidebar
            activeSection={activeSection}
            onNavigate={setActiveSection}
            state={state}
            onSelectVault={selectVault}
          />
        }
      >
        <div className="grid gap-8" aria-busy={loading}>
          <PageHeader
            eyebrow="AWSM Desktop Runtime"
            title="Desktop Runtime"
            description={
              selected === undefined
                ? "A local-first Client for managing encrypted Vaults."
                : `${sectionTitle} · ${displayVaultLabel(selected.label)}`
            }
            actions={
              <Button
                variant="quiet"
                size="icon"
                aria-label="Refresh Runtime state"
                onClick={() => void refresh()}
              >
                <RefreshCw aria-hidden="true" />
              </Button>
            }
          />
          {announce !== "" ? (
            <p className="awsm-sr-only" aria-live="polite">
              {announce}
            </p>
          ) : null}
          {error !== undefined ? (
            <Notice tone="danger" title="Runtime action failed">
              {error}
            </Notice>
          ) : null}
          {status !== undefined ? (
            <Notice tone="info" title="Runtime action completed">
              {status}
            </Notice>
          ) : null}
          {loading && binding === undefined ? <LoadingNotice /> : null}
          {binding === undefined ? (
            <EmptyState title="Runtime unavailable">
              Start the AWSM desktop Runtime to manage Vaults on this Client.
            </EmptyState>
          ) : activeSection === "vaults" && binding.VaultCommand !== undefined ? (
            <VaultsView
              binding={binding}
              state={state}
              authority={authority}
              libraryProjection={libraryProjection}
              remotes={remotes}
              refresh={() => void refresh()}
              onError={setErrorFromUnknown}
              onStatus={setStatusMessage}
            />
          ) : activeSection === "library" && binding.VaultCommand !== undefined ? (
            <LibraryView
              binding={binding}
              state={state}
              libraryProjection={libraryProjection}
              refresh={() => void refresh()}
              onError={setErrorFromUnknown}
              onStatus={setStatusMessage}
            />
          ) : activeSection === "connections" ? (
            <ConnectionsView
              binding={binding}
              pairings={pairings}
              grants={grants}
              transfers={transfers}
              address={address}
              refresh={() => void refresh()}
              onError={setErrorFromUnknown}
            />
          ) : (
            <SettingsView address={address} version={version} />
          )}
        </div>
      </AppShell>
    </AppearanceProvider>
  );
}

createRoot(document.querySelector<HTMLElement>("#app") ?? document.body).render(<DesktopApp />);
