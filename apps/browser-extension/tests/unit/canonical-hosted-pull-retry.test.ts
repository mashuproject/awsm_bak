import { describe, expect, it } from "vitest";

import { CanonicalHostedPullService } from "../../src/runtime/synchronization/canonical-hosted-pull-service";
import type { CanonicalPullSynchronizationJob } from "../../src/runtime/synchronization/canonical-state";

const VAULT_ID = new Uint8Array(32).fill(1) as CanonicalPullSynchronizationJob["vaultId"];
const REMOTE_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";

function job(): CanonicalPullSynchronizationJob {
  return {
    jobId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
    vaultId: VAULT_ID,
    remoteId: REMOTE_ID,
    realm: { kind: "Test", id: "retry" },
    stage: 1,
    state: 1,
    snapshotCursor: null,
    nextPosition: null,
    attempt: 0,
    retryAfterMs: null,
    quarantineReferences: [],
    progress: {
      discoveredItemCount: 0,
      downloadedItemCount: 0,
      promotedItemCount: 0,
      rejectedItemCount: 0,
    },
  };
}

describe("canonical Hosted pull retry", () => {
  it("checkpoints a retryable Host inventory failure instead of abandoning the Job", async () => {
    let current = job();
    let nowMs = 10_000;
    const service = new CanonicalHostedPullService({
      remotes: {
        load: async () => ({
          remote: {
            remoteId: REMOTE_ID,
            vaultId: VAULT_ID,
            name: "Host",
            endpoint: "https://host.example/",
            hostedReplicaHandle: "019fa62e-a653-7f63-b2bf-94e7ed5e46cc",
            locatorSalt: new Uint8Array(32).fill(1),
            enabled: true,
            inventoryPageSize: 100,
          },
          bearerToken: "channel-token",
        }),
      },
      vaults: {
        hasVerifiedCompactStorageItem: async () => false,
        hasVerifiedCompactLogicalItem: async () => false,
        listEpochSecrets: async () => {
          throw new TypeError("unexpected Epoch access");
        },
        openResolvedCompactItem: async () => {
          throw new TypeError("unexpected Compact access");
        },
        openVault: async () => {
          throw new TypeError("unexpected Vault access");
        },
        readResolvedOpaqueItem: async () => {
          throw new TypeError("unexpected opaque access");
        },
      },
      jobs: {
        findActive: async () => current,
        create: async () => {
          throw new TypeError("unexpected Job creation");
        },
        checkpoint: async ({ previous, next }) => {
          expect(previous).toBe(current);
          current = next;
        },
        completeValidation: async () => {
          throw new TypeError("unexpected completion");
        },
        promoteValidated: async () => {
          throw new TypeError("unexpected promotion");
        },
        readQuarantine: async () => undefined,
        recordQuarantine: async () => {
          throw new TypeError("unexpected Quarantine write");
        },
      },
      createHttp: () => ({
        inventory: async () => {
          throw Object.assign(new Error("temporary Host failure"), {
            retryable: true,
            retryAfterSeconds: 2,
          });
        },
        item: async () => {
          throw new TypeError("unexpected item read");
        },
      }),
      now: () => nowMs,
      random: () => 0,
    });

    await expect(service.pull({ vaultId: VAULT_ID, remoteId: REMOTE_ID })).resolves.toMatchObject({
      state: 2,
      attempt: 1,
      retryAfterMs: 12_000,
    });
    expect(current).toMatchObject({ state: 2, attempt: 1, retryAfterMs: 12_000 });

    nowMs = 12_000;
    await expect(service.pull({ vaultId: VAULT_ID, remoteId: REMOTE_ID })).resolves.toMatchObject({
      state: 2,
      attempt: 2,
      retryAfterMs: 14_000,
    });
    expect(current).toMatchObject({ state: 2, attempt: 2, retryAfterMs: 14_000 });
  });
});
