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
      listRemotes: vi.fn(),
      renameRemote: vi.fn(),
      setRemoteEnabled: vi.fn(),
      retireRemote: vi.fn(),
      createHostedReplica: vi.fn(),
      beginHostedReplicaAttachment: vi.fn(),
      confirmHostedReplicaAttachment: vi.fn(),
      cancelHostedReplicaAttachment: vi.fn(),
      materializeHostedReplica: vi.fn(),
      pullHostedReplicas: vi.fn(),
      hydrateArtifact: vi.fn(),
      capture: vi.fn(),
      closeVault: vi.fn(),
      vacuumVault: vi.fn(),
      beginVaultFork: vi.fn(),
      confirmVaultFork: vi.fn(),
      cancelVaultFork: vi.fn(),
      recoverMember: vi.fn(),
      recoverHostedMember: vi.fn(),
      beginRecoveryPhraseReplacement: vi.fn(),
      confirmRecoveryPhraseReplacement: vi.fn(),
      cancelRecoveryPhraseReplacement: vi.fn(),
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
      listRemotes: vi.fn(),
      renameRemote: vi.fn(),
      setRemoteEnabled: vi.fn(),
      retireRemote: vi.fn(),
      createHostedReplica: vi.fn(),
      beginHostedReplicaAttachment: vi.fn(),
      confirmHostedReplicaAttachment: vi.fn(),
      cancelHostedReplicaAttachment: vi.fn(),
      materializeHostedReplica: vi.fn(),
      pullHostedReplicas: vi.fn(),
      hydrateArtifact: vi.fn(),
      capture: vi.fn(),
      closeVault: vi.fn(),
      vacuumVault: vi.fn(),
      beginVaultFork: vi.fn(),
      confirmVaultFork: vi.fn(),
      cancelVaultFork: vi.fn(),
      recoverMember: vi.fn(),
      recoverHostedMember: vi.fn(),
      beginRecoveryPhraseReplacement: vi.fn(),
      confirmRecoveryPhraseReplacement: vi.fn(),
      cancelRecoveryPhraseReplacement: vi.fn(),
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

  it("routes authenticated Content Commands with a fresh command context", async () => {
    const runtime = {
      listCollections: vi.fn().mockResolvedValue([]),
      createFolder: vi.fn().mockResolvedValue({
        folderId: "b".repeat(64),
        eventRecordId: "c".repeat(64),
      }),
    };
    const application = new CanonicalApplication(
      runtime as never,
      () => 1234,
      undefined,
      () => "command-id",
    );
    const expectedVaultId = "a".repeat(64);

    await expect(
      application.handle({
        type: "CreateFolder",
        expectedVaultId,
        name: "Archive",
        parentFolderId: null,
      }),
    ).resolves.toEqual({
      folderId: "b".repeat(64),
      eventRecordId: "c".repeat(64),
    });
    expect(runtime.createFolder).toHaveBeenCalledWith({
      expectedVaultId,
      name: "Archive",
      parentFolderId: null,
      commandId: "command-id",
      assertedAt: 1234,
    });

    await expect(application.handle({ type: "ListCollections", expectedVaultId })).resolves.toEqual(
      [],
    );
    expect(runtime.listCollections).toHaveBeenCalledWith(expectedVaultId);
  });

  it("keeps Hosted Replica setup and listing on exact selected-Vault Commands", async () => {
    const runtime = {
      listRemotes: vi.fn().mockResolvedValue([]),
      createHostedReplica: vi.fn().mockResolvedValue({
        remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
        name: "Hosted archive",
        endpoint: "https://sync.example.test/",
        enabled: true,
      }),
    };
    const application = new CanonicalApplication(runtime as never);
    const expectedVaultId = "a".repeat(64);

    await expect(application.handle({ type: "ListRemotes", expectedVaultId })).resolves.toEqual([]);
    await expect(
      application.handle({
        type: "CreateHostedReplica",
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
    expect(runtime.listRemotes).toHaveBeenCalledWith(expectedVaultId);
    expect(runtime.createHostedReplica).toHaveBeenCalledWith({
      expectedVaultId,
      endpoint: "https://sync.example.test/",
      name: "Hosted archive",
      username: "archive_reader",
      password: "correct horse battery staple",
    });
    await expect(
      application.handle({ type: "ListRemotes", expectedVaultId, extra: true }),
    ).rejects.toThrow(/Unsupported application Command/u);
  });

  it("attaches an existing Hosted Replica only through an exact transient selection ceremony", async () => {
    const runtime = {
      beginHostedReplicaAttachment: vi.fn().mockResolvedValue({
        setupId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cd",
        replicas: [
          {
            replicaHandle: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
            storedBytes: 4_096,
          },
        ],
      }),
      confirmHostedReplicaAttachment: vi.fn().mockResolvedValue({
        remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
        name: "Existing hosted copy",
        endpoint: "https://sync.example.test/",
        enabled: true,
      }),
      cancelHostedReplicaAttachment: vi.fn().mockResolvedValue(undefined),
    };
    const invalidated = vi.fn();
    const application = new CanonicalApplication(
      runtime as never,
      undefined,
      undefined,
      undefined,
      invalidated,
    );
    const expectedVaultId = "a".repeat(64);
    const setupId = "019fa62e-a653-7f63-b2bf-94e7ed5e46cd";
    const replicaHandle = "019fa62e-a653-7f63-b2bf-94e7ed5e46cb";

    await expect(
      application.handle({
        type: "BeginHostedReplicaAttachment",
        expectedVaultId,
        endpoint: "https://sync.example.test/",
        name: "Existing hosted copy",
        username: "archive_reader",
        password: "correct horse battery staple",
      }),
    ).resolves.toEqual({ setupId, replicas: [{ replicaHandle, storedBytes: 4_096 }] });
    await expect(
      application.handle({
        type: "ConfirmHostedReplicaAttachment",
        expectedVaultId,
        setupId,
        replicaHandle,
      }),
    ).resolves.toMatchObject({ remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca" });
    await expect(
      application.handle({ type: "CancelHostedReplicaAttachment", setupId }),
    ).resolves.toBeUndefined();
    expect(runtime.beginHostedReplicaAttachment).toHaveBeenCalledWith({
      expectedVaultId,
      endpoint: "https://sync.example.test/",
      name: "Existing hosted copy",
      username: "archive_reader",
      password: "correct horse battery staple",
    });
    expect(runtime.confirmHostedReplicaAttachment).toHaveBeenCalledWith({
      expectedVaultId,
      setupId,
      replicaHandle,
    });
    expect(runtime.cancelHostedReplicaAttachment).toHaveBeenCalledWith(setupId);
    expect(invalidated).toHaveBeenCalledTimes(3);
    await expect(
      application.handle({ type: "CancelHostedReplicaAttachment", setupId, extra: true }),
    ).rejects.toThrow(/Unsupported application Command/u);
  });

  it("renames and pauses a selected-Vault Remote only through exact local Commands", async () => {
    const renamed = {
      remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
      name: "Personal archive",
      endpoint: "https://sync.example.test/",
      enabled: false,
    };
    const runtime = {
      renameRemote: vi.fn().mockResolvedValue({ ...renamed, enabled: true }),
      setRemoteEnabled: vi.fn().mockResolvedValue(renamed),
      retireRemote: vi.fn().mockResolvedValue({
        materializationLedgerCount: 1,
        pullJobCount: 2,
        quarantinedItemCount: 3,
      }),
    };
    const invalidated = vi.fn();
    const application = new CanonicalApplication(
      runtime as never,
      undefined,
      undefined,
      undefined,
      invalidated,
    );
    const expectedVaultId = "a".repeat(64);

    await expect(
      application.handle({
        type: "RenameRemote",
        expectedVaultId,
        remoteId: renamed.remoteId,
        name: renamed.name,
      }),
    ).resolves.toEqual({ ...renamed, enabled: true });
    await expect(
      application.handle({
        type: "SetRemoteEnabled",
        expectedVaultId,
        remoteId: renamed.remoteId,
        enabled: false,
      }),
    ).resolves.toEqual(renamed);
    await expect(
      application.handle({
        type: "RetireRemote",
        expectedVaultId,
        remoteId: renamed.remoteId,
      }),
    ).resolves.toEqual({
      materializationLedgerCount: 1,
      pullJobCount: 2,
      quarantinedItemCount: 3,
    });
    expect(runtime.renameRemote).toHaveBeenCalledWith({
      expectedVaultId,
      remoteId: renamed.remoteId,
      name: renamed.name,
    });
    expect(runtime.setRemoteEnabled).toHaveBeenCalledWith({
      expectedVaultId,
      remoteId: renamed.remoteId,
      enabled: false,
    });
    expect(runtime.retireRemote).toHaveBeenCalledWith({
      expectedVaultId,
      remoteId: renamed.remoteId,
    });
    expect(invalidated).toHaveBeenCalledTimes(3);
    await expect(
      application.handle({
        type: "SetRemoteEnabled",
        expectedVaultId,
        remoteId: renamed.remoteId,
        enabled: false,
        extra: true,
      }),
    ).rejects.toThrow(/Unsupported application Command/u);
  });

  it("materializes one selected-Vault Remote only through an exact Command", async () => {
    const runtime = {
      materializeHostedReplica: vi.fn().mockResolvedValue({
        remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
        materializedCompactItemCount: 4,
        retriedCompactItemCount: 1,
        alreadyConfirmedCompactItemCount: 2,
      }),
    };
    const application = new CanonicalApplication(runtime as never);
    const expectedVaultId = "a".repeat(64);
    const remoteId = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";

    await expect(
      application.handle({ type: "MaterializeHostedReplica", expectedVaultId, remoteId }),
    ).resolves.toEqual({
      remoteId,
      materializedCompactItemCount: 4,
      retriedCompactItemCount: 1,
      alreadyConfirmedCompactItemCount: 2,
    });
    expect(runtime.materializeHostedReplica).toHaveBeenCalledWith({ expectedVaultId, remoteId });
    await expect(
      application.handle({
        type: "MaterializeHostedReplica",
        expectedVaultId,
        remoteId,
        extra: true,
      }),
    ).rejects.toThrow(/Unsupported application Command/u);
  });

  it("checks selected-Vault Hosted Replicas only through an exact Command", async () => {
    const runtime = {
      pullHostedReplicas: vi.fn().mockResolvedValue([
        { remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca", status: "Completed" },
        { remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb", status: "Failed" },
      ]),
    };
    const application = new CanonicalApplication(runtime as never);
    const expectedVaultId = "a".repeat(64);

    await expect(
      application.handle({ type: "PullHostedReplicas", expectedVaultId }),
    ).resolves.toEqual([
      { remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca", status: "Completed" },
      { remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb", status: "Failed" },
    ]);
    expect(runtime.pullHostedReplicas).toHaveBeenCalledWith(expectedVaultId);
    await expect(
      application.handle({ type: "PullHostedReplicas", expectedVaultId, extra: true }),
    ).rejects.toThrow(/Unsupported application Command/u);
  });

  it("hydrates an exact selected-Vault Artifact only through a Command", async () => {
    const runtime = {
      hydrateArtifact: vi.fn().mockResolvedValue({
        artifactId: "a".repeat(64),
        storageItemId: "b".repeat(64),
        remoteId: "local",
      }),
    };
    const application = new CanonicalApplication(runtime as never);
    const expectedVaultId = "c".repeat(64);
    const artifactId = "a".repeat(64);

    await expect(
      application.handle({ type: "HydrateArtifact", expectedVaultId, artifactId }),
    ).resolves.toEqual({
      artifactId,
      storageItemId: "b".repeat(64),
      remoteId: "local",
    });
    expect(runtime.hydrateArtifact).toHaveBeenCalledWith({ expectedVaultId, artifactId });
    await expect(
      application.handle({ type: "HydrateArtifact", expectedVaultId, artifactId, extra: true }),
    ).rejects.toThrow(/Unsupported application Command/u);
  });

  it("collects a browser page only through the canonical capture Host before authoring it", async () => {
    const runtime = {
      state: vi.fn(),
      beginVaultCreation: vi.fn(),
      confirmVaultCreation: vi.fn(),
      cancelVaultCreation: vi.fn(),
      selectVault: vi.fn(),
      listLibrary: vi.fn(),
      listRemotes: vi.fn(),
      renameRemote: vi.fn(),
      setRemoteEnabled: vi.fn(),
      retireRemote: vi.fn(),
      createHostedReplica: vi.fn(),
      beginHostedReplicaAttachment: vi.fn(),
      confirmHostedReplicaAttachment: vi.fn(),
      cancelHostedReplicaAttachment: vi.fn(),
      materializeHostedReplica: vi.fn(),
      pullHostedReplicas: vi.fn(),
      hydrateArtifact: vi.fn(),
      capture: vi.fn().mockResolvedValue({ bundleId: "b".repeat(64) }),
      closeVault: vi.fn(),
      vacuumVault: vi.fn(),
      beginVaultFork: vi.fn(),
      confirmVaultFork: vi.fn(),
      cancelVaultFork: vi.fn(),
      recoverMember: vi.fn(),
      recoverHostedMember: vi.fn(),
      beginRecoveryPhraseReplacement: vi.fn(),
      confirmRecoveryPhraseReplacement: vi.fn(),
      cancelRecoveryPhraseReplacement: vi.fn(),
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

  it("keeps the state-only Fork ceremony on exact application Commands", async () => {
    const runtime = {
      beginVaultFork: vi.fn().mockResolvedValue({
        setupId: "setup",
        recoveryPhrase: "alpha beta gamma",
      }),
      confirmVaultFork: vi.fn().mockResolvedValue({ vaultId: "b".repeat(64) }),
      cancelVaultFork: vi.fn().mockResolvedValue(undefined),
    };
    const application = new CanonicalApplication(
      runtime as never,
      () => 1234,
      undefined,
      () => "command",
    );
    const expectedVaultId = "a".repeat(64);

    await expect(application.handle({ type: "BeginVaultFork", expectedVaultId })).resolves.toEqual({
      setupId: "setup",
      recoveryPhrase: "alpha beta gamma",
    });
    await expect(
      application.handle({
        type: "ConfirmVaultFork",
        setupId: "setup",
        recoveryPhrase: "alpha beta gamma",
      }),
    ).resolves.toEqual({ vaultId: "b".repeat(64) });
    await expect(
      application.handle({ type: "CancelVaultFork", setupId: "setup" }),
    ).resolves.toBeUndefined();
    expect(runtime.beginVaultFork).toHaveBeenCalledWith({
      expectedVaultId,
      assertedAt: 1234,
    });
    expect(runtime.confirmVaultFork).toHaveBeenCalledWith({
      setupId: "setup",
      recoveryPhrase: "alpha beta gamma",
    });
    expect(runtime.cancelVaultFork).toHaveBeenCalledWith("setup");
    await expect(
      application.handle({ type: "BeginVaultFork", expectedVaultId, extra: true }),
    ).rejects.toThrow(/Unsupported application Command/u);
  });

  it("keeps member Recovery and phrase replacement on exact application Commands", async () => {
    const runtime = {
      recoverMember: vi.fn().mockResolvedValue({
        memberId: "a".repeat(64),
        clientCredentialId: "b".repeat(64),
        eventRecordId: "c".repeat(64),
      }),
      recoverHostedMember: vi.fn(),
      beginRecoveryPhraseReplacement: vi.fn().mockResolvedValue({
        setupId: "replacement-setup",
        recoveryPhrase: "delta echo foxtrot",
      }),
      confirmRecoveryPhraseReplacement: vi.fn().mockResolvedValue({
        recoveryCredentialId: "d".repeat(64),
        revision: 1,
        eventRecordId: "e".repeat(64),
      }),
      cancelRecoveryPhraseReplacement: vi.fn().mockResolvedValue(undefined),
    };
    const application = new CanonicalApplication(
      runtime as never,
      () => 1234,
      undefined,
      () => "command",
    );
    const expectedVaultId = "a".repeat(64);

    await expect(
      application.handle({
        type: "RecoverMember",
        expectedVaultId,
        recoveryPhrase: "alpha beta gamma",
      }),
    ).resolves.toEqual({
      memberId: "a".repeat(64),
      clientCredentialId: "b".repeat(64),
      eventRecordId: "c".repeat(64),
    });
    await expect(
      application.handle({ type: "BeginRecoveryPhraseReplacement", expectedVaultId }),
    ).resolves.toEqual({ setupId: "replacement-setup", recoveryPhrase: "delta echo foxtrot" });
    await expect(
      application.handle({
        type: "ConfirmRecoveryPhraseReplacement",
        setupId: "replacement-setup",
        recoveryPhrase: "delta echo foxtrot",
      }),
    ).resolves.toEqual({
      recoveryCredentialId: "d".repeat(64),
      revision: 1,
      eventRecordId: "e".repeat(64),
    });
    await expect(
      application.handle({ type: "CancelRecoveryPhraseReplacement", setupId: "replacement-setup" }),
    ).resolves.toBeUndefined();
    expect(runtime.recoverMember).toHaveBeenCalledWith({
      expectedVaultId,
      recoveryPhrase: "alpha beta gamma",
      commandId: "command",
      assertedAt: 1234,
    });
    expect(runtime.beginRecoveryPhraseReplacement).toHaveBeenCalledWith({
      expectedVaultId,
      assertedAt: 1234,
    });
    expect(runtime.confirmRecoveryPhraseReplacement).toHaveBeenCalledWith({
      setupId: "replacement-setup",
      recoveryPhrase: "delta echo foxtrot",
    });
    expect(runtime.cancelRecoveryPhraseReplacement).toHaveBeenCalledWith("replacement-setup");
    await expect(
      application.handle({
        type: "RecoverMember",
        expectedVaultId,
        recoveryPhrase: "alpha",
        extra: true,
      }),
    ).rejects.toThrow(/Unsupported application Command/u);
  });

  it("runs Hosted Member Recovery as a fresh local Vault mutation", async () => {
    const runtime = {
      recoverHostedMember: vi.fn().mockResolvedValue({
        vaultId: "a".repeat(64),
        memberId: "b".repeat(64),
        clientCredentialId: "c".repeat(64),
        eventRecordId: "d".repeat(64),
      }),
    };
    const application = new CanonicalApplication(runtime as never, () => 1234);

    await expect(
      application.handle({
        type: "RecoverHostedMember",
        endpoint: "https://host.example",
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
    expect(runtime.recoverHostedMember).toHaveBeenCalledWith({
      endpoint: "https://host.example",
      username: "marin",
      password: "not persisted",
      recoveryPhrase: "twelve private words",
      assertedAt: 1234,
    });
    await expect(
      application.handle({
        type: "RecoverHostedMember",
        endpoint: "https://host.example",
        username: "marin",
        password: "not persisted",
        recoveryPhrase: "twelve private words",
        extra: true,
      }),
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
      listRemotes: vi.fn(),
      renameRemote: vi.fn(),
      setRemoteEnabled: vi.fn(),
      retireRemote: vi.fn(),
      createHostedReplica: vi.fn(),
      beginHostedReplicaAttachment: vi.fn(),
      confirmHostedReplicaAttachment: vi.fn(),
      cancelHostedReplicaAttachment: vi.fn(),
      materializeHostedReplica: vi.fn(),
      pullHostedReplicas: vi.fn(),
      hydrateArtifact: vi.fn(),
      capture: vi.fn(),
      closeVault: vi.fn(),
      vacuumVault: vi.fn(),
      beginVaultFork: vi.fn(),
      confirmVaultFork: vi.fn(),
      cancelVaultFork: vi.fn(),
      recoverMember: vi.fn(),
      recoverHostedMember: vi.fn(),
      beginRecoveryPhraseReplacement: vi.fn(),
      confirmRecoveryPhraseReplacement: vi.fn(),
      cancelRecoveryPhraseReplacement: vi.fn(),
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
