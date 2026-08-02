import { describe, expect, it } from "vitest";

import { canonicalPopupPresentation } from "../../src/ui/canonical-popup-presentation";

describe("canonical popup presentation", () => {
  it("makes local Vault creation the first-use task", () => {
    expect(canonicalPopupPresentation({ vaults: [] })).toEqual({ kind: "CreateVault" });
  });

  it("requires a Vault selection before Capture when no Vault is selected", () => {
    expect(
      canonicalPopupPresentation({
        vaults: [
          {
            vaultId: "a".repeat(64),
            label: "Research",
            lifecycle: "Open",
            access: "Authoring",
            selected: false,
          },
        ],
      }),
    ).toEqual({
      kind: "SelectVault",
      vaults: [
        {
          vaultId: "a".repeat(64),
          label: "Research",
          lifecycle: "Open",
          access: "Authoring",
          selected: false,
        },
      ],
    });
  });

  it("keeps the Recovery Phrase confirmation distinct from ordinary Capture", () => {
    expect(
      canonicalPopupPresentation(
        {
          selectedVaultId: "a".repeat(64),
          vaults: [
            {
              vaultId: "a".repeat(64),
              label: "Research",
              lifecycle: "Open",
              access: "Authoring",
              selected: true,
            },
          ],
        },
        { setupId: "setup-1", recoveryPhrase: "alpha beta gamma" },
      ),
    ).toEqual({ kind: "ConfirmRecoveryPhrase", recoveryPhrase: "alpha beta gamma" });
  });

  it("asks for the phrase again when a durable creation is resumed", () => {
    expect(
      canonicalPopupPresentation({
        pendingVaultCreation: {
          setupId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
          expectedVaultId: null,
        },
        vaults: [],
      }),
    ).toEqual({ kind: "ResumeRecoveryPhrase", setupId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca" });
  });

  it("presents the selected Vault and its current Library for Capture", () => {
    expect(
      canonicalPopupPresentation({
        selectedVaultId: "a".repeat(64),
        vaults: [
          {
            vaultId: "a".repeat(64),
            label: "Research",
            lifecycle: "Open",
            access: "Authoring",
            selected: true,
          },
        ],
      }),
    ).toEqual({
      kind: "Capture",
      vault: {
        vaultId: "a".repeat(64),
        label: "Research",
        lifecycle: "Open",
        access: "Authoring",
        selected: true,
      },
    });
  });

  it("presents a selected closed Vault without offering Capture", () => {
    expect(
      canonicalPopupPresentation({
        selectedVaultId: "a".repeat(64),
        vaults: [
          {
            vaultId: "a".repeat(64),
            label: "Research",
            lifecycle: "Closed",
            access: "Authoring",
            selected: true,
          },
        ],
      }),
    ).toEqual({
      kind: "ClosedVault",
      vault: {
        vaultId: "a".repeat(64),
        label: "Research",
        lifecycle: "Closed",
        access: "Authoring",
        selected: true,
      },
    });
  });

  it("asks a readable Replica to recover local authoring access before Capture", () => {
    expect(
      canonicalPopupPresentation({
        selectedVaultId: "a".repeat(64),
        vaults: [
          {
            vaultId: "a".repeat(64),
            label: "Research",
            lifecycle: "Open",
            access: "ReadOnly",
            selected: true,
          },
        ],
      }),
    ).toEqual({
      kind: "RecoverAccess",
      vault: {
        vaultId: "a".repeat(64),
        label: "Research",
        lifecycle: "Open",
        access: "ReadOnly",
        selected: true,
      },
    });
  });
});
