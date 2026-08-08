import {
  AppearanceControl,
  AppearanceProvider,
  AppShell,
  Button,
  EmptyState,
  inputClassName,
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

function LibraryContentPanel({
  vaultId,
  collections,
  folders,
  tags,
  notes,
  busy,
  onMutated,
  onError,
}: {
  readonly vaultId: string;
  readonly collections: Awaited<ReturnType<CanonicalPopupApplicationClient["listCollections"]>>;
  readonly folders: Awaited<ReturnType<CanonicalPopupApplicationClient["listFolders"]>>;
  readonly tags: Awaited<ReturnType<CanonicalPopupApplicationClient["listTags"]>>;
  readonly notes: Awaited<ReturnType<CanonicalPopupApplicationClient["listNotes"]>>;
  readonly busy: boolean;
  readonly onMutated: (message: string) => Promise<void>;
  readonly onError: (reason: unknown) => void;
}): React.ReactElement {
  const [folderName, setFolderName] = React.useState("");
  const [tagName, setTagName] = React.useState("");
  const [collectionId, setCollectionId] = React.useState(collections[0]?.collectionId ?? "");
  const [collectionTitle, setCollectionTitle] = React.useState("");
  const [noteTargetKind, setNoteTargetKind] = React.useState<"Collection" | "Capture">(
    "Collection",
  );
  const [noteTargetId, setNoteTargetId] = React.useState(collections[0]?.collectionId ?? "");
  const [noteTitle, setNoteTitle] = React.useState("");
  const [noteBody, setNoteBody] = React.useState("");
  const [action, setAction] = React.useState<string>();

  React.useEffect(() => {
    if (collectionId === "" && collections[0] !== undefined)
      setCollectionId(collections[0].collectionId);
    if (noteTargetId === "" && collections[0] !== undefined)
      setNoteTargetId(collections[0].collectionId);
  }, [collectionId, collections, noteTargetId]);

  const run = async (name: string, operation: () => Promise<unknown>) => {
    setAction(name);
    try {
      await operation();
      await onMutated(`${name} completed`);
    } catch (reason) {
      onError(reason);
    } finally {
      setAction(undefined);
    }
  };

  const submitFolder = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await run("Folder creation", async () => {
      await client.createFolder({
        expectedVaultId: vaultId,
        name: folderName.trim(),
        parentFolderId: null,
      });
      setFolderName("");
    });
  };
  const submitTag = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await run("Tag creation", async () => {
      await client.createTag({ expectedVaultId: vaultId, name: tagName.trim() });
      setTagName("");
    });
  };
  const submitCollectionTitle = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await run("Collection title", () =>
      client.setCollectionTitle({
        expectedVaultId: vaultId,
        collectionId,
        title: collectionTitle.trim() === "" ? null : collectionTitle.trim(),
      }),
    );
  };
  const submitNote = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await run("Note creation", async () => {
      await client.createNote({
        expectedVaultId: vaultId,
        targetKind: noteTargetKind,
        targetId: noteTargetId,
        title: noteTitle.trim() === "" ? null : noteTitle.trim(),
        body: noteBody,
      });
      setNoteTitle("");
      setNoteBody("");
    });
  };

  return (
    <section
      className="grid gap-4 border-t-2 border-awsm-border-subtle pt-6"
      aria-labelledby="library-content-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="library-content-heading"
          className="font-display text-2xl font-bold leading-tight text-awsm-ink"
        >
          Vault content
        </h2>
        <span className="text-sm text-awsm-text-muted">
          {collections.length} Collections · {folders.length} Folders · {tags.length} Tags ·{" "}
          {notes.length} Notes
        </span>
      </div>
      <p className="text-sm leading-relaxed text-awsm-text-muted">
        Content is authenticated into the selected Vault and projected live from its Event history.
        Capture remains available only from the extension popup.
      </p>
      <div className="grid gap-3 text-sm text-awsm-text-muted md:grid-cols-3">
        <div>
          <h3 className="font-semibold text-awsm-ink">Folders</h3>
          {folders.length === 0 ? (
            <p>None yet.</p>
          ) : (
            <ul aria-label="Folders">
              {folders.map((folder) => (
                <li key={folder.folderId}>{folder.name}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="font-semibold text-awsm-ink">Tags</h3>
          {tags.length === 0 ? (
            <p>None yet.</p>
          ) : (
            <ul aria-label="Tags">
              {tags.map((tag) => (
                <li key={tag.tagId}>{tag.name}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="font-semibold text-awsm-ink">Notes</h3>
          {notes.length === 0 ? (
            <p>None yet.</p>
          ) : (
            <ul aria-label="Notes">
              {notes.map((note) => (
                <li key={note.noteId}>{note.versions[0]?.title ?? "Untitled note"}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <form
          className="grid gap-2 rounded border-2 border-awsm-border-subtle p-4"
          onSubmit={(event) => void submitFolder(event)}
        >
          <h3 className="font-display text-lg font-bold text-awsm-ink">Create Folder</h3>
          <label
            className="grid gap-1 text-sm font-semibold text-awsm-ink"
            htmlFor="library-folder-name"
          >
            Folder name
            <input
              id="library-folder-name"
              className={inputClassName}
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              required
            />
          </label>
          <Button type="submit" busy={action === "Folder creation" || busy}>
            Create Folder
          </Button>
        </form>
        <form
          className="grid gap-2 rounded border-2 border-awsm-border-subtle p-4"
          onSubmit={(event) => void submitTag(event)}
        >
          <h3 className="font-display text-lg font-bold text-awsm-ink">Create Tag</h3>
          <label
            className="grid gap-1 text-sm font-semibold text-awsm-ink"
            htmlFor="library-tag-name"
          >
            Tag name
            <input
              id="library-tag-name"
              className={inputClassName}
              value={tagName}
              onChange={(event) => setTagName(event.target.value)}
              required
            />
          </label>
          <Button type="submit" busy={action === "Tag creation" || busy}>
            Create Tag
          </Button>
        </form>
        <form
          className="grid gap-2 rounded border-2 border-awsm-border-subtle p-4"
          onSubmit={(event) => void submitCollectionTitle(event)}
        >
          <h3 className="font-display text-lg font-bold text-awsm-ink">Set Collection title</h3>
          <label
            className="grid gap-1 text-sm font-semibold text-awsm-ink"
            htmlFor="library-collection-id"
          >
            Collection
            <select
              id="library-collection-id"
              className={inputClassName}
              value={collectionId}
              onChange={(event) => setCollectionId(event.target.value)}
              required
            >
              {collections.map((collection) => (
                <option key={collection.collectionId} value={collection.collectionId}>
                  {collection.title}
                </option>
              ))}
            </select>
          </label>
          <label
            className="grid gap-1 text-sm font-semibold text-awsm-ink"
            htmlFor="library-collection-title"
          >
            New title
            <input
              id="library-collection-title"
              className={inputClassName}
              value={collectionTitle}
              onChange={(event) => setCollectionTitle(event.target.value)}
            />
          </label>
          <Button
            type="submit"
            busy={action === "Collection title" || busy}
            disabled={collectionId === ""}
          >
            Save title
          </Button>
        </form>
        <form
          className="grid gap-2 rounded border-2 border-awsm-border-subtle p-4"
          onSubmit={(event) => void submitNote(event)}
        >
          <h3 className="font-display text-lg font-bold text-awsm-ink">Create Note</h3>
          <label
            className="grid gap-1 text-sm font-semibold text-awsm-ink"
            htmlFor="library-note-target-kind"
          >
            Target kind
            <select
              id="library-note-target-kind"
              className={inputClassName}
              value={noteTargetKind}
              onChange={(event) => {
                const kind = event.target.value as "Collection" | "Capture";
                setNoteTargetKind(kind);
                setNoteTargetId(kind === "Collection" ? (collections[0]?.collectionId ?? "") : "");
              }}
            >
              <option value="Collection">Collection</option>
              <option value="Capture">Capture</option>
            </select>
          </label>
          <label
            className="grid gap-1 text-sm font-semibold text-awsm-ink"
            htmlFor="library-note-target-id"
          >
            Target
            <input
              id="library-note-target-id"
              className={inputClassName}
              value={noteTargetId}
              onChange={(event) => setNoteTargetId(event.target.value)}
              required
            />
          </label>
          <label
            className="grid gap-1 text-sm font-semibold text-awsm-ink"
            htmlFor="library-note-title"
          >
            Note title
            <input
              id="library-note-title"
              className={inputClassName}
              value={noteTitle}
              onChange={(event) => setNoteTitle(event.target.value)}
            />
          </label>
          <label
            className="grid gap-1 text-sm font-semibold text-awsm-ink"
            htmlFor="library-note-body"
          >
            Note body
            <textarea
              id="library-note-body"
              className={inputClassName}
              value={noteBody}
              onChange={(event) => setNoteBody(event.target.value)}
              required
            />
          </label>
          <Button type="submit" busy={action === "Note creation" || busy}>
            Create Note
          </Button>
        </form>
      </div>
    </section>
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
  const [collections, setCollections] = React.useState<
    Awaited<ReturnType<CanonicalPopupApplicationClient["listCollections"]>>
  >([]);
  const [folders, setFolders] = React.useState<
    Awaited<ReturnType<CanonicalPopupApplicationClient["listFolders"]>>
  >([]);
  const [tags, setTags] = React.useState<
    Awaited<ReturnType<CanonicalPopupApplicationClient["listTags"]>>
  >([]);
  const [notes, setNotes] = React.useState<
    Awaited<ReturnType<CanonicalPopupApplicationClient["listNotes"]>>
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
      const nextCollections =
        selectedVaultId === undefined ? [] : await client.listCollections(selectedVaultId);
      const nextFolders =
        selectedVaultId === undefined ? [] : await client.listFolders(selectedVaultId);
      const nextTags = selectedVaultId === undefined ? [] : await client.listTags(selectedVaultId);
      const nextNotes =
        selectedVaultId === undefined ? [] : await client.listNotes(selectedVaultId);
      if (current !== generation.current) return;
      setState(nextState);
      setItems(nextItems);
      setRemotes(nextRemotes);
      setCollections(nextCollections);
      setFolders(nextFolders);
      setTags(nextTags);
      setNotes(nextNotes);
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

  const contentMutated = async (message: string) => {
    setAnnounce(message);
    await reconcile();
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
          {vault !== undefined ? (
            <LibraryContentPanel
              vaultId={vault.vaultId}
              collections={collections}
              folders={folders}
              tags={tags}
              notes={notes}
              busy={loading}
              onMutated={contentMutated}
              onError={(reason) => setError(errorMessage(reason))}
            />
          ) : null}
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
