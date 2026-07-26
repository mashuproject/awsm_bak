import { browser } from "wxt/browser";
import { AppClientError, sendRequest } from "../../src/app/client";
import type { AppState } from "../../src/app/protocol";
import { requestSynchronizationPermission } from "../../src/ui/synchronization-permission";

function required<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error("Synchronization setup shell is incomplete.");
  return node;
}

const serverChoice = required<HTMLElement>("#server-choice");
const hostedServer = required<HTMLButtonElement>("#hosted-server");
const serverForm = required<HTMLFormElement>("#server-form");
const loginSection = required<HTMLElement>("#login-section");
const loginForm = required<HTMLFormElement>("#login-form");
const createAccount = required<HTMLAnchorElement>("#create-account");
const registrationDisabled = required<HTMLElement>("#registration-disabled");
const vaultSection = required<HTMLElement>("#vault-section");
const vaultForm = required<HTMLFormElement>("#vault-form");
const choices = required<HTMLFieldSetElement>("#vault-choice");
const vaultNameLabel = required<HTMLLabelElement>("#new-vault-name");
const vaultNameInput = required<HTMLInputElement>('input[name="vault-name"]');
const recoveryRevealSection = required<HTMLElement>("#recovery-reveal-section");
const recoveryPhrase = required<HTMLOutputElement>("#recovery-phrase");
const downloadRecovery = required<HTMLButtonElement>("#download-recovery");
const recoveryConfirmationForm = required<HTMLFormElement>("#recovery-confirmation-form");
const cancelInitialSetup = required<HTMLButtonElement>("#cancel-initial-setup");
const recoveryEntrySection = required<HTMLElement>("#recovery-entry-section");
const recoveryEntryForm = required<HTMLFormElement>("#recovery-entry-form");
const deviceSection = required<HTMLElement>("#device-section");
const deviceList = required<HTMLElement>("#device-list");
const dashboardServer = required<HTMLElement>("#dashboard-server");
const dashboardAccount = required<HTMLElement>("#dashboard-account");
const dashboardVault = required<HTMLElement>("#dashboard-vault");
const dashboardSync = required<HTMLElement>("#dashboard-sync");
const futureProtectionSection = required<HTMLElement>("#future-protection-section");
const futureRecoveryPhrase = required<HTMLOutputElement>("#future-recovery-phrase");
const downloadFutureRecovery = required<HTMLButtonElement>("#download-future-recovery");
const futureProtectionForm = required<HTMLFormElement>("#future-protection-form");
const cancelFutureProtection = required<HTMLButtonElement>("#cancel-future-protection");
const startVaultReplacement = required<HTMLButtonElement>("#start-vault-replacement");
const replacementPreflightSection = required<HTMLElement>("#replacement-preflight-section");
const replacementExportStatus = required<HTMLElement>("#replacement-export-status");
const replacementPreflightForm = required<HTMLFormElement>("#replacement-preflight-form");
const cancelReplacementPreflight = required<HTMLButtonElement>("#cancel-replacement-preflight");
const replacementRevealSection = required<HTMLElement>("#replacement-reveal-section");
const replacementRecoveryPhrase = required<HTMLOutputElement>("#replacement-recovery-phrase");
const downloadReplacementRecovery = required<HTMLButtonElement>("#download-replacement-recovery");
const replacementConfirmationForm = required<HTMLFormElement>("#replacement-confirmation-form");
const cancelVaultReplacement = required<HTMLButtonElement>("#cancel-vault-replacement");
const replacementProgressSection = required<HTMLElement>("#replacement-progress-section");
const replacementProgressCopy = required<HTMLElement>("#replacement-progress-copy");
const replacementProgress = required<HTMLProgressElement>("#replacement-progress");
const retryVaultReplacement = required<HTMLButtonElement>("#retry-vault-replacement");
const cancelInterruptedReplacement = required<HTMLButtonElement>("#cancel-interrupted-replacement");
const status = required<HTMLElement>("#status");
const setupSteps = [
  ...required<HTMLOListElement>("#setup-steps").querySelectorAll<HTMLElement>("[data-step]"),
];
let prepared:
  | {
      readonly setupId: string;
      readonly recoveryFileBase64: string;
      readonly recoveryFilename: string;
    }
  | undefined;
let preparedFuture:
  | {
      readonly protectionId: string;
      readonly recoveryFileBase64: string;
      readonly recoveryFilename: string;
    }
  | undefined;
let preparedReplacement:
  | {
      readonly replacementId: string;
      readonly recoveryFileBase64: string;
      readonly recoveryFilename: string;
    }
  | undefined;
let activeVaultId: string | undefined;
let currentReplacement: AppState["vaultReplacement"];
let replacementExportReady = false;
let initializeGeneration = 0;

function showStatus(message: string, alert = false): void {
  status.setAttribute("role", alert ? "alert" : "status");
  status.dataset.tone = alert ? "error" : "neutral";
  status.textContent = message;
}

function showStep(activeStep: number): void {
  for (const step of setupSteps) {
    const index = Number(step.dataset.step);
    step.toggleAttribute("data-complete", index < activeStep);
    if (index === activeStep) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  }
}

function choice(value: string, labelText: string, checked = false): HTMLLabelElement {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "vault-choice";
  input.value = value;
  input.required = true;
  input.checked = checked;
  input.addEventListener("change", updateVaultNameRequirement);
  label.append(input, document.createTextNode(labelText));
  return label;
}

function updateVaultNameRequirement(): void {
  const selected = vaultForm.querySelector<HTMLInputElement>('input[name="vault-choice"]:checked');
  const creating = selected?.value === "new";
  vaultNameLabel.hidden = !creating;
  vaultNameInput.required = creating;
}

function downloadFile(base64: string, filename: string): void {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.awsm.recovery" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function loadDevices(vaultId: string): Promise<void> {
  const devices = await sendRequest<
    readonly {
      readonly deviceId: string;
      readonly displayName: string;
      readonly clientKind: string;
      readonly current: boolean;
      readonly revoked: boolean;
    }[]
  >({ type: "ListVaultDevices", expectedVaultId: vaultId });
  deviceList.replaceChildren();
  for (const device of devices) {
    const card = document.createElement("article");
    card.className = "device-card";
    const name = document.createElement("strong");
    name.textContent = `${device.displayName}${device.current ? " · This Device" : ""}`;
    const details = document.createElement("p");
    details.textContent = device.revoked ? "Removed" : device.clientKind;
    card.append(name, details);
    if (device.current && !device.revoked) {
      const removeCurrent = document.createElement("button");
      removeCurrent.type = "button";
      removeCurrent.textContent = "Remove this Device";
      removeCurrent.addEventListener("click", () => {
        const confirmed = globalThis.confirm(
          "Remove this Device from synchronization and sign out? The local Vault and keys remain on this installation, but it will lose future server access. Anyone with the current Recovery Phrase can enroll again.",
        );
        if (!confirmed) return;
        removeCurrent.disabled = true;
        showStatus("Removing this Device and signing out…");
        void sendRequest<AppState>({
          type: "RemoveCurrentDevice",
          expectedVaultId: vaultId,
        }).then(
          () => initialize(),
          (cause: unknown) => {
            removeCurrent.disabled = false;
            showStatus(
              cause instanceof AppClientError ? cause.message : "This Device could not be removed.",
              true,
            );
          },
        );
      });
      card.append(removeCurrent);
    }
    if (!device.current && !device.revoked) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove Device";
      remove.addEventListener("click", () => {
        const confirmed = globalThis.confirm(
          "This stops future server access. It cannot remove Vault data or keys already saved on that Device. Anyone with the current Recovery Phrase can enroll again.",
        );
        if (!confirmed) return;
        remove.disabled = true;
        showStatus("Removing Device server access…");
        void sendRequest<null>({
          type: "RemoveVaultDevice",
          expectedVaultId: vaultId,
          deviceId: device.deviceId,
        }).then(
          () => loadDevices(vaultId),
          (cause: unknown) => {
            remove.disabled = false;
            showStatus(
              cause instanceof AppClientError ? cause.message : "Device removal failed.",
              true,
            );
          },
        );
      });
      const protect = document.createElement("button");
      protect.type = "button";
      protect.textContent = "Protect future content";
      protect.addEventListener("click", () => {
        protect.disabled = true;
        showStatus("Preparing a new Recovery Phrase and encryption epoch…");
        void sendRequest<{
          readonly protectionId: string;
          readonly recoveryPhrase: string;
          readonly recoveryFileBase64: string;
          readonly recoveryFilename: string;
        }>({
          type: "PrepareFutureProtection",
          expectedVaultId: vaultId,
          targetDeviceId: device.deviceId,
        }).then(
          (result) => {
            preparedFuture = {
              protectionId: result.protectionId,
              recoveryFileBase64: result.recoveryFileBase64,
              recoveryFilename: result.recoveryFilename,
            };
            deviceSection.hidden = true;
            futureProtectionSection.hidden = false;
            futureRecoveryPhrase.textContent = result.recoveryPhrase;
            required<HTMLButtonElement>('#future-protection-form button[type="submit"]').disabled =
              true;
            showStatus("Download the new recovery file, then enter all 12 new words again.");
          },
          (cause: unknown) => {
            protect.disabled = false;
            showStatus(
              cause instanceof AppClientError
                ? cause.message
                : "Future Protection could not be prepared.",
              true,
            );
          },
        );
      });
      card.append(remove, protect);
    }
    deviceList.append(card);
  }
}

async function configureServer(origin: string): Promise<void> {
  if (!(await requestSynchronizationPermission(origin)))
    throw new AppClientError(
      "SERVER_PERMISSION_DENIED",
      "The browser did not grant access to that synchronization server.",
    );
  await sendRequest<AppState>({ type: "ConfigureSyncServer", serverOrigin: origin });
  await initialize();
}

async function initialize(): Promise<void> {
  const generation = ++initializeGeneration;
  const state = await sendRequest<AppState>({ type: "GetState" });
  if (generation !== initializeGeneration) return;
  serverChoice.hidden = state.account.configuration.mode !== "Unconfigured";
  loginSection.hidden = true;
  vaultSection.hidden = true;
  recoveryRevealSection.hidden = true;
  recoveryEntrySection.hidden = true;
  deviceSection.hidden = true;
  futureProtectionSection.hidden = true;
  replacementPreflightSection.hidden = true;
  replacementRevealSection.hidden = true;
  replacementProgressSection.hidden = true;
  activeVaultId = state.workspace.activeVaultId;
  currentReplacement = state.vaultReplacement;
  replacementExportReady =
    state.latestExportJob?.state === "Succeeded" &&
    state.latestExportJob.verifiedSnapshot?.coverage === "Complete";
  if (
    state.vaultReplacement !== undefined &&
    !["Succeeded", "Failed", "Aborted"].includes(state.vaultReplacement.state)
  ) {
    if (
      state.vaultReplacement.state === "WaitingForPhraseConfirmation" &&
      preparedReplacement?.replacementId === state.vaultReplacement.jobId
    ) {
      replacementRevealSection.hidden = false;
      showStep(4);
      return;
    }
    replacementProgressSection.hidden = false;
    showStep(4);
    const total =
      state.vaultReplacement.totalBytes > 0
        ? state.vaultReplacement.totalBytes
        : state.vaultReplacement.totalItems;
    const completed =
      state.vaultReplacement.totalBytes > 0
        ? state.vaultReplacement.processedBytes
        : state.vaultReplacement.completedItems;
    replacementProgress.max = Math.max(total, 1);
    replacementProgress.value = Math.min(completed, replacementProgress.max);
    retryVaultReplacement.hidden = state.vaultReplacement.state !== "Running";
    cancelInterruptedReplacement.hidden =
      state.vaultReplacement.state !== "WaitingForPhraseConfirmation";
    replacementProgressCopy.textContent =
      state.vaultReplacement.state === "WaitingForPhraseConfirmation"
        ? "The phrase display was interrupted before confirmation. Cancel this preparation and begin again to create a new phrase."
        : `Stage: ${state.vaultReplacement.stage}. Keep the browser open; restart-safe progress is saved locally.`;
    showStatus("The synchronized Vault is locked for replacement.");
    return;
  }
  if (prepared !== undefined) {
    recoveryRevealSection.hidden = false;
    showStep(3);
    return;
  }
  if (state.account.configuration.mode === "Unconfigured") {
    showStep(0);
    return;
  }
  if (state.account.configuration.mode === "LocalOnly") {
    showStep(0);
    showStatus("This installation is configured for local-only use.");
    return;
  }
  if (state.account.accountState !== "Authenticated") {
    showStep(1);
    loginSection.hidden = false;
    const registration = state.account.configuration.registration;
    createAccount.hidden = !registration.enabled;
    registrationDisabled.hidden = registration.enabled;
    if (registration.enabled) createAccount.href = registration.signUpUrl;
    return;
  }
  if (
    state.account.vaultSyncState === "RecoveryRequired" ||
    state.account.vaultSyncState === "DeviceRevoked"
  ) {
    showStep(3);
    recoveryEntrySection.hidden = false;
    showStatus(
      state.account.vaultSyncState === "DeviceRevoked"
        ? "This Device was removed from synchronization. Existing local history remains available. Enter the current Recovery Phrase to enroll a new Device identity."
        : "Enter the Recovery Phrase to enroll this Device.",
      state.account.vaultSyncState === "DeviceRevoked",
    );
    return;
  }
  if (state.account.vaultSyncState !== "SetupRequired") {
    if (state.workspace.activeVaultId !== undefined) {
      showStep(4);
      deviceSection.hidden = false;
      const activeVault = state.workspace.vaults.find((vault) => vault.active);
      dashboardServer.textContent =
        state.account.configuration.mode === "Configured"
          ? state.account.configuration.serverOrigin
          : "Not configured";
      dashboardAccount.textContent = state.account.email ?? "Not signed in";
      dashboardVault.textContent = activeVault?.name ?? "Unavailable";
      dashboardSync.textContent =
        state.account.vaultSyncState === "UpToDate" ? "Up to date" : state.account.vaultSyncState;
      await loadDevices(state.workspace.activeVaultId);
      if (generation !== initializeGeneration) return;
      showStatus(
        state.account.vaultSyncState === "UpToDate"
          ? "Synchronization is up to date."
          : `Synchronization status: ${state.account.vaultSyncState}.`,
      );
      return;
    }
    showStatus("Synchronization setup is already in progress.");
    return;
  }
  vaultSection.hidden = false;
  showStep(2);
  choices.replaceChildren(required<HTMLLegendElement>("#vault-choice legend"));
  choices.append(choice("new", "Create a new Vault", true));
  for (const vault of state.workspace.vaults)
    choices.append(choice(vault.vaultId, `Use existing local Vault: ${vault.name}`));
  const suggestion = await sendRequest<{ readonly name: string }>({ type: "SuggestVaultName" });
  if (generation !== initializeGeneration) return;
  vaultNameInput.value = suggestion.name;
  updateVaultNameRequirement();
}

hostedServer.addEventListener("click", () => {
  hostedServer.disabled = true;
  showStatus("Connecting to hosted AWSM…");
  void configureServer("https://awsm.foo").catch((cause: unknown) => {
    hostedServer.disabled = false;
    showStatus(
      cause instanceof AppClientError ? cause.message : "The server could not be configured.",
      true,
    );
  });
});

serverForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const submit = required<HTMLButtonElement>('#server-form button[type="submit"]');
  submit.disabled = true;
  showStatus("Connecting to the synchronization server…");
  const origin = String(new FormData(serverForm).get("server-origin") ?? "");
  void configureServer(origin).catch((cause: unknown) => {
    submit.disabled = false;
    showStatus(
      cause instanceof AppClientError ? cause.message : "The server could not be configured.",
      true,
    );
  });
});

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const submit = required<HTMLButtonElement>('#login-form button[type="submit"]');
  const data = new FormData(loginForm);
  const password = required<HTMLInputElement>('#login-form input[name="password"]');
  submit.disabled = true;
  showStatus("Logging in…");
  const pending = sendRequest<AppState>({
    type: "LoginAccount",
    email: String(data.get("email") ?? ""),
    password: String(data.get("password") ?? ""),
  });
  password.value = "";
  void pending.then(
    () => initialize(),
    (cause: unknown) => {
      submit.disabled = false;
      showStatus(cause instanceof AppClientError ? cause.message : "Login failed.", true);
    },
  );
});

vaultForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const selected = String(new FormData(vaultForm).get("vault-choice") ?? "");
  const choice =
    selected === "new" ? { newVaultName: vaultNameInput.value } : { existingVaultId: selected };
  showStatus("Preparing Recovery Phrase setup…");
  void sendRequest<{
    readonly setupId: string;
    readonly recoveryPhrase: string;
    readonly recoveryFileBase64: string;
    readonly recoveryFilename: string;
  }>({ type: "PrepareAccountVault", ...choice }).then(
    (result) => {
      prepared = {
        setupId: result.setupId,
        recoveryFileBase64: result.recoveryFileBase64,
        recoveryFilename: result.recoveryFilename,
      };
      vaultSection.hidden = true;
      recoveryRevealSection.hidden = false;
      showStep(3);
      recoveryPhrase.textContent = result.recoveryPhrase;
      showStatus("Save the phrase and recovery file, then enter all 12 words again.");
    },
    (cause: unknown) =>
      showStatus(
        cause instanceof AppClientError ? cause.message : "Setup could not continue.",
        true,
      ),
  );
});

downloadRecovery.addEventListener("click", () => {
  if (prepared === undefined) return;
  downloadFile(prepared.recoveryFileBase64, prepared.recoveryFilename);
  showStatus("Recovery file downloaded. Keep it with the 12-word phrase.");
});

recoveryConfirmationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (prepared === undefined) return;
  const field = required<HTMLTextAreaElement>(
    '#recovery-confirmation-form textarea[name="recovery-confirmation"]',
  );
  const phrase = field.value;
  field.value = "";
  showStatus("Confirming and attaching the Vault…");
  void sendRequest<AppState>({
    type: "ConfirmInitialVault",
    setupId: prepared.setupId,
    recoveryPhrase: phrase,
  }).then(
    () => {
      prepared = undefined;
      recoveryPhrase.textContent = "";
      return initialize();
    },
    (cause: unknown) => {
      prepared = undefined;
      recoveryPhrase.textContent = "";
      recoveryRevealSection.hidden = true;
      void initialize();
      showStatus(
        cause instanceof AppClientError ? cause.message : "The Vault could not be attached.",
        true,
      );
    },
  );
});

cancelInitialSetup.addEventListener("click", () => {
  if (prepared === undefined) return;
  const setupId = prepared.setupId;
  prepared = undefined;
  recoveryPhrase.textContent = "";
  void sendRequest<null>({ type: "CancelInitialVault", setupId }).finally(() => initialize());
});

recoveryEntryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const phrase = required<HTMLTextAreaElement>(
    '#recovery-entry-form textarea[name="recovery-phrase"]',
  );
  const confirmation = required<HTMLTextAreaElement>(
    '#recovery-entry-form textarea[name="recovery-confirmation"]',
  );
  const request = {
    type: "RecoverAccountVault" as const,
    recoveryPhrase: phrase.value,
    confirmationPhrase: confirmation.value,
  };
  phrase.value = "";
  confirmation.value = "";
  showStatus("Enrolling this Device and validating the synchronized Vault…");
  void sendRequest<AppState>(request).then(
    () => initialize(),
    (cause: unknown) =>
      showStatus(cause instanceof AppClientError ? cause.message : "Device recovery failed.", true),
  );
});

startVaultReplacement.addEventListener("click", () => {
  deviceSection.hidden = true;
  replacementPreflightSection.hidden = false;
  replacementExportStatus.textContent = replacementExportReady
    ? "The most recent Complete Export was verified and downloaded. Confirm where you stored it before continuing."
    : "No current verified Complete Export is available. Return to the Library, create a Complete Export, verify its download, then come back.";
  required<HTMLButtonElement>('#replacement-preflight-form button[type="submit"]').disabled =
    !replacementExportReady;
  showStatus(
    replacementExportReady
      ? "Review every consequence before creating replacement authority."
      : "A current verified Complete Export is required.",
    !replacementExportReady,
  );
});

cancelReplacementPreflight.addEventListener("click", () => {
  replacementPreflightForm.reset();
  replacementPreflightSection.hidden = true;
  deviceSection.hidden = false;
  showStatus("Vault replacement was not started.");
});

replacementPreflightForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (activeVaultId === undefined) return;
  const submit = required<HTMLButtonElement>('#replacement-preflight-form button[type="submit"]');
  submit.disabled = true;
  showStatus("Creating independent replacement Vault authority…");
  void sendRequest<{
    readonly replacementId: string;
    readonly recoveryPhrase: string;
    readonly recoveryFileBase64: string;
    readonly recoveryFilename: string;
  }>({
    type: "PrepareVaultReplacement",
    expectedVaultId: activeVaultId,
    safelyStoredConfirmed: new FormData(replacementPreflightForm).get("safely-stored") === "on",
  }).then(
    (result) => {
      preparedReplacement = {
        replacementId: result.replacementId,
        recoveryFileBase64: result.recoveryFileBase64,
        recoveryFilename: result.recoveryFilename,
      };
      replacementPreflightSection.hidden = true;
      replacementRevealSection.hidden = false;
      replacementRecoveryPhrase.textContent = result.recoveryPhrase;
      required<HTMLButtonElement>('#replacement-confirmation-form button[type="submit"]').disabled =
        true;
      showStatus("Download the replacement recovery file, then enter all 12 new words.");
    },
    (cause: unknown) => {
      submit.disabled = false;
      showStatus(
        cause instanceof AppClientError
          ? cause.message
          : "Vault replacement could not be prepared.",
        true,
      );
    },
  );
});

downloadReplacementRecovery.addEventListener("click", () => {
  if (preparedReplacement === undefined) return;
  downloadFile(preparedReplacement.recoveryFileBase64, preparedReplacement.recoveryFilename);
  required<HTMLButtonElement>('#replacement-confirmation-form button[type="submit"]').disabled =
    false;
  showStatus("Replacement recovery file downloaded. Enter all 12 new words to continue.");
});

replacementConfirmationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (preparedReplacement === undefined) return;
  const field = required<HTMLTextAreaElement>(
    '#replacement-confirmation-form textarea[name="replacement-recovery-confirmation"]',
  );
  const submit = required<HTMLButtonElement>(
    '#replacement-confirmation-form button[type="submit"]',
  );
  submit.disabled = true;
  const phrase = field.value;
  field.value = "";
  showStatus("Re-encrypting and validating the replacement Vault. Do not close this page…");
  void sendRequest<AppState>({
    type: "ConfirmVaultReplacement",
    replacementId: preparedReplacement.replacementId,
    recoveryPhrase: phrase,
  }).then(
    () => {
      preparedReplacement = undefined;
      replacementRecoveryPhrase.textContent = "";
      return initialize();
    },
    (cause: unknown) => {
      if (cause instanceof AppClientError && cause.id === "RECOVERY_PHRASE_INVALID") {
        submit.disabled = false;
        showStatus(cause.message, true);
        return;
      }
      preparedReplacement = undefined;
      replacementRecoveryPhrase.textContent = "";
      void initialize();
      showStatus(
        cause instanceof AppClientError
          ? cause.message
          : "Vault replacement was interrupted and can be retried.",
        true,
      );
    },
  );
});

cancelVaultReplacement.addEventListener("click", () => {
  if (preparedReplacement === undefined) return;
  const replacementId = preparedReplacement.replacementId;
  preparedReplacement = undefined;
  replacementRecoveryPhrase.textContent = "";
  void sendRequest<null>({
    type: "CancelVaultReplacement",
    replacementId,
  }).finally(() => initialize());
});

cancelInterruptedReplacement.addEventListener("click", () => {
  if (currentReplacement === undefined) return;
  cancelInterruptedReplacement.disabled = true;
  void sendRequest<null>({
    type: "CancelVaultReplacement",
    replacementId: currentReplacement.jobId,
  }).then(
    () => initialize(),
    (cause: unknown) => {
      cancelInterruptedReplacement.disabled = false;
      showStatus(
        cause instanceof AppClientError
          ? cause.message
          : "Interrupted preparation could not be cancelled.",
        true,
      );
    },
  );
});

retryVaultReplacement.addEventListener("click", () => {
  if (activeVaultId === undefined) return;
  retryVaultReplacement.disabled = true;
  showStatus("Resuming the saved Vault replacement…");
  void sendRequest<AppState>({
    type: "RetryVaultReplacement",
    expectedVaultId: activeVaultId,
  }).then(
    () => initialize(),
    (cause: unknown) => {
      retryVaultReplacement.disabled = false;
      showStatus(
        cause instanceof AppClientError ? cause.message : "Vault replacement could not resume.",
        true,
      );
    },
  );
});

downloadFutureRecovery.addEventListener("click", () => {
  if (preparedFuture === undefined) return;
  downloadFile(preparedFuture.recoveryFileBase64, preparedFuture.recoveryFilename);
  required<HTMLButtonElement>('#future-protection-form button[type="submit"]').disabled = false;
  showStatus("New recovery file downloaded. Enter all 12 new words to continue.");
});

futureProtectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (preparedFuture === undefined) return;
  const field = required<HTMLTextAreaElement>(
    '#future-protection-form textarea[name="future-recovery-confirmation"]',
  );
  const submit = required<HTMLButtonElement>('#future-protection-form button[type="submit"]');
  submit.disabled = true;
  const request = {
    type: "ConfirmFutureProtection" as const,
    protectionId: preparedFuture.protectionId,
    recoveryPhrase: field.value,
  };
  field.value = "";
  showStatus("Rotating Recovery Phrase and protecting future content…");
  void sendRequest<AppState>(request).then(
    () => {
      preparedFuture = undefined;
      futureRecoveryPhrase.textContent = "";
      return initialize();
    },
    (cause: unknown) => {
      preparedFuture = undefined;
      futureRecoveryPhrase.textContent = "";
      futureProtectionSection.hidden = true;
      if (activeVaultId !== undefined) {
        deviceSection.hidden = false;
        void loadDevices(activeVaultId).catch(() => undefined);
      }
      showStatus(
        cause instanceof AppClientError
          ? cause.message
          : "Future Protection could not be completed.",
        true,
      );
    },
  );
});

cancelFutureProtection.addEventListener("click", () => {
  if (preparedFuture === undefined) return;
  const protectionId = preparedFuture.protectionId;
  preparedFuture = undefined;
  futureRecoveryPhrase.textContent = "";
  void sendRequest<null>({ type: "CancelFutureProtection", protectionId }).finally(() =>
    initialize(),
  );
});

browser.runtime.onMessage.addListener((message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "AppStateChanged"
  )
    void initialize();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void initialize();
});
globalThis.addEventListener("focus", () => void initialize());

void initialize().catch(() => showStatus("Synchronization setup could not be loaded.", true));
