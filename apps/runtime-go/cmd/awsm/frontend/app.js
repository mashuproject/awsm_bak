const status = document.querySelector("#status");
const vaultPanel = document.querySelector("#vault");
const management = document.querySelector("#management");
let pendingCreation;

function binding() {
  return globalThis.go?.main?.desktopBinding;
}

function button(label, handler, className = "") {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  if (className !== "") control.className = className;
  control.addEventListener("click", async () => {
    control.disabled = true;
    try {
      await handler();
    } catch (error) {
      showError(error);
    } finally {
      control.disabled = false;
    }
  });
  return control;
}

function showError(error) {
  const message = error instanceof Error ? error.message : "The action failed.";
  const node = document.createElement("p");
  node.className = "error";
  node.setAttribute("role", "alert");
  node.textContent = message;
  vaultPanel.replaceChildren(node);
}

function text(message, className = "") {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = message;
  return node;
}

async function command(request) {
  const bridge = binding();
  if (bridge?.VaultCommand === undefined) throw new Error("Vault management is unavailable.");
  return bridge.VaultCommand(request);
}

function formField(labelText, type = "text") {
  const label = document.createElement("label");
  label.append(text(labelText));
  const input = document.createElement("input");
  input.type = type;
  input.autocomplete = "off";
  input.required = true;
  label.append(input);
  return { label, input };
}

async function renderCreation() {
  vaultPanel.replaceChildren(
    text("Create a Vault", "muted"),
    pendingCreation.recoveryPhrase === undefined
      ? text(
          "A Vault creation is already in progress. The Recovery Phrase is not stored by this Client; enter the phrase you recorded or cancel this setup.",
          "warning",
        )
      : text(
          "Write this Recovery Phrase down somewhere safe. Anyone who has it can access the Vault.",
          "warning",
        ),
  );
  if (pendingCreation.recoveryPhrase !== undefined) {
    const phrase = document.createElement("textarea");
    phrase.readOnly = true;
    phrase.rows = 3;
    phrase.value = pendingCreation.recoveryPhrase;
    phrase.setAttribute("aria-label", "Recovery Phrase");
    vaultPanel.append(phrase);
  }
  const form = document.createElement("form");
  const confirmation = formField("Type the Recovery Phrase to continue");
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    button("Cancel", async () => {
      await command({ type: "CancelVaultCreation", setupId: pendingCreation.setupId });
      pendingCreation = undefined;
      await renderVault();
    }, "quiet"),
  );
  const confirm = button("Confirm Recovery Phrase", async () => undefined);
  confirm.type = "submit";
  actions.append(confirm);
  form.append(confirmation.label, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    confirm.disabled = true;
    try {
      await command({
        type: "ConfirmVaultCreation",
        setupId: pendingCreation.setupId,
        recoveryPhrase: confirmation.input.value,
      });
      pendingCreation = undefined;
      await renderVault();
    } catch (error) {
      showError(error);
    } finally {
      confirm.disabled = false;
    }
  });
  vaultPanel.append(form);
}

async function renderCreateForm(state) {
  const section = document.createElement("div");
  section.append(text("Create a Vault on this desktop Client."));
  const form = document.createElement("form");
  const name = formField("Vault name");
  name.input.placeholder = "Personal archive";
  const submit = button("Create Vault", async () => undefined);
  submit.type = "submit";
  form.append(name.label, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      pendingCreation = await command({
        type: "BeginVaultCreation",
        expectedVaultId: state.selectedVaultId ?? null,
        label: name.input.value.trim() === "" ? null : name.input.value.trim(),
      });
      await renderCreation();
    } catch (error) {
      showError(error);
    } finally {
      submit.disabled = false;
    }
  });
  section.append(form);
  vaultPanel.append(section);
}

function renderVaultList(state) {
  const list = document.createElement("ul");
  list.className = "vault-list";
  for (const vault of state.vaults) {
    const item = document.createElement("li");
    if (vault.selected) item.className = "selected";
    item.append(
      text(vault.label ?? "Untitled Vault"),
      text(`${vault.lifecycle} · ${vault.access}`, "muted"),
    );
    if (!vault.selected) {
      item.append(button("Use Vault", async () => {
        await command({
          type: "SelectVault",
          expectedVaultId: state.selectedVaultId ?? null,
          vaultId: vault.vaultId,
        });
        await renderVault();
      }, "quiet"));
    }
    list.append(item);
  }
  return list;
}

async function renderLibrary(vaultId, parent) {
  const heading = document.createElement("h3");
  heading.textContent = "Library";
  parent.append(heading);
  const library = await command({ type: "ListLibrary", expectedVaultId: vaultId });
  if (!Array.isArray(library) || library.length === 0) {
    parent.append(text("No captures are stored in this Vault yet. Capture is available for extension-owned local Vaults; the desktop-owned Capture Bundle bridge is not implemented.", "muted"));
    return;
  }
  const list = document.createElement("ul");
  list.className = "library-list";
  for (const item of library) {
    const row = document.createElement("li");
    row.append(text(item.title ?? item.finalUrl), text(item.availableLocally ? "Available locally" : "Needs hydration", "muted"));
    list.append(row);
  }
  parent.append(list);
}

async function renderRemotes(vaultId, parent) {
  const heading = document.createElement("h3");
  heading.textContent = "Hosted Replicas";
  parent.append(heading);
  const remotes = await command({ type: "ListRemotes", expectedVaultId: vaultId });
  if (!Array.isArray(remotes) || remotes.length === 0) {
    parent.append(text("No Hosted Replicas are configured on this Client.", "muted"));
  } else {
    const list = document.createElement("ul");
    list.className = "remote-list";
    for (const remote of remotes) {
      const row = document.createElement("li");
      row.append(text(remote.name), text(`${remote.endpoint} · ${remote.enabled ? "Enabled" : "Paused"}`, "muted"));
      row.append(button(remote.enabled ? "Pause" : "Resume", async () => {
        await command({ type: "SetRemoteEnabled", expectedVaultId: vaultId, remoteId: remote.remoteId, enabled: !remote.enabled });
        await renderVault();
      }, "quiet"));
      list.append(row);
    }
    parent.append(list);
  }

  const form = document.createElement("form");
  const endpoint = formField("Hosted Replica HTTPS address", "url");
  const name = formField("Hosted Replica name");
  const username = formField("Account username");
  const password = formField("Account password", "password");
  const submit = button("Save Hosted Replica", async () => undefined);
  submit.type = "submit";
  form.append(endpoint.label, name.label, username.label, password.label, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await command({
        type: "CreateHostedReplica",
        expectedVaultId: vaultId,
        endpoint: endpoint.input.value,
        name: name.input.value,
        username: username.input.value,
        password: password.input.value,
      });
      password.input.value = "";
      await renderVault();
    } catch (error) {
      showError(error);
    } finally {
      submit.disabled = false;
    }
  });
  parent.append(
    text(
      "This desktop Client records the configuration. Hosted Replica synchronization is not available in this Runtime slice yet.",
      "muted",
    ),
    form,
  );
}

async function runPhraseAction(type, vaultId) {
  const setup = await command({ type, expectedVaultId: vaultId });
  window.alert(`Write this Recovery Phrase down before continuing:\n\n${setup.recoveryPhrase}`);
  const phrase = window.prompt("Type the Recovery Phrase to confirm");
  if (phrase === null) {
    const cancelType = type === "BeginVaultFork" ? "CancelVaultFork" : "CancelRecoveryPhraseReplacement";
    await command({ type: cancelType, setupId: setup.setupId });
    return;
  }
  const confirmType = type === "BeginVaultFork" ? "ConfirmVaultFork" : "ConfirmRecoveryPhraseReplacement";
  await command({ type: confirmType, setupId: setup.setupId, recoveryPhrase: phrase });
  await renderVault();
}

async function renderSelectedVault(state, parent) {
  if (state.selectedVaultId === undefined) {
    parent.append(text("Select a Vault to manage it.", "muted"));
    return;
  }
  const vault = state.vaults.find((candidate) => candidate.vaultId === state.selectedVaultId);
  if (vault === undefined) return;
  parent.append(text(`${vault.label ?? "Untitled Vault"} · ${vault.lifecycle} · ${vault.access}`));
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    button("Fork this Vault", () => runPhraseAction("BeginVaultFork", vault.vaultId), "quiet"),
    button("Change Recovery Phrase", () => runPhraseAction("BeginRecoveryPhraseReplacement", vault.vaultId), "quiet"),
  );
  if (vault.lifecycle === "Open") {
    actions.append(
      button("Vacuum this Vault", async () => {
        if (window.confirm("Vacuum creates a new baseline. Continue?")) {
          await command({ type: "VacuumVault", expectedVaultId: vault.vaultId });
          await renderVault();
        }
      }, "quiet"),
      button("Close Vault", async () => {
        if (window.confirm("Closing stops new Events in this Vault. Continue?")) {
          await command({ type: "CloseVault", expectedVaultId: vault.vaultId });
          await renderVault();
        }
      }, "danger"),
    );
  }
  parent.append(actions);
  await renderLibrary(vault.vaultId, parent);
  await renderRemotes(vault.vaultId, parent);
}

async function renderVault() {
  const bridge = binding();
  if (bridge?.VaultCommand === undefined) {
    vaultPanel.replaceChildren(text("Vault management is available in the AWSM desktop window.", "muted"));
    return;
  }
  const state = await command({ type: "GetState" });
  vaultPanel.replaceChildren();
  const title = document.createElement("h2");
  title.id = "vault-title";
  title.textContent = "Vaults";
  vaultPanel.append(title, text("Choose which encrypted Vault this desktop Client manages. Vault data is not copied into the browser extension.", "muted"));
  if (pendingCreation === undefined && state.pendingVaultCreation !== undefined) {
    pendingCreation = { setupId: state.pendingVaultCreation.setupId };
  }
  if (pendingCreation !== undefined) {
    await renderCreation();
    return;
  }
  const grid = document.createElement("div");
  grid.className = "vault-grid";
  const list = document.createElement("div");
  list.append(document.createElement("h3"), renderVaultList(state));
  list.firstChild.textContent = "Available Vaults";
  const detail = document.createElement("div");
  await renderSelectedVault(state, detail);
  grid.append(list, detail);
  vaultPanel.append(grid);
  if (state.vaults.length === 0) await renderCreateForm(state);
  else if (state.selectedVaultId === undefined) await renderCreateForm(state);
}

async function renderManagement() {
  const bridge = binding();
  const title = document.createElement("h2");
  title.id = "management-title";
  title.textContent = "Desktop Runtime";
  management.replaceChildren(title);
  if (bridge === undefined) {
    management.append(text("Pairing management is available in the AWSM desktop window.", "muted"));
    return;
  }
  const address = await bridge.RuntimeAddress();
  management.append(text(`Listening on ${address}`, "muted"));

  const pendingHeading = document.createElement("h3");
  pendingHeading.textContent = "Pending pairing requests";
  management.append(pendingHeading);
  const pending = await bridge.PendingPairings();
  if (pending.length === 0) {
    management.append(text("No pending pairing requests.", "muted"));
  } else {
    const list = document.createElement("ul");
    for (const pairing of pending) {
      const item = document.createElement("li");
      item.append(text(pairing.clientName), text(`Scopes: ${pairing.scopes.join(", ")}`, "muted"), button("Approve pairing", async () => { await bridge.ApprovePairing(pairing.pairingId); await renderManagement(); }));
      list.append(item);
    }
    management.append(list);
  }

  const grantsHeading = document.createElement("h3");
  grantsHeading.textContent = "Active grants";
  management.append(grantsHeading);
  const grants = await bridge.ListGrants();
  if (grants.length === 0) {
    management.append(text("No grants yet.", "muted"));
  } else {
    const list = document.createElement("ul");
    for (const grant of grants) {
      const item = document.createElement("li");
      item.append(text(grant.clientName), text(`Scopes: ${grant.scopes.join(", ")}`, "muted"), text(grant.revoked ? "Revoked" : "Active", "muted"));
      if (!grant.revoked) item.append(button("Revoke grant", async () => { await bridge.RevokeGrant(grant.grantId); await renderManagement(); }, "danger"));
      list.append(item);
    }
    management.append(list);
  }

  if (bridge.PendingTransfers !== undefined) {
    const transfersHeading = document.createElement("h3");
    transfersHeading.textContent = "Pending Vault moves";
    management.append(transfersHeading);
    const transfers = await bridge.PendingTransfers();
    if (transfers.length === 0) {
      management.append(text("No pending Vault moves.", "muted"));
    } else {
      const list = document.createElement("ul");
      for (const transfer of transfers) {
        const item = document.createElement("li");
        item.append(
          text(`Vault ${transfer.vaultId}`),
          text(`${transfer.byteLength} bytes · ${transfer.digest}`, "muted"),
          button("Accept move", async () => { await bridge.AcceptTransfer(transfer.transferId); await renderManagement(); await renderVault(); }),
          button("Reject move", async () => { await bridge.RejectTransfer(transfer.transferId); await renderManagement(); }, "danger"),
        );
        list.append(item);
      }
      management.append(list);
    }
  }
}

try {
  const response = await fetch("http://127.0.0.1:37373/api/awsm/runtime/health");
  const payload = await response.json();
  status.textContent = response.ok && payload.status === "ok" ? "Runtime API is ready." : "Runtime API is not ready.";
} catch {
  status.textContent = "Runtime API is unavailable.";
}

try {
  await renderVault();
} catch (error) {
  showError(error);
}

try {
  await renderManagement();
} catch (error) {
  management.replaceChildren(text(error instanceof Error ? error.message : "Management is unavailable.", "error"));
}
