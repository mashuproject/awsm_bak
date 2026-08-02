import { describe, expect, it } from "vitest";

import { canonicalPopupPresentation } from "../../src/ui/canonical-popup-presentation";

describe("canonical popup presentation", () => {
  it("makes local Vault creation the first-use task", () => {
    expect(canonicalPopupPresentation({ vaults: [] })).toEqual({ kind: "CreateVault" });
  });

  it("requires a Vault selection before Capture when no Vault is selected", () => {
    expect(
      canonicalPopupPresentation({
        vaults: [{ vaultId: "a".repeat(64), label: "Research", selected: false }],
      }),
    ).toEqual({
      kind: "SelectVault",
      vaults: [{ vaultId: "a".repeat(64), label: "Research", selected: false }],
    });
  });

  it("keeps the Recovery Phrase confirmation distinct from ordinary Capture", () => {
    expect(
      canonicalPopupPresentation(
        {
          selectedVaultId: "a".repeat(64),
          vaults: [{ vaultId: "a".repeat(64), label: "Research", selected: true }],
        },
        { setupId: "setup-1", recoveryPhrase: "alpha beta gamma" },
      ),
    ).toEqual({ kind: "ConfirmRecoveryPhrase", recoveryPhrase: "alpha beta gamma" });
  });

  it("presents the selected Vault and its current Library for Capture", () => {
    expect(
      canonicalPopupPresentation({
        selectedVaultId: "a".repeat(64),
        vaults: [{ vaultId: "a".repeat(64), label: "Research", selected: true }],
      }),
    ).toEqual({
      kind: "Capture",
      vault: { vaultId: "a".repeat(64), label: "Research", selected: true },
    });
  });
});
