import { AppearanceProvider, Button, inputClassName, Notice } from "@awsm/ui";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import {
  CanonicalApplicationClientError,
  sendCanonicalApplicationRequest,
  subscribeCanonicalApplicationState,
} from "../../src/app/canonical-application-client";
import { requestDesktopRuntimePermission } from "../../src/hosts/desktop/permission";
import { DesktopRuntimeApplicationRouter } from "../../src/hosts/desktop/runtime-application-router";
import type {
  CanonicalDesktopRuntimeConnection,
  DesktopRuntimeConnectionStatus,
} from "../../src/hosts/desktop/runtime-connection";
import { getDesktopRuntimeConnection } from "../../src/hosts/desktop/runtime-connection-factory";
import {
  requestHostedReplicaPermission,
  requestHostedReplicaPermissions,
} from "../../src/ui/canonical-hosted-replica-permission";
import {
  type CanonicalPopupApplicationClient,
  createCanonicalPopupApplicationClient,
} from "../../src/ui/canonical-popup-application-client";
import {
  CanonicalPopupController,
  type CanonicalPopupView,
} from "../../src/ui/canonical-popup-controller";
import {
  type CanonicalPopupRecoveryConfirmation,
  canonicalPopupPresentation,
} from "../../src/ui/canonical-popup-presentation";
import "@awsm/ui/styles.css";

type PopupScreen =
  | "Capture"
  | "Settings"
  | "HostedMemberRecovery"
  | "HostedReplicaSetup"
  | "HostedReplicaAttachment"
  | "HostedReplicaAttachmentSelection"
  | "HostedReplicaRename"
  | "HostedReplicaRetirement"
  | "RecoveryPhraseReplacement"
  | "Fork"
  | "VacuumConfirmation"
  | "ClosureConfirmation";

const applicationRouter = new DesktopRuntimeApplicationRouter({
  request: sendCanonicalApplicationRequest,
  subscribe: subscribeCanonicalApplicationState,
});
const client: CanonicalPopupApplicationClient =
  createCanonicalPopupApplicationClient(applicationRouter);

function errorMessage(error: unknown): string {
  if (error instanceof CanonicalApplicationClientError) return error.message;
  return error instanceof Error
    ? error.message
    : "The local archive could not complete that action.";
}

function displayVaultLabel(label: string | null): string {
  return label === null || label.length === 0 ? "Untitled Vault" : label;
}

function displayCaptureTitle(title: string | null, url: string): string {
  return title === null || title.length === 0 ? new URL(url).hostname : title;
}

function fieldId(label: string): string {
  return `awsm-${label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}`;
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  required = true,
  autoComplete = "off",
  maxLength,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: React.HTMLInputTypeAttribute;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly autoComplete?: string;
  readonly maxLength?: number;
}): React.ReactElement {
  const id = fieldId(label);
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-bold leading-tight text-awsm-ink">
        {label}
      </label>
      <input
        id={id}
        className={inputClassName}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
        maxLength={maxLength}
      />
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  readOnly = false,
  rows = 3,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange?: (value: string) => void;
  readonly readOnly?: boolean;
  readonly rows?: number;
}): React.ReactElement {
  const id = fieldId(label);
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-bold leading-tight text-awsm-ink">
        {label}
      </label>
      <textarea
        id={id}
        className={`${inputClassName} min-h-24 resize-y`}
        value={value}
        onChange={onChange === undefined ? undefined : (event) => onChange(event.target.value)}
        readOnly={readOnly}
        required={!readOnly}
        rows={rows}
        autoComplete="off"
      />
    </div>
  );
}

function ActionBar({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

function BrandHeader({ title }: { readonly title: string }): React.ReactElement {
  return (
    <div className="canonical-popup__brand grid gap-3">
      <div className="flex items-center gap-2">
        <img
          src={browser.runtime.getURL("/icon-48.png")}
          alt=""
          aria-hidden="true"
          className="h-8 w-8 object-contain"
        />
        <span className="text-xs font-extrabold uppercase tracking-[0.08em] text-awsm-text-muted">
          AWSM
        </span>
      </div>
      <h1 className="font-display text-3xl font-bold leading-tight tracking-[-0.025em] text-awsm-ink">
        {title}
      </h1>
    </div>
  );
}

function Status({
  message,
  kind = "info",
}: {
  readonly message: string;
  readonly kind?: "info" | "success" | "error";
}): React.ReactElement {
  return (
    <p
      className={`canonical-popup__status canonical-popup__status--${kind} max-w-[65ch] rounded-control border-2 border-awsm-ink p-4 text-base leading-relaxed ${kind === "error" ? "bg-awsm-danger-pale" : kind === "success" ? "bg-awsm-success-pale" : "bg-awsm-info-pale"}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {message}
    </p>
  );
}

function DesktopRuntimePanel({
  busy,
  run,
}: {
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
}): React.ReactElement {
  const [connection, setConnection] = React.useState<CanonicalDesktopRuntimeConnection>();
  const [status, setStatus] = React.useState<DesktopRuntimeConnectionStatus>({
    kind: "Disconnected",
  });
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    let active = true;
    void getDesktopRuntimeConnection()
      .then(async (next) => {
        const restored = await next.restore();
        if (!active) return;
        setConnection(next);
        setStatus(restored);
        applicationRouter.setDesktopConnection(next);
      })
      .catch(() => {
        if (active)
          setStatus({ kind: "Unavailable", message: "Desktop Runtime storage is unavailable." });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const text = loading
    ? "Checking Desktop Runtime…"
    : status.kind === "Connected"
      ? `Connected · ${status.scopes.join(", ")}`
      : status.kind === "WaitingForApproval"
        ? "Waiting for approval in the Desktop Runtime window."
        : status.kind === "Unavailable"
          ? status.message
          : (status.message ?? "Not connected.");
  return (
    <section className="grid gap-4 rounded-control border-2 border-awsm-ink bg-awsm-paper p-6 text-awsm-ink">
      <div className="grid gap-2">
        <h2 className="font-display text-2xl font-bold leading-tight">Desktop Runtime</h2>
        <p className="max-w-[65ch] text-base leading-relaxed text-awsm-text-muted">
          Connect this extension to a Desktop Runtime on this computer. Browser-local Vault storage
          remains the default.
        </p>
        <p className="text-sm font-semibold text-awsm-text-muted">{text}</p>
      </div>
      <ActionBar>
        {status.kind === "Connected" ? (
          <Button
            variant="danger"
            busy={busy}
            onClick={() =>
              run(async () => {
                await connection?.disconnect();
                if (connection !== undefined) {
                  const next = connection.status();
                  setStatus(next);
                  applicationRouter.setDesktopConnection(connection);
                }
              })
            }
          >
            Disconnect Desktop Runtime
          </Button>
        ) : (
          <Button
            busy={busy}
            onClick={() =>
              run(async () => {
                await requestDesktopRuntimePermission();
                const next = connection ?? (await getDesktopRuntimeConnection());
                setConnection(next);
                setStatus({ kind: "WaitingForApproval" });
                const nextStatus = await next.connect({ permissionAlreadyGranted: true });
                setStatus(nextStatus);
                applicationRouter.setDesktopConnection(next);
              })
            }
          >
            Connect Desktop Runtime
          </Button>
        )}
      </ActionBar>
    </section>
  );
}

function PopupApp(): React.ReactElement {
  const [view, setView] = React.useState<CanonicalPopupView>();
  const [pendingRecovery, setPendingRecovery] =
    React.useState<CanonicalPopupRecoveryConfirmation>();
  const [screen, setScreen] = React.useState<PopupScreen>("Capture");
  const [renameRemoteId, setRenameRemoteId] = React.useState<string>();
  const [retireRemoteId, setRetireRemoteId] = React.useState<string>();
  const [attachmentSetup, setAttachmentSetup] =
    React.useState<
      Awaited<ReturnType<CanonicalPopupApplicationClient["beginHostedReplicaAttachment"]>>
    >();
  const [phraseSetup, setPhraseSetup] =
    React.useState<
      Awaited<ReturnType<CanonicalPopupApplicationClient["beginRecoveryPhraseReplacement"]>>
    >();
  const [forkSetup, setForkSetup] =
    React.useState<Awaited<ReturnType<CanonicalPopupApplicationClient["beginVaultFork"]>>>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const announcer = React.useRef<HTMLParagraphElement>(null);
  const controllerRef = React.useRef<CanonicalPopupController>();
  if (controllerRef.current === undefined)
    controllerRef.current = new CanonicalPopupController(client, setView);
  const controller = controllerRef.current;

  React.useEffect(() => {
    void controller.start().catch((reason: unknown) => setError(errorMessage(reason)));
    return () => controller.stop();
  }, [controller]);

  const announce = React.useCallback((message: string) => {
    if (announcer.current !== null) announcer.current.textContent = message;
  }, []);
  const run = React.useCallback(
    async (operation: () => Promise<void>) => {
      setBusy(true);
      setError(undefined);
      try {
        await operation();
      } catch (reason) {
        const message = errorMessage(reason);
        setError(message);
        announce(message);
      } finally {
        setBusy(false);
      }
    },
    [announce],
  );
  const refresh = React.useCallback(async () => controller.refresh(), [controller]);

  if (view === undefined)
    return (
      <div className="awsm-app-root canonical-popup grid gap-6 p-5" aria-busy="true">
        <BrandHeader title="Local archive" />
        <Status message="Loading your local Vault…" />
      </div>
    );
  const presentation = canonicalPopupPresentation(view.state, pendingRecovery);
  const selectedVault =
    view.state.selectedVaultId === undefined
      ? undefined
      : view.state.vaults.find(({ vaultId }) => vaultId === view.state.selectedVaultId);
  const title =
    presentation.kind === "CreateVault"
      ? screen === "HostedMemberRecovery"
        ? "Recover a Hosted Vault"
        : "Create your local Vault"
      : presentation.kind === "SelectVault"
        ? "Choose a Vault"
        : presentation.kind === "ConfirmRecoveryPhrase"
          ? "Protect your Vault"
          : presentation.kind === "ResumeRecoveryPhrase"
            ? "Resume Vault setup"
            : presentation.kind === "RecoverAccess"
              ? "Recover Vault access"
              : presentation.kind === "ClosedVault"
                ? "Vault is closed"
                : screen === "Capture"
                  ? "Archive this page"
                  : screen === "Settings"
                    ? "Vault settings"
                    : screen === "HostedMemberRecovery"
                      ? "Recover a Hosted Vault"
                      : screen === "HostedReplicaSetup"
                        ? "Connect a Hosted Replica"
                        : screen === "HostedReplicaAttachment"
                          ? "Use an existing Hosted Replica"
                          : screen === "HostedReplicaAttachmentSelection"
                            ? "Choose a Hosted Replica"
                            : screen === "HostedReplicaRename"
                              ? "Rename Hosted Replica"
                              : screen === "HostedReplicaRetirement"
                                ? "Remove Hosted Replica from this Client"
                                : screen === "RecoveryPhraseReplacement"
                                  ? "Replace your Recovery Phrase"
                                  : screen === "Fork"
                                    ? "Fork this Vault"
                                    : screen === "VacuumConfirmation"
                                      ? "Vacuum this Vault?"
                                      : "Close this Vault?";

  const openLibrary = () => {
    void browser.tabs
      .create({ url: browser.runtime.getURL("/library.html") })
      .catch((reason: unknown) => {
        setError(errorMessage(reason));
      });
  };
  const cancelTo = (next: PopupScreen = "Capture") => {
    setError(undefined);
    setScreen(next);
  };

  const body = (() => {
    if (presentation.kind === "CreateVault" && screen === "HostedMemberRecovery")
      return (
        <HostedMemberRecovery
          busy={busy}
          run={run}
          onBack={() => cancelTo()}
          onRecovered={async () => {
            cancelTo();
            announce("Vault recovered on this Client. The Host is not saved as a Remote.");
            await refresh();
          }}
        />
      );
    if (presentation.kind === "CreateVault")
      return (
        <CreateVault
          busy={busy}
          run={run}
          pending={pendingRecovery}
          onPending={setPendingRecovery}
          onRecovered={() => cancelTo()}
          onHostedRecovery={() => cancelTo("HostedMemberRecovery")}
          refresh={refresh}
        />
      );
    if (presentation.kind === "SelectVault")
      return (
        <VaultSelection vaults={presentation.vaults} busy={busy} run={run} onSelected={refresh} />
      );
    if (presentation.kind === "ConfirmRecoveryPhrase" && pendingRecovery !== undefined)
      return (
        <RecoveryConfirmation
          pending={pendingRecovery}
          busy={busy}
          run={run}
          onCancel={async () => {
            await client.cancelVaultCreation(pendingRecovery.setupId);
            setPendingRecovery(undefined);
            await refresh();
          }}
          onConfirmed={async () => {
            setPendingRecovery(undefined);
            announce("Vault created.");
            await refresh();
          }}
        />
      );
    if (presentation.kind === "ResumeRecoveryPhrase")
      return (
        <RecoveryResume
          setupId={presentation.setupId}
          busy={busy}
          run={run}
          onCanceled={refresh}
          onConfirmed={async () => {
            announce("Vault created.");
            await refresh();
          }}
        />
      );
    if (presentation.kind === "RecoverAccess")
      return (
        <RecoverAccess
          vault={presentation.vault}
          busy={busy}
          run={run}
          onRecovered={async () => {
            announce("Vault access recovered.");
            await refresh();
          }}
        />
      );
    if (presentation.kind === "Capture" || presentation.kind === "ClosedVault") {
      if (screen === "Capture")
        return (
          <CaptureSurface
            view={view}
            closed={presentation.kind === "ClosedVault"}
            busy={busy}
            run={run}
            onSettings={() => setScreen("Settings")}
            onOpenLibrary={openLibrary}
            announce={announce}
          />
        );
      if (screen === "Settings")
        return (
          <SettingsSurface
            view={view}
            closed={presentation.kind === "ClosedVault"}
            busy={busy}
            run={run}
            setScreen={setScreen}
            setRenameRemoteId={setRenameRemoteId}
            setRetireRemoteId={setRetireRemoteId}
            onPhraseSetup={setPhraseSetup}
            onForkSetup={setForkSetup}
            refresh={refresh}
            announce={announce}
          />
        );
      if (screen === "HostedMemberRecovery")
        return (
          <HostedMemberRecovery
            busy={busy}
            run={run}
            onBack={() => cancelTo("Settings")}
            onRecovered={async () => {
              cancelTo("Settings");
              await refresh();
            }}
          />
        );
      if (selectedVault === undefined)
        return <Status message="The selected Vault is unavailable." kind="error" />;
      if (screen === "HostedReplicaSetup")
        return (
          <HostedReplicaSetup
            vault={selectedVault}
            busy={busy}
            run={run}
            onCancel={() => cancelTo("Settings")}
            onConnected={async () => {
              cancelTo("Settings");
              announce("Hosted Replica connected.");
              await refresh();
            }}
          />
        );
      if (screen === "HostedReplicaAttachment")
        return (
          <HostedReplicaAttachment
            vault={selectedVault}
            busy={busy}
            run={run}
            onCancel={() => cancelTo("Settings")}
            onSetup={(setup) => {
              setAttachmentSetup(setup);
              setScreen("HostedReplicaAttachmentSelection");
            }}
          />
        );
      if (screen === "HostedReplicaAttachmentSelection" && attachmentSetup !== undefined)
        return (
          <HostedReplicaAttachmentSelection
            vaultId={selectedVault.vaultId}
            setup={attachmentSetup}
            busy={busy}
            run={run}
            onCancel={async () => {
              await client.cancelHostedReplicaAttachment(attachmentSetup.setupId);
              cancelTo("Settings");
            }}
            onConfirmed={async () => {
              cancelTo("Settings");
              announce("Hosted Replica connected locally.");
              await refresh();
            }}
          />
        );
      if (screen === "HostedReplicaRename" && renameRemoteId !== undefined)
        return (
          <HostedReplicaRename
            view={view}
            remoteId={renameRemoteId}
            busy={busy}
            run={run}
            onCancel={() => cancelTo("Settings")}
            onSaved={async () => {
              cancelTo("Settings");
              announce("Hosted Replica renamed locally.");
              await refresh();
            }}
          />
        );
      if (screen === "HostedReplicaRetirement" && retireRemoteId !== undefined)
        return (
          <HostedReplicaRetirement
            view={view}
            remoteId={retireRemoteId}
            busy={busy}
            run={run}
            onCancel={() => cancelTo("Settings")}
            onRemoved={async () => {
              cancelTo("Settings");
              announce(
                "Hosted Replica removed from this Client. The Replica Host was not contacted.",
              );
              await refresh();
            }}
          />
        );
      if (screen === "RecoveryPhraseReplacement" && phraseSetup !== undefined)
        return (
          <PhraseReplacement
            setup={phraseSetup}
            busy={busy}
            run={run}
            onCancel={async () => {
              await client.cancelRecoveryPhraseReplacement(phraseSetup.setupId);
              cancelTo("Settings");
            }}
            onConfirmed={async () => {
              cancelTo("Settings");
              announce("Recovery Phrase replaced.");
              await refresh();
            }}
          />
        );
      if (screen === "Fork" && forkSetup !== undefined)
        return (
          <ForkSurface
            setup={forkSetup}
            busy={busy}
            run={run}
            onCancel={async () => {
              await client.cancelVaultFork(forkSetup.setupId);
              cancelTo("Settings");
            }}
            onConfirmed={async () => {
              cancelTo();
              announce("Vault forked.");
              await refresh();
            }}
          />
        );
      if (screen === "VacuumConfirmation")
        return (
          <ConfirmationSurface
            title="Vacuum this Vault?"
            message="Vacuum creates a new baseline. Other Replicas can adopt it, or Fork before adoption to retain the older history. This Client does not delete old bytes automatically."
            confirmLabel="Confirm Vacuum"
            cancelLabel="Cancel Vacuum"
            danger
            busy={busy}
            onCancel={() => cancelTo("Settings")}
            onConfirm={() =>
              run(async () => {
                if (selectedVault === undefined) return;
                await client.vacuumVault(selectedVault.vaultId);
                cancelTo("Settings");
                announce("Vault Vacuum created.");
                await refresh();
              })
            }
          />
        );
      if (screen === "ClosureConfirmation")
        return (
          <ConfirmationSurface
            title="Close this Vault?"
            message="Closing stops new Events in this Vault. Existing Replicas keep their current data and can Fork it into a new Vault."
            confirmLabel="Confirm closure"
            cancelLabel="Cancel closure"
            danger
            busy={busy}
            onCancel={() => cancelTo("Settings")}
            onConfirm={() =>
              run(async () => {
                if (selectedVault === undefined) return;
                await client.closeVault(selectedVault.vaultId);
                cancelTo();
                announce("Vault closed.");
                await refresh();
              })
            }
          />
        );
    }
    return <Status message="This Vault surface is unavailable." kind="error" />;
  })();

  return (
    <div className="awsm-app-root canonical-popup grid gap-6 p-5" aria-busy={busy}>
      <BrandHeader title={title} />
      {error !== undefined ? <Status message={error} kind="error" /> : null}
      <div className="grid gap-6">{body}</div>
      <p id="announcer" ref={announcer} className="awsm-sr-only" aria-live="polite" />
    </div>
  );
}

function CreateVault({
  busy,
  run,
  pending,
  onPending,
  onHostedRecovery,
  refresh,
}: {
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly pending?: CanonicalPopupRecoveryConfirmation;
  readonly onPending: (pending: CanonicalPopupRecoveryConfirmation) => void;
  readonly onHostedRecovery: () => void;
  readonly onRecovered: () => void;
  readonly refresh: () => Promise<void>;
}): React.ReactElement {
  const [name, setName] = React.useState("");
  if (pending !== undefined)
    return (
      <RecoveryConfirmation
        pending={pending}
        busy={busy}
        run={run}
        onCancel={async () => {
          await client.cancelVaultCreation(pending.setupId);
          onPending(undefined);
          await refresh();
        }}
        onConfirmed={async () => {
          onPending(undefined);
          await refresh();
        }}
      />
    );
  return (
    <>
      <p className="max-w-[65ch] text-base leading-relaxed text-awsm-ink">
        Create a Vault on this Client. It stays private to this Client unless you later connect a
        Replica Host.
      </p>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            onPending(
              await client.beginVaultCreation({
                expectedVaultId: null,
                label: name.trim() === "" ? null : name.trim(),
              }),
            );
            await refresh();
          });
        }}
      >
        <TextField
          label="Vault name"
          value={name}
          onChange={setName}
          placeholder="Personal archive"
          maxLength={256}
        />
        <Button type="submit" busy={busy}>
          Create Vault
        </Button>
      </form>
      <Button variant="quiet" onClick={onHostedRecovery}>
        Recover a Hosted Vault
      </Button>
    </>
  );
}

function HostedMemberRecovery({
  busy,
  run,
  onBack,
  onRecovered,
}: {
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onBack: () => void;
  readonly onRecovered: () => Promise<void>;
}): React.ReactElement {
  const [endpoint, setEndpoint] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [phrase, setPhrase] = React.useState("");
  return (
    <>
      <Notice tone="warning">
        Recover an existing Vault from a Replica Host. Your Host Account opens a temporary channel
        only; your Recovery Phrase authorizes a fresh local Client Credential.
      </Notice>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            try {
              await requestHostedReplicaPermission(endpoint, {
                deniedMessage: "Allow access to this Replica Host before recovering a Vault.",
              });
              await client.recoverHostedMember({
                endpoint,
                username,
                password,
                recoveryPhrase: phrase,
              });
              await onRecovered();
            } finally {
              setPassword("");
              setPhrase("");
            }
          });
        }}
      >
        <TextField
          label="Hosted Replica address"
          type="url"
          value={endpoint}
          onChange={setEndpoint}
          placeholder="https://sync.example/"
        />
        <TextField
          label="Account username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          maxLength={256}
        />
        <TextField
          label="Account password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          maxLength={1024}
        />
        <TextAreaField label="Recovery Phrase" value={phrase} onChange={setPhrase} />
        <ActionBar>
          <Button
            variant="secondary"
            type="button"
            onClick={() => {
              setPassword("");
              setPhrase("");
              onBack();
            }}
          >
            Back to create Vault
          </Button>
          <Button type="submit" busy={busy}>
            Recover Hosted Vault
          </Button>
        </ActionBar>
      </form>
    </>
  );
}

function VaultSelection({
  vaults,
  busy,
  run,
  onSelected,
}: {
  readonly vaults: readonly CanonicalPopupView["state"]["vaults"][number][];
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onSelected: () => Promise<void>;
}): React.ReactElement {
  return (
    <>
      <p className="text-base leading-relaxed text-awsm-ink">
        Choose the Vault you want to use on this Client.
      </p>
      <div className="grid gap-3">
        {vaults.map((vault) => (
          <Button
            key={vault.vaultId}
            variant="secondary"
            busy={busy}
            onClick={() =>
              void run(async () => {
                await client.selectVault({ expectedVaultId: null, vaultId: vault.vaultId });
                await onSelected();
              })
            }
          >
            {displayVaultLabel(vault.label)}
          </Button>
        ))}
      </div>
    </>
  );
}

function RecoveryConfirmation({
  pending,
  busy,
  run,
  onCancel,
  onConfirmed,
}: {
  readonly pending: CanonicalPopupRecoveryConfirmation;
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onCancel: () => Promise<void>;
  readonly onConfirmed: () => Promise<void>;
}): React.ReactElement {
  const [confirmation, setConfirmation] = React.useState("");
  return (
    <>
      <Notice tone="warning">
        Write this Recovery Phrase down somewhere safe. Anyone who has it can access this Vault.
      </Notice>
      <TextAreaField label="Recovery Phrase" value={pending.recoveryPhrase} readOnly />
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await client.confirmVaultCreation({
              setupId: pending.setupId,
              recoveryPhrase: confirmation,
            });
            await onConfirmed();
          });
        }}
      >
        <TextField
          label="Type the Recovery Phrase to continue"
          value={confirmation}
          onChange={setConfirmation}
        />
        <ActionBar>
          <Button variant="secondary" type="button" onClick={() => void run(onCancel)}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Confirm Recovery Phrase
          </Button>
        </ActionBar>
      </form>
    </>
  );
}

function RecoveryResume({
  setupId,
  busy,
  run,
  onCanceled,
  onConfirmed,
}: {
  readonly setupId: string;
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onCanceled: () => Promise<void>;
  readonly onConfirmed: () => Promise<void>;
}): React.ReactElement {
  const [phrase, setPhrase] = React.useState("");
  return (
    <>
      <Notice tone="warning">
        Your Vault setup is waiting for its Recovery Phrase. Enter the phrase you wrote down to
        finish, or cancel this setup and begin again.
      </Notice>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await client.confirmVaultCreation({ setupId, recoveryPhrase: phrase });
            await onConfirmed();
          });
        }}
      >
        <TextAreaField label="Recovery Phrase" value={phrase} onChange={setPhrase} />
        <ActionBar>
          <Button variant="secondary" type="button" onClick={() => void run(onCanceled)}>
            Cancel setup
          </Button>
          <Button type="submit" busy={busy}>
            Resume Vault creation
          </Button>
        </ActionBar>
      </form>
    </>
  );
}

function RecoverAccess({
  vault,
  busy,
  run,
  onRecovered,
}: {
  readonly vault: CanonicalPopupView["state"]["vaults"][number];
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onRecovered: () => Promise<void>;
}): React.ReactElement {
  const [phrase, setPhrase] = React.useState("");
  return (
    <>
      <p className="canonical-popup__context text-sm font-semibold text-awsm-text-muted">
        Vault · {displayVaultLabel(vault.label)}
      </p>
      <Notice tone="warning">
        This Client can read this Vault but cannot add new Events. Enter a Recovery Phrase to
        restore access for this Member on this Client.
      </Notice>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await client.recoverMember({ expectedVaultId: vault.vaultId, recoveryPhrase: phrase });
            await onRecovered();
          });
        }}
      >
        <TextAreaField label="Recovery Phrase" value={phrase} onChange={setPhrase} />
        <Button type="submit" busy={busy}>
          Recover access
        </Button>
      </form>
    </>
  );
}

function CaptureSurface({
  view,
  closed,
  busy,
  run,
  onSettings,
  onOpenLibrary,
  announce,
}: {
  readonly view: CanonicalPopupView;
  readonly closed: boolean;
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onSettings: () => void;
  readonly onOpenLibrary: () => void;
  readonly announce: (message: string) => void;
}): React.ReactElement {
  const vault = view.state.vaults.find(({ vaultId }) => vaultId === view.state.selectedVaultId);
  if (vault === undefined)
    return <Status message="The selected Vault is unavailable." kind="error" />;
  const captures = view.library.filter(({ lifecycle }) => lifecycle === "Active").slice(0, 3);
  return (
    <>
      <p className="canonical-popup__context text-sm font-semibold text-awsm-text-muted">
        Vault · {displayVaultLabel(vault.label)}
      </p>
      {closed ? (
        <Notice tone="warning">
          This Vault is closed. You can still read what is available locally, or Fork its current
          state into a new Vault.
        </Notice>
      ) : null}
      {!closed ? (
        <Button
          className="w-full"
          busy={busy}
          onClick={() =>
            void run(async () => {
              await client.captureActivePage({ expectedVaultId: vault.vaultId });
              announce("Page archived.");
            })
          }
        >
          Archive this page
        </Button>
      ) : null}
      <ActionBar>
        <Button variant="secondary" onClick={onOpenLibrary}>
          Open Library
        </Button>
        <Button variant="quiet" onClick={onSettings}>
          Vault settings
        </Button>
      </ActionBar>
      <section className="grid gap-3 border-t-2 border-awsm-border-subtle pt-6">
        <h2 className="font-display text-2xl font-bold leading-tight">Recent captures</h2>
        {captures.length === 0 ? (
          <p className="text-base leading-relaxed text-awsm-text-muted">
            No pages have been archived in this Vault yet.
          </p>
        ) : (
          <ul className="grid gap-2">
            {captures.map((item) => (
              <li
                key={item.bundleId}
                className="grid gap-1 border-b border-awsm-border-subtle py-3"
              >
                <strong>{displayCaptureTitle(item.title, item.finalUrl)}</strong>
                <span className="text-sm text-awsm-text-muted">
                  {new URL(item.finalUrl).hostname}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function SettingsSurface({
  view,
  closed,
  busy,
  run,
  setScreen,
  setRenameRemoteId,
  setRetireRemoteId,
  onPhraseSetup,
  onForkSetup,
  refresh,
  announce,
}: {
  readonly view: CanonicalPopupView;
  readonly closed: boolean;
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly setScreen: (screen: PopupScreen) => void;
  readonly setRenameRemoteId: (id: string) => void;
  readonly setRetireRemoteId: (id: string) => void;
  readonly onPhraseSetup: (
    setup: Awaited<ReturnType<CanonicalPopupApplicationClient["beginRecoveryPhraseReplacement"]>>,
  ) => void;
  readonly onForkSetup: (
    setup: Awaited<ReturnType<CanonicalPopupApplicationClient["beginVaultFork"]>>,
  ) => void;
  readonly refresh: () => Promise<void>;
  readonly announce: (message: string) => void;
}): React.ReactElement {
  const vault = view.state.vaults.find(({ vaultId }) => vaultId === view.state.selectedVaultId);
  if (vault === undefined)
    return <Status message="The selected Vault is unavailable." kind="error" />;
  return (
    <>
      <p className="canonical-popup__context text-sm font-semibold text-awsm-text-muted">
        Vault · {displayVaultLabel(vault.label)}
      </p>
      <Notice tone="warning">
        {closed
          ? "This Vault is closed. Existing data remains readable here, and you can Fork its current state into a new Vault."
          : "Recovery, Fork, Vacuum, and closure affect this Vault. Your Host Account does not grant access to its contents."}
      </Notice>
      <ActionBar>
        {!closed ? (
          <Button
            variant="secondary"
            onClick={() =>
              void run(async () => {
                const setup = await client.beginRecoveryPhraseReplacement(vault.vaultId);
                onPhraseSetup(setup);
                setScreen("RecoveryPhraseReplacement");
              })
            }
          >
            Change Recovery Phrase
          </Button>
        ) : null}
        <Button
          variant="secondary"
          onClick={() =>
            void run(async () => {
              const setup = await client.beginVaultFork(vault.vaultId);
              onForkSetup(setup);
              setScreen("Fork");
            })
          }
        >
          Fork this Vault
        </Button>
        {!closed ? (
          <Button variant="secondary" onClick={() => setScreen("VacuumConfirmation")}>
            Vacuum this Vault
          </Button>
        ) : null}
        {!closed ? (
          <Button variant="danger" onClick={() => setScreen("ClosureConfirmation")}>
            Close Vault
          </Button>
        ) : null}
        <Button variant="quiet" onClick={() => setScreen("Capture")}>
          Back to Vault
        </Button>
      </ActionBar>
      <HostedReplicas
        view={view}
        busy={busy}
        run={run}
        setScreen={setScreen}
        setRenameRemoteId={setRenameRemoteId}
        setRetireRemoteId={setRetireRemoteId}
        refresh={refresh}
        announce={announce}
      />
      <DesktopRuntimePanel busy={busy} run={run} />
    </>
  );
}

function HostedReplicas({
  view,
  busy,
  run,
  setScreen,
  setRenameRemoteId,
  setRetireRemoteId,
  refresh,
  announce,
}: {
  readonly view: CanonicalPopupView;
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly setScreen: (screen: PopupScreen) => void;
  readonly setRenameRemoteId: (id: string) => void;
  readonly setRetireRemoteId: (id: string) => void;
  readonly refresh: () => Promise<void>;
  readonly announce: (message: string) => void;
}): React.ReactElement {
  const expectedVaultId = view.state.selectedVaultId;
  if (expectedVaultId === undefined)
    return <Status message="Hosted Replicas require a selected Vault." kind="error" />;
  return (
    <section className="grid gap-4 rounded-control border-2 border-awsm-ink bg-awsm-paper p-6">
      <div className="grid gap-2">
        <h2 className="font-display text-2xl font-bold leading-tight">Hosted Replicas</h2>
        <p className="max-w-[65ch] text-base leading-relaxed text-awsm-text-muted">
          A Hosted Replica is an optional opaque storage channel. Connecting one creates an empty
          Host-side Replica; it does not send this Vault’s data yet.
        </p>
        <p className="max-w-[65ch] text-base leading-relaxed text-awsm-text-muted">
          Store compact Vault state explicitly when you want this Host to retain encrypted Records,
          Objects, and Key Envelopes. Large Capture artifacts remain on demand.
        </p>
      </div>
      {view.remotes.length === 0 ? (
        <p className="text-base leading-relaxed text-awsm-text-muted">
          No Hosted Replicas are configured on this Client.
        </p>
      ) : (
        <ul className="grid gap-3">
          {view.remotes.map((remote) => (
            <li
              key={remote.remoteId}
              className="grid gap-2 border-t border-awsm-border-subtle pt-3"
            >
              <strong>{remote.name}</strong>
              <span className="break-all text-sm text-awsm-text-muted">{remote.endpoint}</span>
              <span className="text-sm font-semibold text-awsm-text-muted">
                {remote.enabled ? "Available" : "Paused locally"}
              </span>
              <ActionBar>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setRenameRemoteId(remote.remoteId);
                    setScreen("HostedReplicaRename");
                  }}
                >
                  Rename Hosted Replica
                </Button>
                {remote.enabled ? (
                  <Button
                    variant="secondary"
                    busy={busy}
                    onClick={() =>
                      void run(async () => {
                        await requestHostedReplicaPermission(remote.endpoint);
                        await client.materializeHostedReplica({
                          expectedVaultId,
                          remoteId: remote.remoteId,
                        });
                        announce(
                          "Compact Vault state stored. Large Capture artifacts remain on demand.",
                        );
                        await refresh();
                      })
                    }
                  >
                    Store compact Vault state
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  busy={busy}
                  onClick={() =>
                    void run(async () => {
                      await client.setRemoteEnabled({
                        expectedVaultId,
                        remoteId: remote.remoteId,
                        enabled: !remote.enabled,
                      });
                      announce(
                        remote.enabled
                          ? "Hosted Replica paused locally. It will not be contacted until resumed."
                          : "Hosted Replica resumed locally.",
                      );
                      await refresh();
                    })
                  }
                >
                  {remote.enabled ? "Pause Remote" : "Resume Remote"}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setRetireRemoteId(remote.remoteId);
                    setScreen("HostedReplicaRetirement");
                  }}
                >
                  Remove Remote from this Client
                </Button>
              </ActionBar>
            </li>
          ))}
        </ul>
      )}
      <ActionBar>
        {view.remotes.some(({ enabled }) => enabled) ? (
          <Button
            variant="secondary"
            busy={busy}
            onClick={() =>
              void run(async () => {
                const enabled = view.remotes.filter(({ enabled: isEnabled }) => isEnabled);
                await requestHostedReplicaPermissions(enabled.map(({ endpoint }) => endpoint));
                const results = await client.pullHostedReplicas(expectedVaultId);
                announce(
                  `Checked ${results.length} Hosted Replica${results.length === 1 ? "" : "s"}.`,
                );
                await refresh();
              })
            }
          >
            Check Hosted Replicas
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => setScreen("HostedReplicaAttachment")}>
          Use existing Hosted Replica
        </Button>
        <Button onClick={() => setScreen("HostedReplicaSetup")}>Connect Hosted Replica</Button>
      </ActionBar>
    </section>
  );
}

function HostedReplicaSetup({
  vault,
  busy,
  run,
  onCancel,
  onConnected,
}: {
  readonly vault: CanonicalPopupView["state"]["vaults"][number];
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onCancel: () => void;
  readonly onConnected: () => Promise<void>;
}): React.ReactElement {
  const [endpoint, setEndpoint] = React.useState("");
  const [name, setName] = React.useState(`${displayVaultLabel(vault.label)} hosted`);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  return (
    <>
      <Notice tone="warning">
        Sign in to a Replica Host. Your password is used only for this sign-in and is not stored by
        AWSM.
      </Notice>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await requestHostedReplicaPermission(endpoint);
            await client.createHostedReplica({
              expectedVaultId: vault.vaultId,
              endpoint,
              name,
              username,
              password,
            });
            setPassword("");
            await onConnected();
          });
        }}
      >
        <TextField
          label="Hosted Replica address"
          type="url"
          value={endpoint}
          onChange={setEndpoint}
          placeholder="https://sync.example/"
        />
        <TextField label="Connection name" value={name} onChange={setName} maxLength={256} />
        <TextField
          label="Account username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          maxLength={256}
        />
        <TextField
          label="Account password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          maxLength={1024}
        />
        <ActionBar>
          <Button
            variant="secondary"
            type="button"
            onClick={() => {
              setPassword("");
              onCancel();
            }}
          >
            Cancel Hosted Replica setup
          </Button>
          <Button type="submit" busy={busy}>
            Connect Hosted Replica
          </Button>
        </ActionBar>
      </form>
    </>
  );
}

function HostedReplicaAttachment({
  vault,
  busy,
  run,
  onCancel,
  onSetup,
}: {
  readonly vault: CanonicalPopupView["state"]["vaults"][number];
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onCancel: () => void;
  readonly onSetup: (
    setup: Awaited<ReturnType<CanonicalPopupApplicationClient["beginHostedReplicaAttachment"]>>,
  ) => void;
}): React.ReactElement {
  const [endpoint, setEndpoint] = React.useState("");
  const [name, setName] = React.useState(`${displayVaultLabel(vault.label)} hosted`);
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  return (
    <>
      <Notice tone="warning">
        Sign in to list Hosted Replicas this Account can access. AWSM saves only the local
        connection you select.
      </Notice>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await requestHostedReplicaPermission(endpoint);
            const setup = await client.beginHostedReplicaAttachment({
              expectedVaultId: vault.vaultId,
              endpoint,
              name,
              username,
              password,
            });
            setPassword("");
            onSetup(setup);
          });
        }}
      >
        <TextField
          label="Hosted Replica address"
          type="url"
          value={endpoint}
          onChange={setEndpoint}
          placeholder="https://sync.example/"
        />
        <TextField label="Connection name" value={name} onChange={setName} maxLength={256} />
        <TextField
          label="Account username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          maxLength={256}
        />
        <TextField
          label="Account password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          maxLength={1024}
        />
        <ActionBar>
          <Button
            variant="secondary"
            type="button"
            onClick={() => {
              setPassword("");
              onCancel();
            }}
          >
            Cancel existing Hosted Replica
          </Button>
          <Button type="submit" busy={busy}>
            Show existing Hosted Replicas
          </Button>
        </ActionBar>
      </form>
    </>
  );
}

function HostedReplicaAttachmentSelection({
  vaultId,
  setup,
  busy,
  run,
  onCancel,
  onConfirmed,
}: {
  readonly vaultId: string;
  readonly setup: Awaited<
    ReturnType<CanonicalPopupApplicationClient["beginHostedReplicaAttachment"]>
  >;
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onCancel: () => Promise<void>;
  readonly onConfirmed: () => Promise<void>;
}): React.ReactElement {
  return (
    <>
      <Notice tone="warning">
        The Host cannot tell which Vault each opaque Hosted Replica contains. Choose a connection,
        then check it. AWSM validates any received Vault data locally.
      </Notice>
      <div className="grid gap-3">
        {setup.replicas.map((replica) => (
          <Button
            key={replica.replicaHandle}
            variant="secondary"
            busy={busy}
            onClick={() =>
              void run(async () => {
                await client.confirmHostedReplicaAttachment({
                  expectedVaultId: vaultId,
                  setupId: setup.setupId,
                  replicaHandle: replica.replicaHandle,
                });
                await onConfirmed();
              })
            }
          >
            Use Hosted Replica …{replica.replicaHandle.slice(-8)}.{" "}
            {replica.storedBytes.toLocaleString()} bytes stored.
          </Button>
        ))}
      </div>
      <Button variant="quiet" onClick={() => void run(onCancel)}>
        Cancel Hosted Replica selection
      </Button>
    </>
  );
}

function HostedReplicaRename({
  view,
  remoteId,
  busy,
  run,
  onCancel,
  onSaved,
}: {
  readonly view: CanonicalPopupView;
  readonly remoteId: string;
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onCancel: () => void;
  readonly onSaved: () => Promise<void>;
}): React.ReactElement {
  const remote = view.remotes.find(({ remoteId: candidate }) => candidate === remoteId);
  const expectedVaultId = view.state.selectedVaultId;
  const [name, setName] = React.useState(remote?.name ?? "");
  if (remote === undefined || expectedVaultId === undefined)
    return <Status message="Hosted Replica is no longer configured on this Client." kind="error" />;
  return (
    <>
      <p className="text-base leading-relaxed text-awsm-text-muted">
        This changes this Client’s local connection name only. It does not contact the Replica Host.
      </p>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await client.renameRemote({ expectedVaultId, remoteId, name });
            await onSaved();
          });
        }}
      >
        <TextField label="Connection name" value={name} onChange={setName} maxLength={256} />
        <ActionBar>
          <Button variant="secondary" type="button" onClick={onCancel}>
            Cancel Remote rename
          </Button>
          <Button type="submit" busy={busy}>
            Save Remote name
          </Button>
        </ActionBar>
      </form>
    </>
  );
}

function HostedReplicaRetirement({
  view,
  remoteId,
  busy,
  run,
  onCancel,
  onRemoved,
}: {
  readonly view: CanonicalPopupView;
  readonly remoteId: string;
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onCancel: () => void;
  readonly onRemoved: () => Promise<void>;
}): React.ReactElement {
  const expectedVaultId = view.state.selectedVaultId;
  if (expectedVaultId === undefined)
    return <Status message="Hosted Replica removal requires a selected Vault." kind="error" />;
  return (
    <>
      <Notice tone="warning">
        This only removes this Client’s local connection. It does not contact the Replica Host or
        delete its stored bytes.
      </Notice>
      <p className="text-base leading-relaxed text-awsm-text-muted">
        AWSM removes this Remote’s local channel credential, materialization retry state, pull
        checkpoints, and untrusted downloaded data. Any channel operation already underway finishes
        before removal.
      </p>
      <ActionBar>
        <Button variant="secondary" onClick={onCancel}>
          Cancel Remote removal
        </Button>
        <Button
          variant="danger"
          busy={busy}
          onClick={() =>
            void run(async () => {
              await client.retireRemote({ expectedVaultId, remoteId });
              await onRemoved();
            })
          }
        >
          Remove local Remote
        </Button>
      </ActionBar>
    </>
  );
}

function PhraseReplacement({
  setup,
  busy,
  run,
  onCancel,
  onConfirmed,
}: {
  readonly setup: Awaited<
    ReturnType<CanonicalPopupApplicationClient["beginRecoveryPhraseReplacement"]>
  >;
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onCancel: () => Promise<void>;
  readonly onConfirmed: () => Promise<void>;
}): React.ReactElement {
  const [confirmation, setConfirmation] = React.useState("");
  return (
    <>
      <Notice tone="warning">
        Write the new Recovery Phrase down somewhere safe. It replaces the current phrase after
        confirmation.
      </Notice>
      <TextAreaField label="New Recovery Phrase" value={setup.recoveryPhrase} readOnly />
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await client.confirmRecoveryPhraseReplacement({
              setupId: setup.setupId,
              recoveryPhrase: confirmation,
            });
            await onConfirmed();
          });
        }}
      >
        <TextField
          label="Type the new Recovery Phrase to continue"
          value={confirmation}
          onChange={setConfirmation}
        />
        <ActionBar>
          <Button variant="secondary" type="button" onClick={() => void run(onCancel)}>
            Cancel Recovery Phrase replacement
          </Button>
          <Button type="submit" busy={busy}>
            Confirm new Recovery Phrase
          </Button>
        </ActionBar>
      </form>
    </>
  );
}

function ForkSurface({
  setup,
  busy,
  run,
  onCancel,
  onConfirmed,
}: {
  readonly setup: Awaited<ReturnType<CanonicalPopupApplicationClient["beginVaultFork"]>>;
  readonly busy: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
  readonly onCancel: () => Promise<void>;
  readonly onConfirmed: () => Promise<void>;
}): React.ReactElement {
  const [confirmation, setConfirmation] = React.useState("");
  return (
    <>
      <Notice tone="warning">
        Fork creates a new Vault from the current state. It leaves this Vault and its history
        unchanged.
      </Notice>
      <TextAreaField label="Recovery Phrase" value={setup.recoveryPhrase} readOnly />
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await client.confirmVaultFork({ setupId: setup.setupId, recoveryPhrase: confirmation });
            await onConfirmed();
          });
        }}
      >
        <TextField
          label="Type the Recovery Phrase to create the Fork"
          value={confirmation}
          onChange={setConfirmation}
        />
        <ActionBar>
          <Button variant="secondary" type="button" onClick={() => void run(onCancel)}>
            Cancel Vault fork
          </Button>
          <Button type="submit" busy={busy}>
            Confirm Vault fork
          </Button>
        </ActionBar>
      </form>
    </>
  );
}

function ConfirmationSurface({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly danger?: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.ReactElement {
  return (
    <>
      <p className="sr-only">{title}</p>
      <Notice tone="warning">{message}</Notice>
      <ActionBar>
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={danger ? "danger" : "primary"} busy={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </ActionBar>
    </>
  );
}

createRoot(document.querySelector<HTMLElement>("#app") ?? document.body).render(
  <AppearanceProvider>
    <PopupApp />
  </AppearanceProvider>,
);
