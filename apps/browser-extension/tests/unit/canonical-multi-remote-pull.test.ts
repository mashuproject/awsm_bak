import { describe, expect, it } from "vitest";

import { CanonicalMultiRemotePullService } from "../../src/runtime/synchronization/canonical-multi-remote-pull-service";
import type { CanonicalReplicaRemote } from "../../src/runtime/synchronization/canonical-state";

const VAULT_ID = new Uint8Array(32).fill(1) as CanonicalReplicaRemote["vaultId"];

function remote(remoteId: string, enabled = true): CanonicalReplicaRemote {
  return {
    remoteId,
    vaultId: VAULT_ID,
    name: remoteId,
    endpoint: "https://host.example/",
    hostedReplicaHandle: "019fa62e-a653-7f63-b2bf-94e7ed5e46ca",
    locatorSalt: new Uint8Array(32).fill(2),
    enabled,
    inventoryPageSize: 100,
  };
}

describe("canonical multi-Remote pull", () => {
  it("pulls enabled Remotes in stable order and isolates one Remote failure", async () => {
    const calls: string[] = [];
    const service = new CanonicalMultiRemotePullService({
      list: async () => [
        remote("019fa62e-a653-7f63-b2bf-94e7ed5e46cf", false),
        remote("019fa62e-a653-7f63-b2bf-94e7ed5e46ce"),
        remote("019fa62e-a653-7f63-b2bf-94e7ed5e46cd"),
      ],
      pull: async ({ remoteId }) => {
        calls.push(remoteId);
        if (remoteId.endsWith("cd")) throw new TypeError("untrusted Remote failure");
        return {
          stage: 3,
          state: 3,
          progress: {
            discoveredItemCount: 1,
            downloadedItemCount: 1,
            promotedItemCount: 1,
            rejectedItemCount: 0,
          },
        };
      },
    });

    await expect(service.pull({ vaultId: VAULT_ID })).resolves.toEqual([
      {
        remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cd",
        status: "Failed",
      },
      {
        remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46ce",
        status: "Completed",
        progress: {
          discoveredItemCount: 1,
          downloadedItemCount: 1,
          promotedItemCount: 1,
          rejectedItemCount: 0,
        },
      },
      {
        remoteId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cf",
        status: "Disabled",
      },
    ]);
    expect(calls).toEqual([
      "019fa62e-a653-7f63-b2bf-94e7ed5e46cd",
      "019fa62e-a653-7f63-b2bf-94e7ed5e46ce",
    ]);
  });

  it("fails closed on a Remote outside the selected Vault", async () => {
    const service = new CanonicalMultiRemotePullService({
      list: async () => [
        {
          ...remote("019fa62e-a653-7f63-b2bf-94e7ed5e46cd"),
          vaultId: new Uint8Array(32).fill(9) as CanonicalReplicaRemote["vaultId"],
        },
      ],
      pull: async () => {
        throw new TypeError("unexpected Remote pull");
      },
    });

    await expect(service.pull({ vaultId: VAULT_ID })).rejects.toThrow(/selected Vault/u);
  });

  it("fails closed on a duplicate local Remote identity", async () => {
    const duplicate = remote("019fa62e-a653-7f63-b2bf-94e7ed5e46cd");
    const service = new CanonicalMultiRemotePullService({
      list: async () => [duplicate, duplicate],
      pull: async () => {
        throw new TypeError("unexpected Remote pull");
      },
    });

    await expect(service.pull({ vaultId: VAULT_ID })).rejects.toThrow(/repeats/u);
  });
});
