import type { ExportJobV1, StoredVaultHeadV1 } from "../../drivers/indexeddb/schema";

function blocked(message: string): Error {
  return Object.assign(new Error(message), {
    id: "VAULT_REPLACEMENT_EXPORT_REQUIRED",
  });
}

export function assertReplacementExportGate(input: {
  readonly vaultId: string;
  readonly currentHead: StoredVaultHeadV1;
  readonly latestExport: ExportJobV1 | undefined;
  readonly safelyStoredConfirmed: boolean;
}): NonNullable<ExportJobV1["verifiedSnapshot"]> {
  const snapshot = input.latestExport?.verifiedSnapshot;
  if (
    input.latestExport?.vaultId !== input.vaultId ||
    input.latestExport.state !== "Succeeded" ||
    snapshot === undefined ||
    snapshot.coverage !== "Complete" ||
    snapshot.vaultId !== input.vaultId ||
    snapshot.generationId !== input.currentHead.generationId ||
    snapshot.generationNumber !== input.currentHead.generationNumber ||
    snapshot.appendedObjectIds.join("\n") !== input.currentHead.appendedObjectIds.join("\n") ||
    snapshot.appendedEventIds.join("\n") !== input.currentHead.appendedEventIds.join("\n")
  )
    throw blocked(
      "Create and verify a new Complete Export of the current Vault before re-encrypting it.",
    );
  if (!input.safelyStoredConfirmed)
    throw blocked(
      "Confirm that the verified Complete Export is safely stored before re-encrypting the Vault.",
    );
  return snapshot;
}
