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
import {
  CanonicalPopupController,
  type CanonicalPopupView,
} from "../../src/ui/canonical-popup-controller";
import {
  type CanonicalPopupRecoveryConfirmation,
  canonicalPopupPresentation,
} from "../../src/ui/canonical-popup-presentation";
import "./canonical-style.css";

function requiredElement(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector);
  if (node === null) throw new Error("Canonical popup shell is incomplete.");
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

function errorMessage(error: unknown): string {
  if (error instanceof CanonicalApplicationClientError) return error.message;
  return "The local archive could not complete that action.";
}

function displayVaultLabel(label: string | null): string {
  return label === null || label.length === 0 ? "Untitled Vault" : label;
}

function displayCaptureTitle(title: string | null, url: string): string {
  return title === null || title.length === 0 ? new URL(url).hostname : title;
}

const app = requiredElement("#app");
const announcer = requiredElement("#announcer");
const client: CanonicalPopupApplicationClient = createCanonicalPopupApplicationClient({
  request: sendCanonicalApplicationRequest,
  subscribe: subscribeCanonicalApplicationState,
});
let pendingRecoveryConfirmation: CanonicalPopupRecoveryConfirmation | undefined;
let renderedView: CanonicalPopupView | undefined;
let transientError: string | undefined;
let capturePending = false;

const controller = new CanonicalPopupController(client, (view) => {
  renderedView = view;
  render(view);
});

function showError(error: unknown): void {
  transientError = errorMessage(error);
  if (renderedView !== undefined) render(renderedView);
  announcer.textContent = transientError;
}

function action(button: HTMLButtonElement, operation: () => Promise<void>): void {
  button.disabled = true;
  void operation()
    .catch(showError)
    .finally(() => {
      button.disabled = false;
    });
}

function heading(subtitle: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const brand = element("div", undefined, "canonical-popup__brand");
  const mark = element("img") as HTMLImageElement;
  mark.src = browser.runtime.getURL("/icon-48.png");
  mark.alt = "";
  mark.setAttribute("aria-hidden", "true");
  brand.append(mark, element("p", "AWSM", "canonical-popup__eyebrow"));
  fragment.append(brand, element("h1", subtitle));
  return fragment;
}

function status(message: string, kind: "info" | "success" | "error" = "info"): HTMLElement {
  const node = element("p", message, `canonical-popup__status canonical-popup__status--${kind}`);
  node.setAttribute("role", kind === "error" ? "alert" : "status");
  return node;
}

function renderCreateVault(view: CanonicalPopupView, content: DocumentFragment): void {
  content.append(
    element(
      "p",
      "Create a Vault on this Client. It stays private to this Client unless you later connect a Replica Host.",
    ),
  );
  const form = element("form", undefined, "canonical-popup__form");
  const label = element("label", "Vault name");
  const input = element("input") as HTMLInputElement;
  input.name = "vault-name";
  input.maxLength = 256;
  input.autocomplete = "off";
  input.placeholder = "Personal archive";
  label.append(input);
  const submit = element("button", "Create Vault", "canonical-popup__primary") as HTMLButtonElement;
  submit.type = "submit";
  form.append(label, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    action(submit, async () => {
      transientError = undefined;
      pendingRecoveryConfirmation = await client.beginVaultCreation({
        expectedVaultId: view.state.selectedVaultId ?? null,
        label: input.value.trim() === "" ? null : input.value.trim(),
      });
      render(view);
    });
  });
  content.append(form);
}

function renderVaultSelection(view: CanonicalPopupView, content: DocumentFragment): void {
  content.append(element("p", "Choose the Vault you want to use on this Client."));
  const choices = element("div", undefined, "canonical-popup__choices");
  for (const vault of view.state.vaults) {
    const choose = element("button", displayVaultLabel(vault.label)) as HTMLButtonElement;
    choose.type = "button";
    choose.addEventListener("click", () => {
      action(choose, async () => {
        transientError = undefined;
        await client.selectVault({
          expectedVaultId: view.state.selectedVaultId ?? null,
          vaultId: vault.vaultId,
        });
        await controller.refresh();
      });
    });
    choices.append(choose);
  }
  content.append(choices);
}

function renderRecoveryConfirmation(content: DocumentFragment): void {
  const pending = pendingRecoveryConfirmation;
  if (pending === undefined) throw new Error("Recovery Phrase confirmation is missing its setup.");
  content.append(
    element(
      "p",
      "Write this Recovery Phrase down somewhere safe. Anyone who has it can access this Vault.",
      "canonical-popup__warning",
    ),
  );
  const phrase = element("textarea") as HTMLTextAreaElement;
  phrase.readOnly = true;
  phrase.value = pending.recoveryPhrase;
  phrase.rows = 3;
  phrase.setAttribute("aria-label", "Recovery Phrase");
  content.append(phrase);
  const form = element("form", undefined, "canonical-popup__form");
  const confirmLabel = element("label", "Type the Recovery Phrase to continue");
  const confirmation = element("input") as HTMLInputElement;
  confirmation.autocomplete = "off";
  confirmation.required = true;
  confirmLabel.append(confirmation);
  const actions = element("div", undefined, "canonical-popup__actions");
  const cancel = element("button", "Cancel") as HTMLButtonElement;
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    action(cancel, async () => {
      transientError = undefined;
      await client.cancelVaultCreation(pending.setupId);
      pendingRecoveryConfirmation = undefined;
      await controller.refresh();
    });
  });
  const submit = element(
    "button",
    "Confirm Recovery Phrase",
    "canonical-popup__primary",
  ) as HTMLButtonElement;
  submit.type = "submit";
  actions.append(cancel, submit);
  form.append(confirmLabel, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    action(submit, async () => {
      transientError = undefined;
      await client.confirmVaultCreation({
        setupId: pending.setupId,
        recoveryPhrase: confirmation.value,
      });
      pendingRecoveryConfirmation = undefined;
      announcer.textContent = "Vault created.";
      await controller.refresh();
    });
  });
  content.append(form);
}

function renderCapture(view: CanonicalPopupView, content: DocumentFragment): void {
  const presentation = canonicalPopupPresentation(view.state);
  if (presentation.kind !== "Capture") throw new Error("Popup Capture presentation is invalid.");
  content.append(
    element(
      "p",
      `Vault · ${displayVaultLabel(presentation.vault.label)}`,
      "canonical-popup__context",
    ),
  );
  const capture = element(
    "button",
    "Archive this page",
    "canonical-popup__primary",
  ) as HTMLButtonElement;
  capture.type = "button";
  capture.disabled = capturePending;
  capture.addEventListener("click", () => {
    if (capturePending) return;
    capturePending = true;
    action(capture, async () => {
      try {
        transientError = undefined;
        await client.captureActivePage({ expectedVaultId: presentation.vault.vaultId });
        capturePending = false;
        announcer.textContent = "Page archived.";
        await controller.refresh();
      } finally {
        capturePending = false;
      }
    });
  });
  content.append(capture);
  const captures = view.library.filter(({ lifecycle }) => lifecycle === "Active").slice(0, 3);
  const recent = element("section", undefined, "canonical-popup__recent");
  recent.append(element("h2", "Recent captures"));
  if (captures.length === 0) {
    recent.append(
      element("p", "No pages have been archived in this Vault yet.", "canonical-popup__muted"),
    );
  } else {
    const list = element("ul");
    for (const captureItem of captures) {
      const row = element("li");
      row.append(
        element("strong", displayCaptureTitle(captureItem.title, captureItem.finalUrl)),
        element("span", new URL(captureItem.finalUrl).hostname),
      );
      list.append(row);
    }
    recent.append(list);
  }
  content.append(recent);
}

function render(view: CanonicalPopupView): void {
  const presentation = canonicalPopupPresentation(view.state, pendingRecoveryConfirmation);
  const content = document.createDocumentFragment();
  content.append(
    heading(
      presentation.kind === "CreateVault"
        ? "Create your local Vault"
        : presentation.kind === "SelectVault"
          ? "Choose a Vault"
          : presentation.kind === "ConfirmRecoveryPhrase"
            ? "Protect your Vault"
            : "Archive this page",
    ),
  );
  if (transientError !== undefined) content.append(status(transientError, "error"));
  if (presentation.kind === "CreateVault") renderCreateVault(view, content);
  if (presentation.kind === "SelectVault") renderVaultSelection(view, content);
  if (presentation.kind === "ConfirmRecoveryPhrase") renderRecoveryConfirmation(content);
  if (presentation.kind === "Capture") renderCapture(view, content);
  app.replaceChildren(content);
  app.setAttribute("aria-busy", "false");
}

void controller.start().catch((error: unknown) => {
  app.replaceChildren(heading("Local archive"), status(errorMessage(error), "error"));
  app.setAttribute("aria-busy", "false");
});

window.addEventListener("pagehide", () => controller.stop(), { once: true });
