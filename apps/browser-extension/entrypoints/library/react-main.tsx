import {
  AppearanceControl,
  AppearanceProvider,
  AppShell,
  Button,
  EmptyState,
  Notice,
  SidebarNav,
} from "@awsm/ui";
import { BookOpen, Settings } from "lucide-react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";

import {
  CanonicalApplicationClientError,
  sendCanonicalApplicationRequest,
  subscribeCanonicalApplicationState,
} from "../../src/app/canonical-application-client";
import { DesktopRuntimeApplicationRouter } from "../../src/hosts/desktop/runtime-application-router";
import { getDesktopRuntimeConnection } from "../../src/hosts/desktop/runtime-connection-factory";
import { requestHostedReplicaPermissions } from "../../src/ui/canonical-hosted-replica-permission";
import {
  type CanonicalPopupApplicationClient,
  createCanonicalPopupApplicationClient,
} from "../../src/ui/canonical-popup-application-client";
import "@awsm/ui/styles.css";

const applicationRouter = new DesktopRuntimeApplicationRouter({
  request: sendCanonicalApplicationRequest,
  subscribe: subscribeCanonicalApplicationState,
});
const client: CanonicalPopupApplicationClient =
  createCanonicalPopupApplicationClient(applicationRouter);

async function restoreDesktopRuntime(): Promise<void> {
  try {
    const connection = await getDesktopRuntimeConnection();
    await connection.restore();
    applicationRouter.setDesktopConnection(connection);
  } catch {
    // The browser-local Library remains available when the optional desktop
    // connection or its installation state cannot be restored.
  }
}

function displayVaultLabel(label: string | null): string {
  return label === null || label.length === 0 ? "Untitled Vault" : label;
}

function displayCaptureTitle(title: string | null, url: string): string {
  return title === null || title.length === 0 ? new URL(url).hostname : title;
}

function errorMessage(error: unknown): string {
  if (error instanceof CanonicalApplicationClientError) return error.message;
  return "The local archive could not load this Library.";
}

function LibrarySidebar({ vaultLabel }: { readonly vaultLabel?: string }): React.ReactElement {
  return (
    <div className="grid gap-8">
      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          <img
            src={browser.runtime.getURL("/icon-48.png")}
            alt=""
            aria-hidden="true"
            className="h-8 w-8 object-contain"
          />
          <span className="font-display text-2xl font-extrabold tracking-tight">AWSM</span>
        </div>
        <span className="text-sm text-awsm-text-muted">{vaultLabel ?? "Local archive"}</span>
      </div>
      <SidebarNav
        items={[
          { id: "library", label: "Library", icon: <BookOpen />, active: true },
          { id: "settings", label: "Settings", icon: <Settings /> },
        ]}
      />
      <AppearanceControl />
    </div>
  );
}

function LibraryApp(): React.ReactElement {
  const [state, setState] =
    React.useState<Awaited<ReturnType<CanonicalPopupApplicationClient["state"]>>>();
  const [items, setItems] = React.useState<
    Awaited<ReturnType<CanonicalPopupApplicationClient["listLibrary"]>>
  >([]);
  const [remotes, setRemotes] = React.useState<
    Awaited<ReturnType<CanonicalPopupApplicationClient["listRemotes"]>>
  >([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [retrieving, setRetrieving] = React.useState<string>();
  const [announce, setAnnounce] = React.useState("");
  const generation = React.useRef(0);

  const reconcile = React.useCallback(async () => {
    const current = generation.current + 1;
    generation.current = current;
    try {
      const nextState = await client.state();
      if (current !== generation.current) return;
      const selectedVaultId = nextState.selectedVaultId;
      const [nextItems, nextRemotes] =
        selectedVaultId === undefined
          ? [[], []]
          : await Promise.all([
              client.listLibrary(selectedVaultId),
              client.listRemotes(selectedVaultId),
            ]);
      if (current !== generation.current) return;
      setState(nextState);
      setItems(nextItems);
      setRemotes(nextRemotes);
      setError(undefined);
    } catch (reason) {
      if (current === generation.current) setError(errorMessage(reason));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    let active = true;
    const invalidate = () => {
      if (active) {
        setAnnounce("Library updated");
        void reconcile();
      }
    };
    const unsubscribe = client.subscribe(invalidate);
    void reconcile();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void reconcile();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", invalidate);
    return () => {
      active = false;
      unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", invalidate);
    };
  }, [reconcile]);

  const retrieve = async (vaultId: string, artifactId: string) => {
    setRetrieving(artifactId);
    try {
      await requestHostedReplicaPermissions(
        remotes.filter(({ enabled }) => enabled).map(({ endpoint }) => endpoint),
        { deniedMessage: "Allow access to this Replica Host before retrieving the Capture." },
      );
      const hydrated = await client.hydrateArtifact({ expectedVaultId: vaultId, artifactId });
      setAnnounce(
        hydrated.remoteId === "local" ? "Capture is available locally." : "Capture retrieved.",
      );
      await reconcile();
    } catch (reason) {
      setError(
        reason instanceof CanonicalApplicationClientError
          ? reason.message
          : "The Capture could not be retrieved.",
      );
    } finally {
      setRetrieving(undefined);
    }
  };

  const vault =
    state?.selectedVaultId === undefined
      ? undefined
      : state.vaults.find(({ vaultId }) => vaultId === state.selectedVaultId);
  const activeItems = items.filter(({ lifecycle }) => lifecycle === "Active");
  const deletedItems = items.filter(({ lifecycle }) => lifecycle === "Deleted");
  return (
    <AppearanceProvider>
      <AppShell
        sidebar={
          <LibrarySidebar
            vaultLabel={vault === undefined ? undefined : displayVaultLabel(vault.label)}
          />
        }
      >
        <div className="grid gap-8" aria-busy={loading}>
          <header className="grid gap-3 border-b-2 border-awsm-border-subtle pb-6">
            <div className="flex items-center gap-3">
              <BookOpen aria-hidden="true" className="text-awsm-link" />
              <div>
                <p className="text-xs font-extrabold uppercase tracking-[0.08em] text-awsm-text-muted">
                  AWSM Library
                </p>
                <h1 className="font-display text-4xl font-bold leading-tight tracking-[-0.025em] text-awsm-ink">
                  Library
                </h1>
              </div>
            </div>
            {vault !== undefined ? (
              <p className="text-base font-semibold text-awsm-text-muted">
                Vault · {displayVaultLabel(vault.label)}
              </p>
            ) : null}
          </header>
          {announce !== "" ? (
            <p className="awsm-sr-only" aria-live="polite">
              {announce}
            </p>
          ) : null}
          {error !== undefined ? (
            <Notice tone="danger" className="canonical-library__status--error">
              {error}
            </Notice>
          ) : null}
          {loading && state === undefined ? <Notice>Loading the local Library…</Notice> : null}
          {state?.selectedVaultId === undefined ? (
            <EmptyState title="Choose a Vault">
              Select a Vault in the popup to view its Library.
            </EmptyState>
          ) : vault === undefined ? (
            <Notice tone="danger">The selected Vault is unavailable.</Notice>
          ) : (
            <section className="grid gap-4" aria-labelledby="active-captures-heading">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2
                  id="active-captures-heading"
                  className="font-display text-2xl font-bold leading-tight text-awsm-ink"
                >
                  Captures
                </h2>
                <span className="text-sm text-awsm-text-muted">{activeItems.length} active</span>
              </div>
              {activeItems.length === 0 ? (
                <EmptyState title="Nothing captured yet">
                  Capture a page from the popup to add it here.
                </EmptyState>
              ) : (
                <ul className="grid gap-3">
                  {activeItems.map((item) => (
                    <li
                      key={item.bundleId}
                      className="grid gap-2 border-t-2 border-awsm-border-subtle py-4"
                    >
                      <strong className="break-words text-base text-awsm-ink">
                        {displayCaptureTitle(item.title, item.finalUrl)}
                      </strong>
                      <span className="break-all text-sm text-awsm-text-muted">
                        {new URL(item.finalUrl).host}
                      </span>
                      <span className="text-sm font-semibold text-awsm-ink">
                        {item.availableLocally ? "Available locally" : "Not available locally"}
                      </span>
                      {!item.availableLocally ? (
                        <>
                          <p className="text-sm leading-relaxed text-awsm-text-muted">
                            Retrieve this Capture from a configured Replica Host.
                          </p>
                          <Button
                            variant="secondary"
                            busy={retrieving === item.artifactId}
                            onClick={() => void retrieve(vault.vaultId, item.artifactId)}
                          >
                            Retrieve Capture
                          </Button>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {deletedItems.length > 0 ? (
                <p className="text-sm text-awsm-text-muted">
                  {deletedItems.length} deleted capture{deletedItems.length === 1 ? "" : "s"}.
                </p>
              ) : null}
            </section>
          )}
        </div>
      </AppShell>
    </AppearanceProvider>
  );
}

async function bootstrap(): Promise<void> {
  await restoreDesktopRuntime();
  createRoot(document.querySelector<HTMLElement>("#app") ?? document.body).render(<LibraryApp />);
}

void bootstrap();
