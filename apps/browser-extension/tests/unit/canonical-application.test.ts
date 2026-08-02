import { describe, expect, it, vi } from "vitest";

import { CanonicalApplication } from "../../src/app/canonical-application";

describe("canonical application", () => {
  it("accepts only exact current application Commands and delegates Vault creation with local asserted time", async () => {
    const runtime = {
      state: vi.fn().mockResolvedValue({ selectedVaultId: undefined, vaults: [] }),
      beginVaultCreation: vi.fn().mockResolvedValue({ setupId: "setup", recoveryPhrase: "phrase" }),
      confirmVaultCreation: vi.fn(),
      cancelVaultCreation: vi.fn(),
      selectVault: vi.fn(),
      listLibrary: vi.fn(),
    };
    const application = new CanonicalApplication(runtime, () => 1234);

    await expect(application.handle({ type: "GetState" })).resolves.toEqual({
      selectedVaultId: undefined,
      vaults: [],
    });
    await expect(
      application.handle({
        type: "BeginVaultCreation",
        expectedVaultId: null,
        label: "Research",
      }),
    ).resolves.toEqual({ setupId: "setup", recoveryPhrase: "phrase" });
    expect(runtime.beginVaultCreation).toHaveBeenCalledWith({
      expectedVaultId: null,
      label: "Research",
      assertedAt: 1234,
    });
    await expect(
      application.handle({
        type: "BeginVaultCreation",
        expectedVaultId: null,
        label: "Research",
        extra: true,
      }),
    ).rejects.toThrow(/Unsupported application Command/u);
  });

  it("keeps select, confirmation, cancellation, and Library reads fenced to the stated Vault", async () => {
    const runtime = {
      state: vi.fn(),
      beginVaultCreation: vi.fn(),
      confirmVaultCreation: vi.fn().mockResolvedValue({ vaultId: "a".repeat(64) }),
      cancelVaultCreation: vi.fn().mockResolvedValue(undefined),
      selectVault: vi.fn().mockResolvedValue({ selectedVaultId: "b".repeat(64), vaults: [] }),
      listLibrary: vi.fn().mockResolvedValue([]),
    };
    const application = new CanonicalApplication(runtime, () => 1234);
    const expectedVaultId = "a".repeat(64);

    await application.handle({
      type: "ConfirmVaultCreation",
      setupId: "setup",
      recoveryPhrase: "phrase",
    });
    await application.handle({ type: "CancelVaultCreation", setupId: "setup" });
    await application.handle({
      type: "SelectVault",
      expectedVaultId,
      vaultId: "b".repeat(64),
    });
    await application.handle({ type: "ListLibrary", expectedVaultId });

    expect(runtime.confirmVaultCreation).toHaveBeenCalledWith({
      setupId: "setup",
      recoveryPhrase: "phrase",
    });
    expect(runtime.cancelVaultCreation).toHaveBeenCalledWith("setup");
    expect(runtime.selectVault).toHaveBeenCalledWith({ expectedVaultId, vaultId: "b".repeat(64) });
    expect(runtime.listLibrary).toHaveBeenCalledWith(expectedVaultId);
  });
});
