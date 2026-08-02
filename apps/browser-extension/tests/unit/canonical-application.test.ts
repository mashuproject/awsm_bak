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
      capture: vi.fn(),
      closeVault: vi.fn(),
      vacuumVault: vi.fn(),
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
      capture: vi.fn(),
      closeVault: vi.fn(),
      vacuumVault: vi.fn(),
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

  it("collects a browser page only through the canonical capture Host before authoring it", async () => {
    const runtime = {
      state: vi.fn(),
      beginVaultCreation: vi.fn(),
      confirmVaultCreation: vi.fn(),
      cancelVaultCreation: vi.fn(),
      selectVault: vi.fn(),
      listLibrary: vi.fn(),
      capture: vi.fn().mockResolvedValue({ bundleId: "b".repeat(64) }),
      closeVault: vi.fn(),
      vacuumVault: vi.fn(),
    };
    const capturePage = {
      captureActivePage: vi.fn().mockResolvedValue({
        originalUrl: "https://example.test/",
        finalUrl: "https://example.test/",
        title: "Example",
        capturedAt: 1234,
        primary: { blob: new Blob(["snapshot"]) },
      }),
    };
    const application = new CanonicalApplication(
      runtime,
      () => 1234,
      capturePage,
      () => "command",
    );
    const expectedVaultId = "a".repeat(64);

    await expect(
      application.handle({ type: "CaptureActivePage", expectedVaultId, tabId: 9 }),
    ).resolves.toEqual({ bundleId: "b".repeat(64) });

    expect(capturePage.captureActivePage).toHaveBeenCalledWith(9);
    expect(runtime.capture).toHaveBeenCalledWith({
      expectedVaultId,
      commandId: "command",
      originalUrl: "https://example.test/",
      finalUrl: "https://example.test/",
      title: "Example",
      capturedAt: 1234,
      primary: { blob: expect.any(Blob) },
    });
  });

  it("authors Vault closure and Vacuum through exact lifecycle Commands", async () => {
    const runtime = {
      closeVault: vi.fn().mockResolvedValue({ eventRecordId: "c".repeat(64) }),
      vacuumVault: vi.fn().mockResolvedValue({
        predecessorGenerationId: "a".repeat(64),
        successorGenerationId: "b".repeat(64),
        vacuumEventRecordId: "c".repeat(64),
        successorBaselineId: "d".repeat(64),
      }),
    };
    const application = new CanonicalApplication(
      runtime as never,
      () => 1234,
      undefined,
      () => "command",
    );
    const expectedVaultId = "a".repeat(64);

    await expect(application.handle({ type: "CloseVault", expectedVaultId })).resolves.toEqual({
      eventRecordId: "c".repeat(64),
    });
    await expect(application.handle({ type: "VacuumVault", expectedVaultId })).resolves.toEqual({
      predecessorGenerationId: "a".repeat(64),
      successorGenerationId: "b".repeat(64),
      vacuumEventRecordId: "c".repeat(64),
      successorBaselineId: "d".repeat(64),
    });
    expect(runtime.closeVault).toHaveBeenCalledWith({
      expectedVaultId,
      commandId: "command",
      assertedAt: 1234,
    });
    expect(runtime.vacuumVault).toHaveBeenCalledWith({
      expectedVaultId,
      commandId: "command",
      assertedAt: 1234,
    });
    await expect(
      application.handle({ type: "CloseVault", expectedVaultId, extra: true }),
    ).rejects.toThrow(/Unsupported application Command/u);
  });

  it("publishes one invalidation after a successful application mutation", async () => {
    const runtime = {
      state: vi.fn(),
      beginVaultCreation: vi.fn(),
      confirmVaultCreation: vi.fn(),
      cancelVaultCreation: vi.fn(),
      selectVault: vi.fn().mockResolvedValue({ selectedVaultId: "b".repeat(64), vaults: [] }),
      listLibrary: vi.fn(),
      capture: vi.fn(),
      closeVault: vi.fn(),
      vacuumVault: vi.fn(),
    };
    const invalidated = vi.fn();
    const application = new CanonicalApplication(
      runtime,
      () => 1234,
      undefined,
      () => "command",
      invalidated,
    );

    await application.handle({
      type: "SelectVault",
      expectedVaultId: "a".repeat(64),
      vaultId: "b".repeat(64),
    });

    expect(invalidated).toHaveBeenCalledTimes(1);
  });
});
