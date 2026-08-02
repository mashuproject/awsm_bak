import { browser } from "wxt/browser";

import {
  CanonicalApplicationClientError,
  sendCanonicalApplicationRequest,
  subscribeCanonicalApplicationState,
} from "../../src/app/canonical-application-client";
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

async function reconcile(generation: number): Promise<void> {
  try {
    const state = await client.state();
    const selectedVaultId = state.selectedVaultId;
    const items = selectedVaultId === undefined ? [] : await client.listLibrary(selectedVaultId);
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
