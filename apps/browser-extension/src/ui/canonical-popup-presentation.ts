import type {
  CanonicalClientState,
  CanonicalClientVaultSummary,
} from "../runtime/client/canonical-runtime";

export interface CanonicalPopupRecoveryConfirmation {
  readonly setupId: string;
  readonly recoveryPhrase: string;
}

export type CanonicalPopupPresentation =
  | { readonly kind: "CreateVault" }
  | { readonly kind: "SelectVault"; readonly vaults: readonly CanonicalClientVaultSummary[] }
  | { readonly kind: "ConfirmRecoveryPhrase"; readonly recoveryPhrase: string }
  | { readonly kind: "ResumeRecoveryPhrase"; readonly setupId: string }
  | { readonly kind: "Capture"; readonly vault: CanonicalClientVaultSummary }
  | { readonly kind: "ClosedVault"; readonly vault: CanonicalClientVaultSummary };

export function canonicalPopupPresentation(
  state: CanonicalClientState,
  pendingRecoveryConfirmation?: CanonicalPopupRecoveryConfirmation,
): CanonicalPopupPresentation {
  if (pendingRecoveryConfirmation !== undefined) {
    return {
      kind: "ConfirmRecoveryPhrase",
      recoveryPhrase: pendingRecoveryConfirmation.recoveryPhrase,
    };
  }
  if (state.pendingVaultCreation !== undefined) {
    return { kind: "ResumeRecoveryPhrase", setupId: state.pendingVaultCreation.setupId };
  }
  if (state.selectedVaultId === undefined) {
    return state.vaults.length === 0
      ? { kind: "CreateVault" }
      : { kind: "SelectVault", vaults: state.vaults };
  }
  const vault = state.vaults.find(({ vaultId }) => vaultId === state.selectedVaultId);
  if (vault === undefined) throw new TypeError("Selected Vault is absent from the popup state.");
  return vault.lifecycle === "Open" ? { kind: "Capture", vault } : { kind: "ClosedVault", vault };
}
