import type { CanonicalApplicationRequest } from "../app/canonical-application";
import type {
  CanonicalClientArtifactHydrationSummary,
  CanonicalClientLibraryItem,
  CanonicalClientRemoteMaterializationSummary,
  CanonicalClientRemotePullSummary,
  CanonicalClientRemoteSummary,
  CanonicalClientState,
  CanonicalClientVaultSummary,
} from "../runtime/client/canonical-runtime";
import type { CanonicalPopupClient } from "./canonical-popup-controller";

export class CanonicalPopupApplicationClientError extends Error {
  readonly id: string;

  constructor(id: string, message: string) {
    super(message);
    this.name = "CanonicalPopupApplicationClientError";
    this.id = id;
  }
}

interface CanonicalPopupApplicationTransport {
  request(request: CanonicalApplicationRequest): Promise<unknown>;
  subscribe(listener: () => void): () => void;
}

export interface CanonicalPopupApplicationClient extends CanonicalPopupClient {
  beginVaultCreation(input: {
    readonly expectedVaultId: string | null;
    readonly label: string | null;
  }): Promise<{ readonly setupId: string; readonly recoveryPhrase: string }>;
  confirmVaultCreation(input: {
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }): Promise<{ readonly vaultId: string }>;
  cancelVaultCreation(setupId: string): Promise<void>;
  beginVaultFork(expectedVaultId: string): Promise<{
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }>;
  confirmVaultFork(input: {
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }): Promise<{ readonly vaultId: string }>;
  cancelVaultFork(setupId: string): Promise<void>;
  recoverMember(input: {
    readonly expectedVaultId: string;
    readonly recoveryPhrase: string;
  }): Promise<{
    readonly memberId: string;
    readonly clientCredentialId: string;
    readonly eventRecordId: string;
  }>;
  beginRecoveryPhraseReplacement(expectedVaultId: string): Promise<{
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }>;
  confirmRecoveryPhraseReplacement(input: {
    readonly setupId: string;
    readonly recoveryPhrase: string;
  }): Promise<{
    readonly recoveryCredentialId: string;
    readonly revision: number;
    readonly eventRecordId: string;
  }>;
  cancelRecoveryPhraseReplacement(setupId: string): Promise<void>;
  selectVault(input: {
    readonly expectedVaultId: string | null;
    readonly vaultId: string;
  }): Promise<CanonicalClientState>;
  captureActivePage(input: {
    readonly expectedVaultId: string;
    readonly tabId?: number;
  }): Promise<{ readonly bundleId: string }>;
  closeVault(expectedVaultId: string): Promise<{ readonly eventRecordId: string }>;
  vacuumVault(expectedVaultId: string): Promise<{
    readonly predecessorGenerationId: string;
    readonly successorGenerationId: string;
    readonly vacuumEventRecordId: string;
    readonly successorBaselineId: string;
  }>;
  listRemotes(expectedVaultId: string): Promise<readonly CanonicalClientRemoteSummary[]>;
  createHostedReplica(input: {
    readonly expectedVaultId: string;
    readonly endpoint: string;
    readonly name: string;
    readonly username: string;
    readonly password: string;
  }): Promise<CanonicalClientRemoteSummary>;
  materializeHostedReplica(input: {
    readonly expectedVaultId: string;
    readonly remoteId: string;
  }): Promise<CanonicalClientRemoteMaterializationSummary>;
  pullHostedReplicas(expectedVaultId: string): Promise<readonly CanonicalClientRemotePullSummary[]>;
  hydrateArtifact(input: {
    readonly expectedVaultId: string;
    readonly artifactId: string;
  }): Promise<CanonicalClientArtifactHydrationSummary>;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function setupId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeTimestamp(value: unknown): value is number | bigint {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "bigint" && value >= 0n)
  );
}

function httpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function hostedEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      parsed.href === value
    );
  } catch {
    return false;
  }
}

function protocolError(): CanonicalPopupApplicationClientError {
  return new CanonicalPopupApplicationClientError(
    "APPLICATION_PROTOCOL_INVALID",
    "The local application returned an invalid popup response.",
  );
}

function decodeVaultSummary(value: unknown): CanonicalClientVaultSummary {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["vaultId", "label", "lifecycle", "access", "selected"]) ||
    !identifier(value.vaultId) ||
    !(value.label === null || typeof value.label === "string") ||
    !(value.lifecycle === "Open" || value.lifecycle === "Closed") ||
    !(value.access === "Authoring" || value.access === "ReadOnly") ||
    typeof value.selected !== "boolean"
  ) {
    throw protocolError();
  }
  return {
    vaultId: value.vaultId,
    label: value.label,
    lifecycle: value.lifecycle,
    access: value.access,
    selected: value.selected,
  };
}

function decodeState(value: unknown): CanonicalClientState {
  if (
    !plainRecord(value) ||
    ![1, 2, 3].includes(Object.keys(value).length) ||
    !Array.isArray(value.vaults)
  ) {
    throw protocolError();
  }
  const hasSelectedVault = Object.hasOwn(value, "selectedVaultId");
  const hasPendingCreation = Object.hasOwn(value, "pendingVaultCreation");
  const pendingCreation = plainRecord(value.pendingVaultCreation)
    ? value.pendingVaultCreation
    : undefined;
  if (
    !exactKeys(value, [
      "vaults",
      ...(hasSelectedVault ? ["selectedVaultId"] : []),
      ...(hasPendingCreation ? ["pendingVaultCreation"] : []),
    ]) ||
    (hasSelectedVault && !identifier(value.selectedVaultId)) ||
    (hasPendingCreation &&
      (pendingCreation === undefined ||
        !exactKeys(pendingCreation, ["setupId", "expectedVaultId"]) ||
        !setupId(pendingCreation.setupId) ||
        !(pendingCreation.expectedVaultId === null || identifier(pendingCreation.expectedVaultId))))
  ) {
    throw protocolError();
  }
  const vaults = value.vaults.map(decodeVaultSummary);
  if (new Set(vaults.map(({ vaultId }) => vaultId)).size !== vaults.length) throw protocolError();
  const selected = vaults.filter((vault) => vault.selected);
  if (
    selected.length > 1 ||
    (hasSelectedVault &&
      (selected.length !== 1 || selected[0]?.vaultId !== value.selectedVaultId)) ||
    (!hasSelectedVault && selected.length !== 0)
  ) {
    throw protocolError();
  }
  return {
    ...(hasSelectedVault ? { selectedVaultId: value.selectedVaultId as string } : {}),
    ...(pendingCreation === undefined
      ? {}
      : {
          pendingVaultCreation: {
            setupId: pendingCreation.setupId as string,
            expectedVaultId: pendingCreation.expectedVaultId as string | null,
          },
        }),
    vaults,
  };
}

function decodeLibraryItem(value: unknown): CanonicalClientLibraryItem {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "bundleId",
      "collectionId",
      "artifactId",
      "capturedAt",
      "originalUrl",
      "finalUrl",
      "title",
      "availableLocally",
      "lifecycle",
    ]) ||
    !identifier(value.bundleId) ||
    !identifier(value.collectionId) ||
    !identifier(value.artifactId) ||
    !safeTimestamp(value.capturedAt) ||
    !httpUrl(value.originalUrl) ||
    !httpUrl(value.finalUrl) ||
    !(value.title === null || typeof value.title === "string") ||
    typeof value.availableLocally !== "boolean" ||
    !(value.lifecycle === "Active" || value.lifecycle === "Deleted")
  ) {
    throw protocolError();
  }
  return {
    bundleId: value.bundleId,
    collectionId: value.collectionId,
    artifactId: value.artifactId,
    capturedAt: value.capturedAt,
    originalUrl: value.originalUrl,
    finalUrl: value.finalUrl,
    title: value.title,
    availableLocally: value.availableLocally,
    lifecycle: value.lifecycle,
  };
}

function decodeLibrary(value: unknown): readonly CanonicalClientLibraryItem[] {
  if (!Array.isArray(value)) throw protocolError();
  const library = value.map(decodeLibraryItem);
  if (new Set(library.map(({ bundleId }) => bundleId)).size !== library.length)
    throw protocolError();
  return library;
}

function decodeRemoteSummary(value: unknown): CanonicalClientRemoteSummary {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["remoteId", "name", "endpoint", "enabled"]) ||
    !setupId(value.remoteId) ||
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    value.name.length > 256 ||
    !hostedEndpoint(value.endpoint) ||
    typeof value.enabled !== "boolean"
  ) {
    throw protocolError();
  }
  return {
    remoteId: value.remoteId,
    name: value.name,
    endpoint: value.endpoint,
    enabled: value.enabled,
  };
}

function decodeRemotes(value: unknown): readonly CanonicalClientRemoteSummary[] {
  if (!Array.isArray(value)) throw protocolError();
  const remotes = value.map(decodeRemoteSummary);
  if (new Set(remotes.map(({ remoteId }) => remoteId)).size !== remotes.length)
    throw protocolError();
  return remotes;
}

function decodeHostedReplicaMaterialization(
  value: unknown,
): CanonicalClientRemoteMaterializationSummary {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "remoteId",
      "materializedCompactItemCount",
      "retriedCompactItemCount",
      "alreadyConfirmedCompactItemCount",
    ]) ||
    !setupId(value.remoteId) ||
    !nonnegativeInteger(value.materializedCompactItemCount) ||
    !nonnegativeInteger(value.retriedCompactItemCount) ||
    !nonnegativeInteger(value.alreadyConfirmedCompactItemCount)
  ) {
    throw protocolError();
  }
  return {
    remoteId: value.remoteId,
    materializedCompactItemCount: value.materializedCompactItemCount,
    retriedCompactItemCount: value.retriedCompactItemCount,
    alreadyConfirmedCompactItemCount: value.alreadyConfirmedCompactItemCount,
  };
}

function decodeHostedReplicaPull(value: unknown): readonly CanonicalClientRemotePullSummary[] {
  if (!Array.isArray(value)) throw protocolError();
  const results = value.map((result) => {
    if (
      !plainRecord(result) ||
      !exactKeys(result, ["remoteId", "status"]) ||
      !setupId(result.remoteId) ||
      typeof result.status !== "string" ||
      !["Disabled", "Failed", "Active", "Completed", "Waiting"].includes(result.status)
    ) {
      throw protocolError();
    }
    return {
      remoteId: result.remoteId,
      status: result.status as CanonicalClientRemotePullSummary["status"],
    };
  });
  if (new Set(results.map(({ remoteId }) => remoteId)).size !== results.length) {
    throw protocolError();
  }
  return results;
}

function decodeArtifactHydration(value: unknown): CanonicalClientArtifactHydrationSummary {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["artifactId", "storageItemId", "remoteId"]) ||
    !identifier(value.artifactId) ||
    !identifier(value.storageItemId) ||
    !(value.remoteId === "local" || setupId(value.remoteId))
  ) {
    throw protocolError();
  }
  return {
    artifactId: value.artifactId,
    storageItemId: value.storageItemId,
    remoteId: value.remoteId,
  };
}

function decodeVaultCreation(value: unknown): {
  readonly setupId: string;
  readonly recoveryPhrase: string;
} {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["setupId", "recoveryPhrase"]) ||
    typeof value.setupId !== "string" ||
    value.setupId.length < 1 ||
    value.setupId.length > 128 ||
    typeof value.recoveryPhrase !== "string" ||
    value.recoveryPhrase.length < 1 ||
    value.recoveryPhrase.length > 1_024
  ) {
    throw protocolError();
  }
  return { setupId: value.setupId, recoveryPhrase: value.recoveryPhrase };
}

function decodeCapture(value: unknown): { readonly bundleId: string } {
  if (!plainRecord(value) || !exactKeys(value, ["bundleId"]) || !identifier(value.bundleId)) {
    throw protocolError();
  }
  return { bundleId: value.bundleId };
}

function decodeVaultCreated(value: unknown): { readonly vaultId: string } {
  if (!plainRecord(value) || !exactKeys(value, ["vaultId"]) || !identifier(value.vaultId)) {
    throw protocolError();
  }
  return { vaultId: value.vaultId };
}

function decodeVaultClosed(value: unknown): { readonly eventRecordId: string } {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["eventRecordId"]) ||
    !identifier(value.eventRecordId)
  ) {
    throw protocolError();
  }
  return { eventRecordId: value.eventRecordId };
}

function decodeVaultVacuumed(value: unknown): {
  readonly predecessorGenerationId: string;
  readonly successorGenerationId: string;
  readonly vacuumEventRecordId: string;
  readonly successorBaselineId: string;
} {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "predecessorGenerationId",
      "successorGenerationId",
      "successorBaselineId",
      "vacuumEventRecordId",
    ]) ||
    !identifier(value.predecessorGenerationId) ||
    !identifier(value.successorGenerationId) ||
    !identifier(value.vacuumEventRecordId) ||
    !identifier(value.successorBaselineId)
  ) {
    throw protocolError();
  }
  return {
    predecessorGenerationId: value.predecessorGenerationId,
    successorGenerationId: value.successorGenerationId,
    vacuumEventRecordId: value.vacuumEventRecordId,
    successorBaselineId: value.successorBaselineId,
  };
}

function decodeMemberRecovered(value: unknown): {
  readonly memberId: string;
  readonly clientCredentialId: string;
  readonly eventRecordId: string;
} {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["memberId", "clientCredentialId", "eventRecordId"]) ||
    !identifier(value.memberId) ||
    !identifier(value.clientCredentialId) ||
    !identifier(value.eventRecordId)
  ) {
    throw protocolError();
  }
  return {
    memberId: value.memberId,
    clientCredentialId: value.clientCredentialId,
    eventRecordId: value.eventRecordId,
  };
}

function decodeRecoveryPhraseReplaced(value: unknown): {
  readonly recoveryCredentialId: string;
  readonly revision: number;
  readonly eventRecordId: string;
} {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["recoveryCredentialId", "revision", "eventRecordId"]) ||
    !identifier(value.recoveryCredentialId) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !identifier(value.eventRecordId)
  ) {
    throw protocolError();
  }
  return {
    recoveryCredentialId: value.recoveryCredentialId,
    revision: value.revision,
    eventRecordId: value.eventRecordId,
  };
}

function assertNullableVaultId(value: string | null): void {
  if (value !== null && !identifier(value))
    throw new TypeError("Popup expected Vault ID is invalid.");
}

function assertText(value: string, field: string): void {
  if (value.length < 1 || value.length > 1_024) throw new TypeError(`Popup ${field} is invalid.`);
}

function assertHostedReplicaSetup(input: {
  readonly expectedVaultId: string;
  readonly endpoint: string;
  readonly name: string;
  readonly username: string;
  readonly password: string;
}): void {
  if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
  if (!hostedEndpoint(input.endpoint))
    throw new TypeError("Popup Hosted Replica endpoint is invalid.");
  if (input.name.length < 1 || input.name.length > 256)
    throw new TypeError("Popup Hosted Replica name is invalid.");
  if (input.username.length < 1 || input.username.length > 256)
    throw new TypeError("Popup Hosted Replica username is invalid.");
  if (input.password.length < 1 || input.password.length > 1_024)
    throw new TypeError("Popup Hosted Replica password is invalid.");
}

export function createCanonicalPopupApplicationClient(
  transport: CanonicalPopupApplicationTransport,
): CanonicalPopupApplicationClient {
  return {
    async state(): Promise<CanonicalClientState> {
      return decodeState(await transport.request({ type: "GetState" }));
    },
    async listLibrary(expectedVaultId: string): Promise<readonly CanonicalClientLibraryItem[]> {
      return decodeLibrary(await transport.request({ type: "ListLibrary", expectedVaultId }));
    },
    async listRemotes(expectedVaultId: string): Promise<readonly CanonicalClientRemoteSummary[]> {
      if (!identifier(expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeRemotes(await transport.request({ type: "ListRemotes", expectedVaultId }));
    },
    subscribe(listener: () => void): () => void {
      return transport.subscribe(listener);
    },
    async beginVaultCreation(input) {
      assertNullableVaultId(input.expectedVaultId);
      if (input.label !== null && input.label.length > 1_024)
        throw new TypeError("Popup Vault label is invalid.");
      return decodeVaultCreation(
        await transport.request({
          type: "BeginVaultCreation",
          expectedVaultId: input.expectedVaultId,
          label: input.label,
        }),
      );
    },
    async confirmVaultCreation(input) {
      assertText(input.setupId, "setup ID");
      assertText(input.recoveryPhrase, "Recovery Phrase");
      return decodeVaultCreated(
        await transport.request({
          type: "ConfirmVaultCreation",
          setupId: input.setupId,
          recoveryPhrase: input.recoveryPhrase,
        }),
      );
    },
    async cancelVaultCreation(setupId) {
      assertText(setupId, "setup ID");
      const value = await transport.request({ type: "CancelVaultCreation", setupId });
      if (value !== null) throw protocolError();
    },
    async beginVaultFork(expectedVaultId) {
      if (!identifier(expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeVaultCreation(
        await transport.request({ type: "BeginVaultFork", expectedVaultId }),
      );
    },
    async confirmVaultFork(input) {
      assertText(input.setupId, "setup ID");
      assertText(input.recoveryPhrase, "Recovery Phrase");
      return decodeVaultCreated(
        await transport.request({
          type: "ConfirmVaultFork",
          setupId: input.setupId,
          recoveryPhrase: input.recoveryPhrase,
        }),
      );
    },
    async cancelVaultFork(setupId) {
      assertText(setupId, "setup ID");
      const value = await transport.request({ type: "CancelVaultFork", setupId });
      if (value !== null) throw protocolError();
    },
    async recoverMember(input) {
      if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      assertText(input.recoveryPhrase, "Recovery Phrase");
      return decodeMemberRecovered(
        await transport.request({
          type: "RecoverMember",
          expectedVaultId: input.expectedVaultId,
          recoveryPhrase: input.recoveryPhrase,
        }),
      );
    },
    async beginRecoveryPhraseReplacement(expectedVaultId) {
      if (!identifier(expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeVaultCreation(
        await transport.request({ type: "BeginRecoveryPhraseReplacement", expectedVaultId }),
      );
    },
    async confirmRecoveryPhraseReplacement(input) {
      assertText(input.setupId, "setup ID");
      assertText(input.recoveryPhrase, "Recovery Phrase");
      return decodeRecoveryPhraseReplaced(
        await transport.request({
          type: "ConfirmRecoveryPhraseReplacement",
          setupId: input.setupId,
          recoveryPhrase: input.recoveryPhrase,
        }),
      );
    },
    async cancelRecoveryPhraseReplacement(setupId) {
      assertText(setupId, "setup ID");
      const value = await transport.request({ type: "CancelRecoveryPhraseReplacement", setupId });
      if (value !== null) throw protocolError();
    },
    async selectVault(input) {
      assertNullableVaultId(input.expectedVaultId);
      if (!identifier(input.vaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeState(
        await transport.request({
          type: "SelectVault",
          expectedVaultId: input.expectedVaultId,
          vaultId: input.vaultId,
        }),
      );
    },
    async captureActivePage(input) {
      if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      if (input.tabId !== undefined && (!Number.isSafeInteger(input.tabId) || input.tabId < 0)) {
        throw new TypeError("Popup tab ID is invalid.");
      }
      return decodeCapture(
        await transport.request({
          type: "CaptureActivePage",
          expectedVaultId: input.expectedVaultId,
          ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
        }),
      );
    },
    async closeVault(expectedVaultId) {
      if (!identifier(expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeVaultClosed(await transport.request({ type: "CloseVault", expectedVaultId }));
    },
    async vacuumVault(expectedVaultId) {
      if (!identifier(expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeVaultVacuumed(await transport.request({ type: "VacuumVault", expectedVaultId }));
    },
    async createHostedReplica(input) {
      assertHostedReplicaSetup(input);
      return decodeRemoteSummary(
        await transport.request({
          type: "CreateHostedReplica",
          expectedVaultId: input.expectedVaultId,
          endpoint: input.endpoint,
          name: input.name,
          username: input.username,
          password: input.password,
        }),
      );
    },
    async materializeHostedReplica(input) {
      if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      if (!setupId(input.remoteId)) throw new TypeError("Popup Hosted Replica ID is invalid.");
      return decodeHostedReplicaMaterialization(
        await transport.request({
          type: "MaterializeHostedReplica",
          expectedVaultId: input.expectedVaultId,
          remoteId: input.remoteId,
        }),
      );
    },
    async pullHostedReplicas(expectedVaultId) {
      if (!identifier(expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      return decodeHostedReplicaPull(
        await transport.request({ type: "PullHostedReplicas", expectedVaultId }),
      );
    },
    async hydrateArtifact(input) {
      if (!identifier(input.expectedVaultId)) throw new TypeError("Popup Vault ID is invalid.");
      if (!identifier(input.artifactId)) throw new TypeError("Popup Artifact ID is invalid.");
      return decodeArtifactHydration(
        await transport.request({
          type: "HydrateArtifact",
          expectedVaultId: input.expectedVaultId,
          artifactId: input.artifactId,
        }),
      );
    },
  };
}
