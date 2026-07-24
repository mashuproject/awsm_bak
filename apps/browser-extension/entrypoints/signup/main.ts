import { AppClientError, sendRequest } from "../../src/app/client";
import type { AppState } from "../../src/app/protocol";
import { requestSynchronizationPermission } from "../../src/ui/synchronization-permission";

function required<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error("Signup shell is incomplete.");
  return node;
}

const form = required<HTMLFormElement>("#signup-form");
const serverChoice = required<HTMLElement>("#server-choice");
const hostedServer = required<HTMLButtonElement>("#hosted-server");
const serverForm = required<HTMLFormElement>("#server-form");
const serverOrigin = required<HTMLInputElement>('input[name="server-origin"]');
const choices = required<HTMLFieldSetElement>("#vault-choice");
const status = required<HTMLElement>("#status");
const passwordExplanation = required<HTMLElement>("#password-explanation");
const emailExplanation = required<HTMLElement>("#email-explanation");
const emailLabel = required<HTMLLabelElement>("#email-label");
const passwordLabel = required<HTMLLabelElement>("#password-label");
const confirmationLabel = required<HTMLLabelElement>("#confirmation-label");
const acknowledgementLabel = required<HTMLLabelElement>("#acknowledgement-label");
const vaultNameLabel = required<HTMLLabelElement>("#new-vault-name");
const vaultNameInput = required<HTMLInputElement>('input[name="vault-name"]');
const emailInput = required<HTMLInputElement>('input[name="email"]');
const passwordInput = required<HTMLInputElement>('input[name="password"]');
const confirmationInput = required<HTMLInputElement>('input[name="confirmation"]');
const acknowledgementInput = required<HTMLInputElement>('input[name="acknowledgement"]');
const accountSubmit = required<HTMLButtonElement>("#account-submit");
const signInInstead = required<HTMLButtonElement>("#signin-instead");
let accountMode: "signup" | "login" | "completion" = "signup";

function showStatus(
  message: string,
  role: "status" | "alert" = "status",
  tone: "neutral" | "success" | "error" = role === "alert" ? "error" : "neutral",
): void {
  status.setAttribute("role", role);
  status.dataset.tone = tone;
  status.textContent = message;
}

async function configureServer(origin: string): Promise<void> {
  if (!(await requestSynchronizationPermission(origin))) {
    throw new AppClientError(
      "SERVER_PERMISSION_DENIED",
      "The browser did not grant access to that synchronization server.",
    );
  }
  await sendRequest<AppState>({
    type: "ConfigureSyncServer",
    serverOrigin: origin,
  });
  await initialize();
}

function updateVaultNameRequirement(): void {
  if (accountMode === "login") {
    vaultNameLabel.hidden = true;
    vaultNameInput.required = false;
    return;
  }
  const selected = form.querySelector<HTMLInputElement>('input[name="vault-choice"]:checked');
  const creating = selected?.value === "new";
  vaultNameLabel.hidden = !creating;
  vaultNameInput.required = creating;
}

function setAccountMode(mode: "signup" | "login" | "completion"): void {
  accountMode = mode;
  const login = mode === "login";
  const completion = mode === "completion";
  required<HTMLHeadingElement>("h1").textContent = login
    ? "Sign in"
    : completion
      ? "Finish Account setup"
      : "Create your Account";
  passwordExplanation.textContent = login
    ? "Sign in to synchronize the encrypted Vault already owned by this Account."
    : "Your password encrypts your Account key. AWSM cannot recover it for you.";
  emailExplanation.hidden = login || completion;
  emailLabel.hidden = completion;
  passwordLabel.hidden = completion;
  confirmationLabel.hidden = login || completion;
  acknowledgementLabel.hidden = login || completion;
  choices.hidden = login;
  emailInput.disabled = completion;
  passwordInput.disabled = completion;
  confirmationInput.disabled = login || completion;
  acknowledgementInput.disabled = login || completion;
  emailInput.required = !completion;
  passwordInput.required = !completion;
  confirmationInput.required = mode === "signup";
  acknowledgementInput.required = mode === "signup";
  passwordInput.autocomplete = login ? "current-password" : "new-password";
  accountSubmit.textContent = login ? "Sign in" : completion ? "Finish setup" : "Create Account";
  accountSubmit.disabled = false;
  signInInstead.hidden = true;
  updateVaultNameRequirement();
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

async function initialize(): Promise<void> {
  const state = await sendRequest<AppState>({ type: "GetState" });
  if (state.account.configuration.mode === "Unconfigured") {
    required<HTMLHeadingElement>("h1").textContent = "Choose synchronization";
    serverChoice.hidden = false;
    form.hidden = true;
    return;
  }
  showStatus("");
  serverChoice.hidden = true;
  form.hidden = false;
  const completionMode =
    state.account.accountState === "Authenticated" &&
    state.account.vaultSyncState === "SetupRequired";
  setAccountMode(completionMode ? "completion" : "signup");
  choices.replaceChildren(document.createElement("legend"));
  const legend = choices.querySelector("legend");
  if (legend !== null) legend.textContent = "Vault to synchronize";
  choices.append(choice("new", "Create a new Vault", true));
  for (const vault of state.workspace.vaults) {
    choices.append(choice(vault.vaultId, `Use and unlock existing local Vault: ${vault.name}`));
  }
  const suggestion = await sendRequest<{ readonly name: string }>({
    type: "SuggestVaultName",
  });
  vaultNameInput.value = suggestion.name;
  updateVaultNameRequirement();
}

hostedServer.addEventListener("click", () => {
  hostedServer.disabled = true;
  showStatus("Connecting to hosted AWSM…");
  void configureServer("https://awsm.foo").catch((cause: unknown) => {
    hostedServer.disabled = false;
    showStatus(
      cause instanceof AppClientError
        ? cause.message
        : "The synchronization server could not be configured.",
      "alert",
    );
  });
});

serverForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const submit = required<HTMLButtonElement>('#server-form button[type="submit"]');
  submit.disabled = true;
  showStatus("Connecting to the synchronization server…");
  void configureServer(serverOrigin.value).catch((cause: unknown) => {
    submit.disabled = false;
    showStatus(
      cause instanceof AppClientError
        ? cause.message
        : "The synchronization server could not be configured.",
      "alert",
    );
  });
});

signInInstead.addEventListener("click", () => {
  form.hidden = false;
  setAccountMode("login");
  showStatus("Sign in with the password for this Account.");
  passwordInput.focus();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const password = String(data.get("password") ?? "");
  const confirmation = String(data.get("confirmation") ?? "");
  if (accountMode === "signup" && password !== confirmation) {
    showStatus("Passwords do not match.", "alert");
    return;
  }
  accountSubmit.disabled = true;
  showStatus(
    accountMode === "login"
      ? "Signing in…"
      : accountMode === "completion"
        ? "Preparing synchronization…"
        : "Creating Account and preparing synchronization…",
  );
  if (accountMode === "login") {
    const pending = sendRequest<AppState>({
      type: "LoginAccount",
      email: String(data.get("email") ?? ""),
      password,
    });
    passwordInput.value = "";
    void pending.then(
      (state) => {
        if (state.account.vaultSyncState === "SetupRequired") void initialize();
        else {
          showStatus("Signed in. Returning to your page…", "status", "success");
          form.hidden = true;
          window.scrollTo(0, 0);
          window.setTimeout(() => window.close(), 750);
        }
      },
      (cause: unknown) => {
        showStatus(
          cause instanceof AppClientError
            ? cause.message
            : "The Account could not be signed in safely.",
          "alert",
        );
        accountSubmit.disabled = false;
      },
    );
    return;
  }
  const selected = String(data.get("vault-choice") ?? "");
  const vaultChoice =
    selected === "new"
      ? { newVaultName: String(data.get("vault-name") ?? "") }
      : { existingVaultId: selected };
  const pending =
    accountMode === "completion"
      ? sendRequest<AppState>({ type: "CompleteAccountVault", ...vaultChoice })
      : sendRequest<AppState>({
          type: "SignupAccount",
          email: String(data.get("email") ?? ""),
          password,
          recoveryAcknowledged: true,
          ...vaultChoice,
        });
  passwordInput.value = "";
  confirmationInput.value = "";
  void pending.then(
    () => {
      showStatus(
        accountMode === "completion"
          ? "Synchronization setup complete. Returning to your page…"
          : "Account created. Returning to your page…",
        "status",
        "success",
      );
      form.hidden = true;
      window.scrollTo(0, 0);
      window.setTimeout(() => window.close(), 750);
    },
    (cause: unknown) => {
      if (cause instanceof AppClientError && cause.id === "ACCOUNT_UNAVAILABLE") {
        showStatus(cause.message, "alert");
        form.hidden = true;
        signInInstead.hidden = false;
      } else {
        showStatus(
          cause instanceof AppClientError
            ? cause.message
            : "The Account could not be created safely. Review your details and retry.",
          "alert",
        );
      }
      accountSubmit.disabled = false;
    },
  );
});

void initialize().catch(() => {
  showStatus("Local Vault choices could not be loaded.", "alert");
});
