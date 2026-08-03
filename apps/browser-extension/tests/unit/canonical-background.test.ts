import { describe, expect, it, vi } from "vitest";

import { createCanonicalBackgroundApplication } from "../../src/app/canonical-background";
import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
import type { CanonicalArtifactStore } from "../../src/runtime/artifact/canonical-store";
import type { CanonicalHostedCompactMaterializationService } from "../../src/runtime/synchronization/canonical-hosted-compact-materialization";
import type { CanonicalHostedReplicaSetupService } from "../../src/runtime/synchronization/canonical-hosted-replica-setup";
import type { CanonicalMultiRemotePullService } from "../../src/runtime/synchronization/canonical-multi-remote-pull-service";
import type { CanonicalReplicaRemoteService } from "../../src/runtime/synchronization/canonical-remote-service";
import type { CanonicalReplicaRemote } from "../../src/runtime/synchronization/canonical-state";
import type { CanonicalVaultService } from "../../src/runtime/vault/canonical-service";

describe("canonical background", () => {
  it("composes one canonical Runtime with the browser Capture Host", async () => {
    const vaults = {
      listVaults: vi.fn().mockResolvedValue([]),
      pendingCreation: vi.fn().mockResolvedValue(undefined),
    } as unknown as CanonicalVaultService;
    const pageCapture = {
      captureActivePage: vi.fn(),
    };
    const application = createCanonicalBackgroundApplication({
      vaults,
      artifacts: {} as CanonicalArtifactStore,
      pageCapture,
      now: () => 1234,
      createCaptureCommandId: () => "command",
    });

    await expect(application.handle({ type: "GetState" })).resolves.toEqual({ vaults: [] });
    expect(vaults.listVaults).toHaveBeenCalledTimes(1);
  });

  it("wires the canonical Hosted Replica setup and listing services into the application", async () => {
    const vaultId = randomIdentifier("Vault");
    const remote: CanonicalReplicaRemote = {
      remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
      vaultId,
      name: "Hosted archive",
      endpoint: "https://sync.example.test/",
      hostedReplicaHandle: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
      locatorSalt: new Uint8Array(32).fill(1),
      enabled: true,
      inventoryPageSize: 100,
    };
    const vaults = {
      listVaults: vi.fn().mockResolvedValue([
        {
          vaultId,
          generationId: randomIdentifier("Generation"),
          label: "Research",
          selectedClientCredentialId: randomIdentifier("ClientCredential"),
          lifecycle: 1,
          access: "Authoring",
          selected: true,
        },
      ]),
      pendingCreation: vi.fn().mockResolvedValue(undefined),
    } as unknown as CanonicalVaultService;
    const remotes = { list: vi.fn().mockResolvedValue([remote]) } as Pick<
      CanonicalReplicaRemoteService,
      "list"
    >;
    const hostedReplicaSetup = { create: vi.fn().mockResolvedValue(remote) } as Pick<
      CanonicalHostedReplicaSetupService,
      "create"
    >;
    const hostedCompactMaterializer = {
      materialize: vi.fn().mockResolvedValue({
        remoteId: remote.remoteId,
        materializedCompactItemCount: 4,
        retriedCompactItemCount: 1,
        alreadyConfirmedCompactItemCount: 2,
      }),
    } as Pick<CanonicalHostedCompactMaterializationService, "materialize">;
    const multiRemotePull = {
      pull: vi.fn().mockResolvedValue([{ remoteId: remote.remoteId, status: "Completed" }]),
    } as Pick<CanonicalMultiRemotePullService, "pull">;
    const application = createCanonicalBackgroundApplication({
      vaults,
      artifacts: {} as CanonicalArtifactStore,
      pageCapture: { captureActivePage: vi.fn() },
      remotes,
      hostedReplicaSetup,
      hostedCompactMaterializer,
      multiRemotePull,
    });
    const expectedVaultId = identifierStorageKey(vaultId);

    await expect(application.handle({ type: "ListRemotes", expectedVaultId })).resolves.toEqual([
      {
        remoteId: remote.remoteId,
        name: remote.name,
        endpoint: remote.endpoint,
        enabled: true,
      },
    ]);
    expect(remotes.list).toHaveBeenCalledWith(vaultId);
    await expect(
      application.handle({
        type: "MaterializeHostedReplica",
        expectedVaultId,
        remoteId: remote.remoteId,
      }),
    ).resolves.toEqual({
      remoteId: remote.remoteId,
      materializedCompactItemCount: 4,
      retriedCompactItemCount: 1,
      alreadyConfirmedCompactItemCount: 2,
    });
    expect(hostedCompactMaterializer.materialize).toHaveBeenCalledWith({
      vaultId,
      remoteId: remote.remoteId,
    });
    await expect(
      application.handle({ type: "PullHostedReplicas", expectedVaultId }),
    ).resolves.toEqual([{ remoteId: remote.remoteId, status: "Completed" }]);
    expect(multiRemotePull.pull).toHaveBeenCalledWith({ vaultId });
  });
});
