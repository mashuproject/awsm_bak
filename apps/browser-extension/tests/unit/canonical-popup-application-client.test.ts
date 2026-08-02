import { describe, expect, it, vi } from "vitest";

import {
  CanonicalPopupApplicationClientError,
  createCanonicalPopupApplicationClient,
} from "../../src/ui/canonical-popup-application-client";

describe("canonical popup application client", () => {
  it("accepts only exact state and Library payloads", async () => {
    const client = createCanonicalPopupApplicationClient({
      request: vi
        .fn()
        .mockResolvedValueOnce({
          selectedVaultId: "a".repeat(64),
          vaults: [
            { vaultId: "a".repeat(64), label: "Research", lifecycle: "Open", selected: true },
            { vaultId: "b".repeat(64), label: null, lifecycle: "Closed", selected: false },
          ],
        })
        .mockResolvedValueOnce([
          {
            bundleId: "c".repeat(64),
            collectionId: "d".repeat(64),
            artifactId: "e".repeat(64),
            capturedAt: 1,
            originalUrl: "https://example.com/original",
            finalUrl: "https://example.com/final",
            title: "Example",
            availableLocally: true,
            lifecycle: "Active",
          },
        ]),
      subscribe: vi.fn(() => () => undefined),
    });

    await expect(client.state()).resolves.toEqual({
      selectedVaultId: "a".repeat(64),
      vaults: [
        { vaultId: "a".repeat(64), label: "Research", lifecycle: "Open", selected: true },
        { vaultId: "b".repeat(64), label: null, lifecycle: "Closed", selected: false },
      ],
    });
    await expect(client.listLibrary("a".repeat(64))).resolves.toEqual([
      {
        bundleId: "c".repeat(64),
        collectionId: "d".repeat(64),
        artifactId: "e".repeat(64),
        capturedAt: 1,
        originalUrl: "https://example.com/original",
        finalUrl: "https://example.com/final",
        title: "Example",
        availableLocally: true,
        lifecycle: "Active",
      },
    ]);
  });

  it("rejects an inconsistent selected Vault before rendering it", async () => {
    const client = createCanonicalPopupApplicationClient({
      request: vi.fn().mockResolvedValue({
        selectedVaultId: "a".repeat(64),
        vaults: [{ vaultId: "b".repeat(64), label: null, lifecycle: "Open", selected: true }],
      }),
      subscribe: vi.fn(() => () => undefined),
    });

    await expect(client.state()).rejects.toEqual(
      new CanonicalPopupApplicationClientError(
        "APPLICATION_PROTOCOL_INVALID",
        "The local application returned an invalid popup response.",
      ),
    );
  });

  it("exposes only the non-secret identity of a resumable Vault creation", async () => {
    const client = createCanonicalPopupApplicationClient({
      request: vi.fn().mockResolvedValue({
        pendingVaultCreation: {
          setupId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
          expectedVaultId: null,
        },
        vaults: [],
      }),
      subscribe: vi.fn(() => () => undefined),
    });

    await expect(client.state()).resolves.toEqual({
      pendingVaultCreation: {
        setupId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
        expectedVaultId: null,
      },
      vaults: [],
    });
  });

  it("sends only canonical popup mutations and validates their outcomes", async () => {
    const transport = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ setupId: "setup-1", recoveryPhrase: "alpha beta gamma" })
        .mockResolvedValueOnce({ vaultId: "a".repeat(64) })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          selectedVaultId: "a".repeat(64),
          vaults: [{ vaultId: "a".repeat(64), label: null, lifecycle: "Open", selected: true }],
        })
        .mockResolvedValueOnce({ bundleId: "b".repeat(64) })
        .mockResolvedValueOnce({ eventRecordId: "c".repeat(64) })
        .mockResolvedValueOnce({
          predecessorGenerationId: "d".repeat(64),
          successorGenerationId: "e".repeat(64),
          vacuumEventRecordId: "f".repeat(64),
          successorBaselineId: "0".repeat(64),
        })
        .mockResolvedValueOnce({ setupId: "fork-setup", recoveryPhrase: "delta echo foxtrot" })
        .mockResolvedValueOnce({ vaultId: "1".repeat(64) })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          memberId: "2".repeat(64),
          clientCredentialId: "3".repeat(64),
          eventRecordId: "4".repeat(64),
        })
        .mockResolvedValueOnce({
          setupId: "replacement-setup",
          recoveryPhrase: "golf hotel india",
        })
        .mockResolvedValueOnce({
          recoveryCredentialId: "5".repeat(64),
          revision: 1,
          eventRecordId: "6".repeat(64),
        })
        .mockResolvedValueOnce(null),
      subscribe: vi.fn(() => () => undefined),
    };
    const client = createCanonicalPopupApplicationClient(transport);

    await expect(
      client.beginVaultCreation({ expectedVaultId: null, label: "Research" }),
    ).resolves.toEqual({
      setupId: "setup-1",
      recoveryPhrase: "alpha beta gamma",
    });
    await expect(
      client.confirmVaultCreation({ setupId: "setup-1", recoveryPhrase: "alpha beta gamma" }),
    ).resolves.toEqual({ vaultId: "a".repeat(64) });
    await expect(client.cancelVaultCreation("setup-1")).resolves.toBeUndefined();
    await expect(
      client.selectVault({ expectedVaultId: null, vaultId: "a".repeat(64) }),
    ).resolves.toEqual({
      selectedVaultId: "a".repeat(64),
      vaults: [{ vaultId: "a".repeat(64), label: null, lifecycle: "Open", selected: true }],
    });
    await expect(
      client.captureActivePage({ expectedVaultId: "a".repeat(64), tabId: 4 }),
    ).resolves.toEqual({
      bundleId: "b".repeat(64),
    });
    await expect(client.closeVault("a".repeat(64))).resolves.toEqual({
      eventRecordId: "c".repeat(64),
    });
    await expect(client.vacuumVault("a".repeat(64))).resolves.toEqual({
      predecessorGenerationId: "d".repeat(64),
      successorGenerationId: "e".repeat(64),
      vacuumEventRecordId: "f".repeat(64),
      successorBaselineId: "0".repeat(64),
    });
    await expect(client.beginVaultFork("a".repeat(64))).resolves.toEqual({
      setupId: "fork-setup",
      recoveryPhrase: "delta echo foxtrot",
    });
    await expect(
      client.confirmVaultFork({ setupId: "fork-setup", recoveryPhrase: "delta echo foxtrot" }),
    ).resolves.toEqual({ vaultId: "1".repeat(64) });
    await expect(client.cancelVaultFork("fork-setup")).resolves.toBeUndefined();
    await expect(
      client.recoverMember({ expectedVaultId: "a".repeat(64), recoveryPhrase: "alpha beta gamma" }),
    ).resolves.toEqual({
      memberId: "2".repeat(64),
      clientCredentialId: "3".repeat(64),
      eventRecordId: "4".repeat(64),
    });
    await expect(client.beginRecoveryPhraseReplacement("a".repeat(64))).resolves.toEqual({
      setupId: "replacement-setup",
      recoveryPhrase: "golf hotel india",
    });
    await expect(
      client.confirmRecoveryPhraseReplacement({
        setupId: "replacement-setup",
        recoveryPhrase: "golf hotel india",
      }),
    ).resolves.toEqual({
      recoveryCredentialId: "5".repeat(64),
      revision: 1,
      eventRecordId: "6".repeat(64),
    });
    await expect(
      client.cancelRecoveryPhraseReplacement("replacement-setup"),
    ).resolves.toBeUndefined();

    expect(transport.request.mock.calls).toEqual([
      [{ type: "BeginVaultCreation", expectedVaultId: null, label: "Research" }],
      [{ type: "ConfirmVaultCreation", setupId: "setup-1", recoveryPhrase: "alpha beta gamma" }],
      [{ type: "CancelVaultCreation", setupId: "setup-1" }],
      [{ type: "SelectVault", expectedVaultId: null, vaultId: "a".repeat(64) }],
      [{ type: "CaptureActivePage", expectedVaultId: "a".repeat(64), tabId: 4 }],
      [{ type: "CloseVault", expectedVaultId: "a".repeat(64) }],
      [{ type: "VacuumVault", expectedVaultId: "a".repeat(64) }],
      [{ type: "BeginVaultFork", expectedVaultId: "a".repeat(64) }],
      [{ type: "ConfirmVaultFork", setupId: "fork-setup", recoveryPhrase: "delta echo foxtrot" }],
      [{ type: "CancelVaultFork", setupId: "fork-setup" }],
      [
        {
          type: "RecoverMember",
          expectedVaultId: "a".repeat(64),
          recoveryPhrase: "alpha beta gamma",
        },
      ],
      [{ type: "BeginRecoveryPhraseReplacement", expectedVaultId: "a".repeat(64) }],
      [
        {
          type: "ConfirmRecoveryPhraseReplacement",
          setupId: "replacement-setup",
          recoveryPhrase: "golf hotel india",
        },
      ],
      [{ type: "CancelRecoveryPhraseReplacement", setupId: "replacement-setup" }],
    ]);
  });
});
