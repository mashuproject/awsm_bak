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
            {
              vaultId: "a".repeat(64),
              label: "Research",
              lifecycle: "Open",
              access: "Authoring",
              selected: true,
            },
            {
              vaultId: "b".repeat(64),
              label: null,
              lifecycle: "Closed",
              access: "ReadOnly",
              selected: false,
            },
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
        {
          vaultId: "a".repeat(64),
          label: "Research",
          lifecycle: "Open",
          access: "Authoring",
          selected: true,
        },
        {
          vaultId: "b".repeat(64),
          label: null,
          lifecycle: "Closed",
          access: "ReadOnly",
          selected: false,
        },
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
        vaults: [
          {
            vaultId: "b".repeat(64),
            label: null,
            lifecycle: "Open",
            access: "Authoring",
            selected: true,
          },
        ],
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

  it("accepts the current Desktop Runtime Vault availability fields", async () => {
    const client = createCanonicalPopupApplicationClient({
      request: vi.fn().mockResolvedValue({
        selectedVaultId: "a".repeat(64),
        vaults: [
          {
            vaultId: "a".repeat(64),
            label: "Desktop archive",
            lifecycle: "Open",
            access: "Authoring",
            replicaAvailability: "Complete",
            missingArtifactCount: 0,
            clientCredentialId: "b".repeat(64),
            selected: true,
          },
        ],
      }),
      subscribe: vi.fn(() => () => undefined),
    });

    await expect(client.state()).resolves.toMatchObject({
      selectedVaultId: "a".repeat(64),
      vaults: [
        expect.objectContaining({
          replicaAvailability: "Complete",
          missingArtifactCount: 0,
          clientCredentialId: "b".repeat(64),
        }),
      ],
    });
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

  it("lists and creates Hosted Replicas without accepting a secret in any response", async () => {
    const transport = {
      request: vi
        .fn()
        .mockResolvedValueOnce([
          {
            remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
            name: "Hosted archive",
            endpoint: "https://sync.example.test/",
            enabled: true,
          },
        ])
        .mockResolvedValueOnce({
          remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
          name: "Hosted archive",
          endpoint: "https://sync.example.test/",
          enabled: true,
        }),
      subscribe: vi.fn(() => () => undefined),
    };
    const client = createCanonicalPopupApplicationClient(transport);
    const expectedVaultId = "a".repeat(64);

    await expect(client.listRemotes(expectedVaultId)).resolves.toEqual([
      {
        remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
        name: "Hosted archive",
        endpoint: "https://sync.example.test/",
        enabled: true,
      },
    ]);
    await expect(
      client.createHostedReplica({
        expectedVaultId,
        endpoint: "https://sync.example.test/",
        name: "Hosted archive",
        username: "archive_reader",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({
      remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
      name: "Hosted archive",
      endpoint: "https://sync.example.test/",
      enabled: true,
    });
    expect(transport.request).toHaveBeenCalledWith({ type: "ListRemotes", expectedVaultId });
    expect(transport.request).toHaveBeenLastCalledWith({
      type: "CreateHostedReplica",
      expectedVaultId,
      endpoint: "https://sync.example.test/",
      name: "Hosted archive",
      username: "archive_reader",
      password: "correct horse battery staple",
    });
  });

  it("keeps existing Hosted Replica attachment transient until one opaque replica is selected", async () => {
    const expectedVaultId = "a".repeat(64);
    const setupId = "019fa62e-a653-7f63-b2bf-94e7ed5e46cd";
    const replicaHandle = "019fa62e-a653-7f63-b2bf-94e7ed5e46cb";
    const transport = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ setupId, replicas: [{ replicaHandle, storedBytes: 4_096 }] })
        .mockResolvedValueOnce({
          remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
          name: "Existing hosted copy",
          endpoint: "https://sync.example.test/",
          enabled: true,
        })
        .mockResolvedValueOnce(null),
      subscribe: vi.fn(() => () => undefined),
    };
    const client = createCanonicalPopupApplicationClient(transport);

    await expect(
      client.beginHostedReplicaAttachment({
        expectedVaultId,
        endpoint: "https://sync.example.test/",
        name: "Existing hosted copy",
        username: "archive_reader",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ setupId, replicas: [{ replicaHandle, storedBytes: 4_096 }] });
    await expect(
      client.confirmHostedReplicaAttachment({ expectedVaultId, setupId, replicaHandle }),
    ).resolves.toMatchObject({ remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca" });
    await expect(client.cancelHostedReplicaAttachment(setupId)).resolves.toBeUndefined();
    expect(transport.request).toHaveBeenNthCalledWith(1, {
      type: "BeginHostedReplicaAttachment",
      expectedVaultId,
      endpoint: "https://sync.example.test/",
      name: "Existing hosted copy",
      username: "archive_reader",
      password: "correct horse battery staple",
    });
    expect(transport.request).toHaveBeenNthCalledWith(2, {
      type: "ConfirmHostedReplicaAttachment",
      expectedVaultId,
      setupId,
      replicaHandle,
    });
    expect(transport.request).toHaveBeenNthCalledWith(3, {
      type: "CancelHostedReplicaAttachment",
      setupId,
    });
  });

  it("renames and pauses a Hosted Replica through exact local commands", async () => {
    const remote = {
      remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
      name: "Personal archive",
      endpoint: "https://sync.example.test/",
      enabled: false,
    };
    const transport = {
      request: vi
        .fn()
        .mockResolvedValueOnce({ ...remote, enabled: true })
        .mockResolvedValueOnce(remote)
        .mockResolvedValueOnce({
          materializationLedgerCount: 1,
          pullJobCount: 2,
          quarantinedItemCount: 3,
        }),
      subscribe: vi.fn(() => () => undefined),
    };
    const client = createCanonicalPopupApplicationClient(transport);
    const expectedVaultId = "a".repeat(64);

    await expect(
      client.renameRemote({
        expectedVaultId,
        remoteId: remote.remoteId,
        name: remote.name,
      }),
    ).resolves.toEqual({ ...remote, enabled: true });
    await expect(
      client.setRemoteEnabled({
        expectedVaultId,
        remoteId: remote.remoteId,
        enabled: false,
      }),
    ).resolves.toEqual(remote);
    await expect(
      client.retireRemote({ expectedVaultId, remoteId: remote.remoteId }),
    ).resolves.toEqual({
      materializationLedgerCount: 1,
      pullJobCount: 2,
      quarantinedItemCount: 3,
    });
    expect(transport.request).toHaveBeenNthCalledWith(1, {
      type: "RenameRemote",
      expectedVaultId,
      remoteId: remote.remoteId,
      name: remote.name,
    });
    expect(transport.request).toHaveBeenNthCalledWith(2, {
      type: "SetRemoteEnabled",
      expectedVaultId,
      remoteId: remote.remoteId,
      enabled: false,
    });
    expect(transport.request).toHaveBeenNthCalledWith(3, {
      type: "RetireRemote",
      expectedVaultId,
      remoteId: remote.remoteId,
    });
  });

  it("materializes an exact selected-Vault Remote and validates the progress summary", async () => {
    const transport = {
      request: vi.fn().mockResolvedValue({
        remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
        materializedCompactItemCount: 4,
        retriedCompactItemCount: 1,
        alreadyConfirmedCompactItemCount: 2,
      }),
      subscribe: vi.fn(() => () => undefined),
    };
    const client = createCanonicalPopupApplicationClient(transport);
    const expectedVaultId = "a".repeat(64);
    const remoteId = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";

    await expect(client.materializeHostedReplica({ expectedVaultId, remoteId })).resolves.toEqual({
      remoteId,
      materializedCompactItemCount: 4,
      retriedCompactItemCount: 1,
      alreadyConfirmedCompactItemCount: 2,
    });
    expect(transport.request).toHaveBeenCalledWith({
      type: "MaterializeHostedReplica",
      expectedVaultId,
      remoteId,
    });
  });

  it("checks selected-Vault Hosted Replicas and accepts only their local outcomes", async () => {
    const transport = {
      request: vi.fn().mockResolvedValue([
        { remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca", status: "Completed" },
        { remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb", status: "Failed" },
      ]),
      subscribe: vi.fn(() => () => undefined),
    };
    const client = createCanonicalPopupApplicationClient(transport);
    const expectedVaultId = "a".repeat(64);

    await expect(client.pullHostedReplicas(expectedVaultId)).resolves.toEqual([
      { remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca", status: "Completed" },
      { remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb", status: "Failed" },
    ]);
    expect(transport.request).toHaveBeenCalledWith({ type: "PullHostedReplicas", expectedVaultId });
  });

  it("hydrates one exact selected-Vault Artifact without accepting extra response fields", async () => {
    const transport = {
      request: vi.fn().mockResolvedValue({
        artifactId: "a".repeat(64),
        storageItemId: "b".repeat(64),
        remoteId: "local",
      }),
      subscribe: vi.fn(() => () => undefined),
    };
    const client = createCanonicalPopupApplicationClient(transport);
    const expectedVaultId = "c".repeat(64);
    const artifactId = "a".repeat(64);

    await expect(client.hydrateArtifact({ expectedVaultId, artifactId })).resolves.toEqual({
      artifactId,
      storageItemId: "b".repeat(64),
      remoteId: "local",
    });
    expect(transport.request).toHaveBeenCalledWith({
      type: "HydrateArtifact",
      expectedVaultId,
      artifactId,
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
          vaults: [
            {
              vaultId: "a".repeat(64),
              label: null,
              lifecycle: "Open",
              access: "Authoring",
              selected: true,
            },
          ],
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
      vaults: [
        {
          vaultId: "a".repeat(64),
          label: null,
          lifecycle: "Open",
          access: "Authoring",
          selected: true,
        },
      ],
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

  it("recovers a fresh local Client from a Hosted closure without accepting secret output", async () => {
    const transport = {
      request: vi.fn().mockResolvedValue({
        vaultId: "a".repeat(64),
        memberId: "b".repeat(64),
        clientCredentialId: "c".repeat(64),
        eventRecordId: "d".repeat(64),
      }),
      subscribe: vi.fn(() => () => undefined),
    };
    const client = createCanonicalPopupApplicationClient(transport);

    await expect(
      client.recoverHostedMember({
        endpoint: "https://host.example/",
        username: "marin",
        password: "not persisted",
        recoveryPhrase: "twelve private words",
      }),
    ).resolves.toEqual({
      vaultId: "a".repeat(64),
      memberId: "b".repeat(64),
      clientCredentialId: "c".repeat(64),
      eventRecordId: "d".repeat(64),
    });
    expect(transport.request).toHaveBeenCalledWith({
      type: "RecoverHostedMember",
      endpoint: "https://host.example/",
      username: "marin",
      password: "not persisted",
      recoveryPhrase: "twelve private words",
    });
  });
});
