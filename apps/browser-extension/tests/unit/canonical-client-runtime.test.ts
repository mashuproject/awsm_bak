import { describe, expect, it, vi } from "vitest";

import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
import type { CanonicalCaptureService } from "../../src/runtime/capture/canonical-service";
import { CanonicalClientRuntime } from "../../src/runtime/client/canonical-runtime";
import type { CanonicalLibraryProjectionService } from "../../src/runtime/library/canonical-projection";
import type { CanonicalVaultService } from "../../src/runtime/vault/canonical-service";

function fixture() {
  const firstVaultId = randomIdentifier("Vault");
  const secondVaultId = randomIdentifier("Vault");
  const generationId = randomIdentifier("Generation");
  const clientCredentialId = randomIdentifier("ClientCredential");
  const ceremony = {
    recoveryPhrase:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    confirm: vi.fn(async () => ({
      vaultId: secondVaultId,
      generationId,
      memberId: randomIdentifier("Member"),
      clientCredentialId,
    })),
    cancel: vi.fn(async () => undefined),
  };
  const vaults = {
    listVaults: vi.fn(async () => [
      {
        vaultId: firstVaultId,
        generationId,
        label: "First",
        selectedClientCredentialId: clientCredentialId,
        selected: true,
      },
      {
        vaultId: secondVaultId,
        generationId,
        label: null,
        selectedClientCredentialId: clientCredentialId,
        selected: false,
      },
    ]),
    beginCreate: vi.fn(async () => ceremony),
    selectVault: vi.fn(async () => undefined),
  } as unknown as CanonicalVaultService;
  const captures = { execute: vi.fn() } as unknown as CanonicalCaptureService;
  const library = { load: vi.fn() } as unknown as CanonicalLibraryProjectionService;
  let setup = 0;
  const runtime = new CanonicalClientRuntime(vaults, captures, library, () => `setup-${++setup}`);
  return { runtime, vaults, captures, library, ceremony, firstVaultId, secondVaultId };
}

describe("canonical Client Runtime", () => {
  it("presents the local Vault directory with one explicit selection", async () => {
    const { runtime, firstVaultId, secondVaultId } = fixture();

    await expect(runtime.state()).resolves.toEqual({
      selectedVaultId: identifierStorageKey(firstVaultId),
      vaults: [
        { vaultId: identifierStorageKey(firstVaultId), label: "First", selected: true },
        { vaultId: identifierStorageKey(secondVaultId), label: null, selected: false },
      ],
    });
  });

  it("keeps Recovery Phrase setup memory-only and consumes it after confirmation", async () => {
    const { runtime, ceremony, firstVaultId, secondVaultId } = fixture();
    const expectedVaultId = identifierStorageKey(firstVaultId);

    const setup = await runtime.beginVaultCreation({
      expectedVaultId,
      label: "Second",
      assertedAt: 10,
    });
    expect(setup).toEqual({ setupId: "setup-1", recoveryPhrase: ceremony.recoveryPhrase });
    await expect(
      runtime.confirmVaultCreation({
        setupId: setup.setupId,
        recoveryPhrase: ceremony.recoveryPhrase,
      }),
    ).resolves.toEqual({ vaultId: identifierStorageKey(secondVaultId) });
    await expect(
      runtime.confirmVaultCreation({
        setupId: setup.setupId,
        recoveryPhrase: ceremony.recoveryPhrase,
      }),
    ).rejects.toMatchObject({ id: "VAULT_CREATION_NOT_FOUND" });
  });

  it("rejects stale selection commands before changing the selected Vault", async () => {
    const { runtime, vaults, secondVaultId } = fixture();

    await expect(
      runtime.selectVault({
        expectedVaultId: null,
        vaultId: identifierStorageKey(secondVaultId),
      }),
    ).rejects.toMatchObject({ id: "VAULT_CONTEXT_CHANGED" });
    expect(vaults.selectVault).not.toHaveBeenCalled();
  });

  it("authors Capture only against the expected selected Vault", async () => {
    const { runtime, captures, firstVaultId } = fixture();
    const bundleId = randomIdentifier("Bundle");
    const outcome = {
      commandId: "capture-1",
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      bundleId,
      assignedCollectionId: randomIdentifier("Collection"),
      eventRecordId: randomIdentifier("VaultRecord"),
      descriptorObjectId: randomIdentifier("VaultObject"),
      artifactObjectId: randomIdentifier("VaultObject"),
      artifactStorageItemId: randomIdentifier("StorageItem"),
    };
    vi.mocked(captures.execute).mockResolvedValue(outcome);
    const primary = { blob: new Blob(["snapshot"]) };

    await expect(
      runtime.capture({
        expectedVaultId: identifierStorageKey(firstVaultId),
        commandId: "capture-1",
        originalUrl: "https://example.com/",
        finalUrl: "https://example.com/final",
        title: "Example",
        capturedAt: 10,
        primary,
      }),
    ).resolves.toEqual({ bundleId: identifierStorageKey(bundleId) });
    expect(captures.execute).toHaveBeenCalledWith({
      commandId: "capture-1",
      vaultId: firstVaultId,
      originalUrl: "https://example.com/",
      finalUrl: "https://example.com/final",
      title: "Example",
      capturedAt: 10,
      primary,
    });
  });

  it("projects a Client-safe Library view from the selected Vault", async () => {
    const { runtime, library, firstVaultId } = fixture();
    const bundleId = randomIdentifier("Bundle");
    const collectionId = randomIdentifier("Collection");
    const artifactId = randomIdentifier("Artifact");
    vi.mocked(library.load).mockResolvedValue({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      conflicts: [],
      captures: [
        {
          bundleId,
          descriptorObjectId: randomIdentifier("VaultObject"),
          assignedCollectionId: collectionId,
          currentCollectionId: collectionId,
          registrationRecordId: randomIdentifier("VaultRecord"),
          memberId: randomIdentifier("Member"),
          clientCredentialId: randomIdentifier("ClientCredential"),
          assertedAt: 10,
          capturedAt: 9,
          originalUrl: "https://example.com/",
          finalUrl: "https://example.com/final",
          title: "Example",
          profile: "awsm.capture.web-page-snapshot",
          adapter: "awsm.adapter.browser-web-page",
          artifactObjectId: randomIdentifier("VaultObject"),
          artifactId,
          artifactStorageItemId: randomIdentifier("StorageItem"),
          artifactAvailableLocally: true,
          lifecycle: 1,
        },
      ],
      collections: [],
    });

    await expect(runtime.listLibrary(identifierStorageKey(firstVaultId))).resolves.toEqual([
      {
        bundleId: identifierStorageKey(bundleId),
        collectionId: identifierStorageKey(collectionId),
        artifactId: identifierStorageKey(artifactId),
        capturedAt: 9,
        originalUrl: "https://example.com/",
        finalUrl: "https://example.com/final",
        title: "Example",
        availableLocally: true,
        lifecycle: "Active",
      },
    ]);
  });
});
