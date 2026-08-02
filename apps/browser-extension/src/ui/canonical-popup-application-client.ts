import type {
  CanonicalClientLibraryItem,
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
  request(request: {
    readonly type: "GetState" | "ListLibrary";
    readonly expectedVaultId?: string;
  }): Promise<unknown>;
  subscribe(listener: () => void): () => void;
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

function protocolError(): CanonicalPopupApplicationClientError {
  return new CanonicalPopupApplicationClientError(
    "APPLICATION_PROTOCOL_INVALID",
    "The local application returned an invalid popup response.",
  );
}

function decodeVaultSummary(value: unknown): CanonicalClientVaultSummary {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["vaultId", "label", "selected"]) ||
    !identifier(value.vaultId) ||
    !(value.label === null || typeof value.label === "string") ||
    typeof value.selected !== "boolean"
  ) {
    throw protocolError();
  }
  return { vaultId: value.vaultId, label: value.label, selected: value.selected };
}

function decodeState(value: unknown): CanonicalClientState {
  if (
    !plainRecord(value) ||
    ![1, 2].includes(Object.keys(value).length) ||
    !Array.isArray(value.vaults)
  ) {
    throw protocolError();
  }
  const hasSelectedVault = Object.hasOwn(value, "selectedVaultId");
  if (
    !exactKeys(value, hasSelectedVault ? ["selectedVaultId", "vaults"] : ["vaults"]) ||
    (hasSelectedVault && !identifier(value.selectedVaultId))
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
  return hasSelectedVault
    ? { selectedVaultId: value.selectedVaultId as string, vaults }
    : { vaults };
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

export function createCanonicalPopupApplicationClient(
  transport: CanonicalPopupApplicationTransport,
): CanonicalPopupClient {
  return {
    async state(): Promise<CanonicalClientState> {
      return decodeState(await transport.request({ type: "GetState" }));
    },
    async listLibrary(expectedVaultId: string): Promise<readonly CanonicalClientLibraryItem[]> {
      return decodeLibrary(await transport.request({ type: "ListLibrary", expectedVaultId }));
    },
    subscribe(listener: () => void): () => void {
      return transport.subscribe(listener);
    },
  };
}
