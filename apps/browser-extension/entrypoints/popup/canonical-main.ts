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

type CanonicalPopupVaultScreen =
  | { readonly kind: "Capture" }
  | { readonly kind: "Settings" }
  | {
      readonly kind: "RecoveryPhraseReplacement";
      readonly setup: Awaited<
        ReturnType<CanonicalPopupApplicationClient["beginRecoveryPhraseReplacement"]>
      >;
    }
  | {
      readonly kind: "Fork";
      readonly setup: Awaited<ReturnType<CanonicalPopupApplicationClient["beginVaultFork"]>>;
    }
  | { readonly kind: "VacuumConfirmation" }
  | { readonly kind: "ClosureConfirmation" };

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
let vaultScreen: CanonicalPopupVaultScreen = { kind: "Capture" };

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

function renderRecoveryResume(
  presentation: Extract<
    ReturnType<typeof canonicalPopupPresentation>,
    { readonly kind: "ResumeRecoveryPhrase" }
  >,
  content: DocumentFragment,
): void {
  content.append(
    element(
      "p",
      "Your Vault setup is waiting for its Recovery Phrase. Enter the phrase you wrote down to finish, or cancel this setup and begin again.",
      "canonical-popup__warning",
    ),
  );
  const form = element("form", undefined, "canonical-popup__form");
  const phraseLabel = element("label", "Recovery Phrase");
  const phrase = element("input") as HTMLInputElement;
  phrase.autocomplete = "off";
  phrase.required = true;
  phraseLabel.append(phrase);
  const actions = element("div", undefined, "canonical-popup__actions");
  const cancel = element("button", "Cancel setup") as HTMLButtonElement;
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    action(cancel, async () => {
      transientError = undefined;
      await client.cancelVaultCreation(presentation.setupId);
      await controller.refresh();
    });
  });
  const submit = element(
    "button",
    "Resume Vault creation",
    "canonical-popup__primary",
  ) as HTMLButtonElement;
  submit.type = "submit";
  actions.append(cancel, submit);
  form.append(phraseLabel, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    action(submit, async () => {
      transientError = undefined;
      await client.confirmVaultCreation({
        setupId: presentation.setupId,
        recoveryPhrase: phrase.value,
      });
      announcer.textContent = "Vault created.";
      await controller.refresh();
    });
  });
  content.append(form);
}

function renderRecentCaptures(view: CanonicalPopupView, content: DocumentFragment): void {
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

function openLibraryControl(): HTMLButtonElement {
  const openLibrary = element(
    "button",
    "Open Library",
    "canonical-popup__quiet",
  ) as HTMLButtonElement;
  openLibrary.type = "button";
  openLibrary.addEventListener("click", () => {
    openLibrary.disabled = true;
    void browser.tabs
      .create({ url: browser.runtime.getURL("/library.html") })
      .catch(showError)
      .finally(() => {
        openLibrary.disabled = false;
      });
  });
  return openLibrary;
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
  const settings = element(
    "button",
    "Vault settings",
    "canonical-popup__quiet",
  ) as HTMLButtonElement;
  settings.type = "button";
  settings.addEventListener("click", () => {
    vaultScreen = { kind: "Settings" };
    render(view);
  });
  content.append(openLibraryControl(), settings);
  renderRecentCaptures(view, content);
}

function renderVaultSettings(view: CanonicalPopupView, content: DocumentFragment): void {
  const presentation = canonicalPopupPresentation(view.state);
  if (presentation.kind !== "Capture" && presentation.kind !== "ClosedVault") {
    throw new Error("Vault settings require a selected Vault.");
  }
  const closed = presentation.kind === "ClosedVault";
  content.append(
    element(
      "p",
      `Vault · ${displayVaultLabel(presentation.vault.label)}`,
      "canonical-popup__context",
    ),
    element(
      "p",
      closed
        ? "This Vault is closed. Existing data remains readable here, and you can Fork its current state into a new Vault."
        : "Recovery, Fork, Vacuum, and closure affect this Vault. Your Host Account does not grant access to its contents.",
      "canonical-popup__warning",
    ),
  );
  const actions = element("div", undefined, "canonical-popup__management");
  const fork = element("button", "Fork this Vault") as HTMLButtonElement;
  fork.type = "button";
  fork.addEventListener("click", () => {
    action(fork, async () => {
      transientError = undefined;
      const setup = await client.beginVaultFork(presentation.vault.vaultId);
      vaultScreen = { kind: "Fork", setup };
      await controller.refresh();
    });
  });
  const back = element("button", "Back to Vault", "canonical-popup__quiet") as HTMLButtonElement;
  back.type = "button";
  back.addEventListener("click", () => {
    vaultScreen = { kind: "Capture" };
    render(view);
  });
  if (!closed) {
    const replace = element("button", "Change Recovery Phrase") as HTMLButtonElement;
    replace.type = "button";
    replace.addEventListener("click", () => {
      action(replace, async () => {
        transientError = undefined;
        const setup = await client.beginRecoveryPhraseReplacement(presentation.vault.vaultId);
        vaultScreen = { kind: "RecoveryPhraseReplacement", setup };
        await controller.refresh();
      });
    });
    const vacuum = element("button", "Vacuum this Vault") as HTMLButtonElement;
    vacuum.type = "button";
    vacuum.addEventListener("click", () => {
      vaultScreen = { kind: "VacuumConfirmation" };
      render(view);
    });
    const close = element("button", "Close Vault", "canonical-popup__danger") as HTMLButtonElement;
    close.type = "button";
    close.addEventListener("click", () => {
      vaultScreen = { kind: "ClosureConfirmation" };
      render(view);
    });
    actions.append(replace, fork, vacuum, close, back);
  } else {
    actions.append(fork, back);
  }
  content.append(actions);
}

function renderClosedVault(view: CanonicalPopupView, content: DocumentFragment): void {
  const presentation = canonicalPopupPresentation(view.state);
  if (presentation.kind !== "ClosedVault") throw new Error("Closed Vault state is invalid.");
  content.append(
    element(
      "p",
      `Vault · ${displayVaultLabel(presentation.vault.label)}`,
      "canonical-popup__context",
    ),
    element(
      "p",
      "This Vault is closed. You can still read what is available locally, or Fork its current state into a new Vault.",
      "canonical-popup__warning",
    ),
  );
  const settings = element(
    "button",
    "Vault settings",
    "canonical-popup__quiet",
  ) as HTMLButtonElement;
  settings.type = "button";
  settings.addEventListener("click", () => {
    vaultScreen = { kind: "Settings" };
    render(view);
  });
  content.append(openLibraryControl(), settings);
  renderRecentCaptures(view, content);
}

function renderRecoverAccess(
  presentation: Extract<
    ReturnType<typeof canonicalPopupPresentation>,
    { readonly kind: "RecoverAccess" }
  >,
  content: DocumentFragment,
): void {
  content.append(
    element(
      "p",
      `Vault · ${displayVaultLabel(presentation.vault.label)}`,
      "canonical-popup__context",
    ),
    element(
      "p",
      "This Client can read this Vault but cannot add new Events. Enter a Recovery Phrase to restore access for this Member on this Client.",
      "canonical-popup__warning",
    ),
  );
  const form = element("form", undefined, "canonical-popup__form");
  const phraseLabel = element("label", "Recovery Phrase");
  const phrase = element("textarea") as HTMLTextAreaElement;
  phrase.autocomplete = "off";
  phrase.required = true;
  phrase.rows = 3;
  phraseLabel.append(phrase);
  const submit = element(
    "button",
    "Recover access",
    "canonical-popup__primary",
  ) as HTMLButtonElement;
  submit.type = "submit";
  form.append(phraseLabel, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    action(submit, async () => {
      transientError = undefined;
      await client.recoverMember({
        expectedVaultId: presentation.vault.vaultId,
        recoveryPhrase: phrase.value,
      });
      announcer.textContent = "Vault access recovered.";
      await controller.refresh();
    });
  });
  content.append(form);
}

function renderRecoveryPhraseReplacement(
  content: DocumentFragment,
  setup: Extract<
    CanonicalPopupVaultScreen,
    { readonly kind: "RecoveryPhraseReplacement" }
  >["setup"],
): void {
  content.append(
    element(
      "p",
      "Write the new Recovery Phrase down somewhere safe. It replaces the current phrase after confirmation.",
      "canonical-popup__warning",
    ),
  );
  const phrase = element("textarea") as HTMLTextAreaElement;
  phrase.readOnly = true;
  phrase.value = setup.recoveryPhrase;
  phrase.rows = 3;
  phrase.setAttribute("aria-label", "New Recovery Phrase");
  content.append(phrase);
  const form = element("form", undefined, "canonical-popup__form");
  const confirmationLabel = element("label", "Type the new Recovery Phrase to continue");
  const confirmation = element("input") as HTMLInputElement;
  confirmation.autocomplete = "off";
  confirmation.required = true;
  confirmationLabel.append(confirmation);
  const actions = element("div", undefined, "canonical-popup__actions");
  const cancel = element("button", "Cancel Recovery Phrase replacement") as HTMLButtonElement;
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    action(cancel, async () => {
      transientError = undefined;
      await client.cancelRecoveryPhraseReplacement(setup.setupId);
      vaultScreen = { kind: "Settings" };
      await controller.refresh();
    });
  });
  const submit = element(
    "button",
    "Confirm new Recovery Phrase",
    "canonical-popup__primary",
  ) as HTMLButtonElement;
  submit.type = "submit";
  actions.append(cancel, submit);
  form.append(confirmationLabel, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    action(submit, async () => {
      transientError = undefined;
      await client.confirmRecoveryPhraseReplacement({
        setupId: setup.setupId,
        recoveryPhrase: confirmation.value,
      });
      vaultScreen = { kind: "Settings" };
      announcer.textContent = "Recovery Phrase replaced.";
      await controller.refresh();
    });
  });
  content.append(form);
}

function renderVaultFork(
  content: DocumentFragment,
  setup: Extract<CanonicalPopupVaultScreen, { readonly kind: "Fork" }>["setup"],
): void {
  content.append(
    element(
      "p",
      "Fork creates a new Vault from the current state. It leaves this Vault and its history unchanged.",
      "canonical-popup__warning",
    ),
  );
  const phrase = element("textarea") as HTMLTextAreaElement;
  phrase.readOnly = true;
  phrase.value = setup.recoveryPhrase;
  phrase.rows = 3;
  phrase.setAttribute("aria-label", "Recovery Phrase");
  content.append(phrase);
  const form = element("form", undefined, "canonical-popup__form");
  const confirmationLabel = element("label", "Type the Recovery Phrase to create the Fork");
  const confirmation = element("input") as HTMLInputElement;
  confirmation.autocomplete = "off";
  confirmation.required = true;
  confirmationLabel.append(confirmation);
  const actions = element("div", undefined, "canonical-popup__actions");
  const cancel = element("button", "Cancel Vault fork") as HTMLButtonElement;
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    action(cancel, async () => {
      transientError = undefined;
      await client.cancelVaultFork(setup.setupId);
      vaultScreen = { kind: "Settings" };
      await controller.refresh();
    });
  });
  const submit = element(
    "button",
    "Confirm Vault fork",
    "canonical-popup__primary",
  ) as HTMLButtonElement;
  submit.type = "submit";
  actions.append(cancel, submit);
  form.append(confirmationLabel, actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    action(submit, async () => {
      transientError = undefined;
      await client.confirmVaultFork({ setupId: setup.setupId, recoveryPhrase: confirmation.value });
      vaultScreen = { kind: "Capture" };
      announcer.textContent = "Vault forked.";
      await controller.refresh();
    });
  });
  content.append(form);
}

function renderVacuumConfirmation(view: CanonicalPopupView, content: DocumentFragment): void {
  const presentation = canonicalPopupPresentation(view.state);
  if (presentation.kind !== "Capture") throw new Error("Vacuum requires a selected Vault.");
  content.append(
    element(
      "p",
      "Vacuum creates a new baseline. Other Replicas can adopt it, or Fork before adoption to retain the older history. This Client does not delete old bytes automatically.",
      "canonical-popup__warning",
    ),
  );
  const actions = element("div", undefined, "canonical-popup__actions");
  const cancel = element("button", "Cancel Vacuum") as HTMLButtonElement;
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    vaultScreen = { kind: "Settings" };
    render(view);
  });
  const confirm = element(
    "button",
    "Confirm Vacuum",
    "canonical-popup__danger",
  ) as HTMLButtonElement;
  confirm.type = "button";
  confirm.addEventListener("click", () => {
    action(confirm, async () => {
      transientError = undefined;
      await client.vacuumVault(presentation.vault.vaultId);
      vaultScreen = { kind: "Settings" };
      announcer.textContent = "Vault Vacuum created.";
      await controller.refresh();
    });
  });
  actions.append(cancel, confirm);
  content.append(actions);
}

function renderClosureConfirmation(view: CanonicalPopupView, content: DocumentFragment): void {
  const presentation = canonicalPopupPresentation(view.state);
  if (presentation.kind !== "Capture") throw new Error("Closure requires a selected Vault.");
  content.append(
    element(
      "p",
      "Closing stops new Events in this Vault. Existing Replicas keep their current data and can Fork it into a new Vault.",
      "canonical-popup__warning",
    ),
  );
  const actions = element("div", undefined, "canonical-popup__actions");
  const cancel = element("button", "Cancel closure") as HTMLButtonElement;
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    vaultScreen = { kind: "Settings" };
    render(view);
  });
  const confirm = element(
    "button",
    "Confirm closure",
    "canonical-popup__danger",
  ) as HTMLButtonElement;
  confirm.type = "button";
  confirm.addEventListener("click", () => {
    action(confirm, async () => {
      transientError = undefined;
      await client.closeVault(presentation.vault.vaultId);
      vaultScreen = { kind: "Capture" };
      announcer.textContent = "Vault closed.";
      await controller.refresh();
    });
  });
  actions.append(cancel, confirm);
  content.append(actions);
}

function popupHeading(presentation: ReturnType<typeof canonicalPopupPresentation>): string {
  if (presentation.kind !== "Capture") {
    return presentation.kind === "CreateVault"
      ? "Create your local Vault"
      : presentation.kind === "SelectVault"
        ? "Choose a Vault"
        : presentation.kind === "ConfirmRecoveryPhrase"
          ? "Protect your Vault"
          : presentation.kind === "ResumeRecoveryPhrase"
            ? "Resume Vault setup"
            : presentation.kind === "ClosedVault"
              ? "Vault is closed"
              : "Recover Vault access";
  }
  switch (vaultScreen.kind) {
    case "Capture":
      return "Archive this page";
    case "Settings":
      return "Vault settings";
    case "RecoveryPhraseReplacement":
      return "Replace your Recovery Phrase";
    case "Fork":
      return "Fork this Vault";
    case "VacuumConfirmation":
      return "Vacuum this Vault?";
    case "ClosureConfirmation":
      return "Close this Vault?";
  }
}

function render(view: CanonicalPopupView): void {
  const presentation = canonicalPopupPresentation(view.state, pendingRecoveryConfirmation);
  const content = document.createDocumentFragment();
  content.append(heading(popupHeading(presentation)));
  if (transientError !== undefined) content.append(status(transientError, "error"));
  if (presentation.kind === "CreateVault") renderCreateVault(view, content);
  if (presentation.kind === "SelectVault") renderVaultSelection(view, content);
  if (presentation.kind === "ConfirmRecoveryPhrase") renderRecoveryConfirmation(content);
  if (presentation.kind === "ResumeRecoveryPhrase") renderRecoveryResume(presentation, content);
  if (presentation.kind === "RecoverAccess") renderRecoverAccess(presentation, content);
  if (presentation.kind === "Capture" || presentation.kind === "ClosedVault") {
    if (vaultScreen.kind === "Capture") {
      if (presentation.kind === "Capture") renderCapture(view, content);
      if (presentation.kind === "ClosedVault") renderClosedVault(view, content);
    }
    if (vaultScreen.kind === "Settings") renderVaultSettings(view, content);
    if (vaultScreen.kind === "RecoveryPhraseReplacement") {
      renderRecoveryPhraseReplacement(content, vaultScreen.setup);
    }
    if (vaultScreen.kind === "Fork") renderVaultFork(content, vaultScreen.setup);
    if (vaultScreen.kind === "VacuumConfirmation") renderVacuumConfirmation(view, content);
    if (vaultScreen.kind === "ClosureConfirmation") renderClosureConfirmation(view, content);
  }
  app.replaceChildren(content);
  app.setAttribute("aria-busy", "false");
}

void controller.start().catch((error: unknown) => {
  app.replaceChildren(heading("Local archive"), status(errorMessage(error), "error"));
  app.setAttribute("aria-busy", "false");
});

window.addEventListener("pagehide", () => controller.stop(), { once: true });
