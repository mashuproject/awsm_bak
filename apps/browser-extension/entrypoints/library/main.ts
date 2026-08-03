import { browser } from "wxt/browser";

import {
  CanonicalApplicationClientError,
  sendCanonicalApplicationRequest,
  subscribeCanonicalApplicationState,
} from "../../src/app/canonical-application-client";
import { requestHostedReplicaPermissions } from "../../src/ui/canonical-hosted-replica-permission";
import {
  type CanonicalPopupApplicationClient,
  createCanonicalPopupApplicationClient,
} from "../../src/ui/canonical-popup-application-client";
import "./canonical-style.css";

function requiredElement(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector);
  if (node === null) throw new Error("Canonical Library shell is incomplete.");
  return node;
}

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
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

const app = requiredElement("#app");
const announcer = requiredElement("#announcer");
const client: CanonicalPopupApplicationClient = createCanonicalPopupApplicationClient({
  request: sendCanonicalApplicationRequest,
  subscribe: subscribeCanonicalApplicationState,
});
let reconciliationQueued = false;
let reconciliationRunning = false;
let reconciliationGeneration = 0;
let transientError: { readonly vaultId: string; readonly message: string } | undefined;

function heading(): DocumentFragment {
  const content = document.createDocumentFragment();
  const brand = element("div", undefined, "canonical-library__brand");
  const mark = element("img") as HTMLImageElement;
  mark.src = browser.runtime.getURL("/icon-48.png");
  mark.alt = "";
  mark.setAttribute("aria-hidden", "true");
  brand.append(mark, element("p", "AWSM", "canonical-library__eyebrow"));
  content.append(brand, element("h1", "Library"));
  return content;
}

function renderError(error: unknown): void {
  app.replaceChildren(
    heading(),
    element("p", errorMessage(error), "canonical-library__status canonical-library__status--error"),
  );
  app.setAttribute("aria-busy", "false");
}

function retrieveCapture(
  button: HTMLButtonElement,
  input: {
    readonly vaultId: string;
    readonly artifactId: string;
    readonly enabledEndpoints: readonly string[];
  },
): void {
  button.disabled = true;
  app.setAttribute("aria-busy", "true");
  void (async () => {
    try {
      transientError = undefined;
      await requestHostedReplicaPermissions(input.enabledEndpoints, {
        deniedMessage: "Allow access to this Replica Host before retrieving the Capture.",
      });
      const hydrated = await client.hydrateArtifact({
        expectedVaultId: input.vaultId,
        artifactId: input.artifactId,
      });
      announcer.textContent =
        hydrated.remoteId === "local" ? "Capture is available locally." : "Capture retrieved.";
    } catch (error) {
      const message =
        error instanceof CanonicalApplicationClientError
          ? error.message
          : "The Capture could not be retrieved.";
      transientError = { vaultId: input.vaultId, message };
      announcer.textContent = message;
    } finally {
      requestReconciliation();
      button.disabled = false;
    }
  })();
}

async function reconcile(generation: number): Promise<void> {
  try {
    const state = await client.state();
    const selectedVaultId = state.selectedVaultId;
    const [items, remotes] =
      selectedVaultId === undefined
        ? [[], []]
        : await Promise.all([
            client.listLibrary(selectedVaultId),
            client.listRemotes(selectedVaultId),
          ]);
    if (generation !== reconciliationGeneration) return;

    const content = heading();
    if (selectedVaultId === undefined) {
      content.append(
        element(
          "p",
          "Select a Vault in the popup to view its Library.",
          "canonical-library__status",
        ),
      );
    } else {
      const vault = state.vaults.find(({ vaultId }) => vaultId === selectedVaultId);
      if (vault === undefined) throw new Error("The selected Vault is unavailable.");
      content.append(
        element("p", `Vault · ${displayVaultLabel(vault.label)}`, "canonical-library__context"),
      );
      if (transientError?.vaultId === selectedVaultId) {
        const failure = element(
          "p",
          transientError.message,
          "canonical-library__status canonical-library__status--error",
        );
        failure.setAttribute("role", "alert");
        content.append(failure);
      }
      const activeItems = items.filter(({ lifecycle }) => lifecycle === "Active");
      const deletedItems = items.filter(({ lifecycle }) => lifecycle === "Deleted");
      const section = element("section", undefined, "canonical-library__section");
      section.setAttribute("aria-labelledby", "active-captures-heading");
      section.append(element("h2", "Captures"));
      if (activeItems.length === 0) {
        section.append(
          element("p", "Capture a page from the popup to add it here.", "canonical-library__empty"),
        );
      } else {
        const list = element("ul", undefined, "canonical-library__captures");
        for (const item of activeItems) {
          const capture = element("li");
          capture.append(
            element("strong", displayCaptureTitle(item.title, item.finalUrl)),
            element("span", new URL(item.finalUrl).host),
            element(
              "span",
              item.availableLocally ? "Available locally" : "Not available locally",
              "canonical-library__availability",
            ),
          );
          if (!item.availableLocally) {
            capture.append(
              element(
                "p",
                "Retrieve this Capture from a configured Replica Host.",
                "canonical-library__retrieval-note",
              ),
            );
            const retrieve = element(
              "button",
              "Retrieve Capture",
              "canonical-library__retrieve",
            ) as HTMLButtonElement;
            retrieve.type = "button";
            retrieve.addEventListener("click", () => {
              retrieveCapture(retrieve, {
                vaultId: selectedVaultId,
                artifactId: item.artifactId,
                enabledEndpoints: remotes
                  .filter((remote) => remote.enabled)
                  .map((remote) => remote.endpoint),
              });
            });
            capture.append(retrieve);
          }
          list.append(capture);
        }
        section.append(list);
      }
      content.append(section);
      if (deletedItems.length > 0) {
        const deleted = element(
          "p",
          `${deletedItems.length} deleted capture${deletedItems.length === 1 ? "" : "s"}.`,
          "canonical-library__muted",
        );
        content.append(deleted);
      }
    }
    app.replaceChildren(content);
    app.setAttribute("aria-busy", "false");
  } catch (error) {
    if (generation === reconciliationGeneration) renderError(error);
  }
}

function requestReconciliation(): void {
  reconciliationGeneration += 1;
  reconciliationQueued = true;
  if (reconciliationRunning) return;
  reconciliationRunning = true;
  void (async () => {
    while (reconciliationQueued) {
      reconciliationQueued = false;
      await reconcile(reconciliationGeneration);
    }
  })().finally(() => {
    reconciliationRunning = false;
    if (reconciliationQueued) requestReconciliation();
  });
}

const unsubscribe = client.subscribe(() => {
  announcer.textContent = "Library updated";
  requestReconciliation();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") requestReconciliation();
});
window.addEventListener("focus", requestReconciliation);
window.addEventListener("pagehide", unsubscribe, { once: true });
requestReconciliation();
