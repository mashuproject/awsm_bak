import { describe, expect, it } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import { CanonicalHostedReplicaSetupService } from "../../src/runtime/synchronization/canonical-hosted-replica-setup";

const REMOTE_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";
const REPLICA_HANDLE = "019fa62e-a653-7f63-b2bf-94e7ed5e46cb";

describe("canonical Hosted Replica setup", () => {
  it("creates one Host-local Replica and retains only its rotating channel session", async () => {
    const configured: unknown[] = [];
    const service = new CanonicalHostedReplicaSetupService({
      remotes: {
        configureHostedSession: async (input: unknown) => configured.push(input),
      },
      createSessionHttp: () => ({
        signIn: async () => ({
          username: "archive_reader",
          sessionId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cc",
          accessToken: "access-token",
          accessExpiresAt: 1_000,
          refreshToken: "refresh-token",
          refreshExpiresAt: 2_000,
        }),
      }),
      createReplicaHttp: () => ({
        createReplica: async () => ({
          replicaHandle: REPLICA_HANDLE,
          locatorSalt: new Uint8Array(32).fill(8),
          capabilities: [
            "awsm.replica.inventory.read",
            "awsm.replica.item.read",
            "awsm.replica.item.write",
          ],
          quotaBytes: null,
          storedBytes: 0,
        }),
      }),
      createRemoteId: () => REMOTE_ID,
    } as never);

    await expect(
      service.create({
        vaultId: identifier("Vault", new Uint8Array(32).fill(7)),
        endpoint: "https://host.example/",
        name: "Hosted copy",
        username: "archive_reader",
        password: "correct horse battery staple",
      }),
    ).resolves.toMatchObject({
      remoteId: REMOTE_ID,
      hostedReplicaHandle: REPLICA_HANDLE,
      enabled: true,
      inventoryPageSize: 100,
    });
    expect(configured).toHaveLength(1);
    expect(configured[0]).toMatchObject({
      remote: { remoteId: REMOTE_ID, hostedReplicaHandle: REPLICA_HANDLE },
      session: { username: "archive_reader", refreshToken: "refresh-token" },
    });
    expect(JSON.stringify(configured[0])).not.toContain("correct horse battery staple");
  });

  it("refuses a newly created Replica that cannot both pull and materialize", async () => {
    const configured: unknown[] = [];
    const service = new CanonicalHostedReplicaSetupService({
      remotes: {
        configureHostedSession: async (input: unknown) => configured.push(input),
      },
      createSessionHttp: () => ({
        signIn: async () => ({
          username: "archive_reader",
          sessionId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cc",
          accessToken: "access-token",
          accessExpiresAt: 1_000,
          refreshToken: "refresh-token",
          refreshExpiresAt: 2_000,
        }),
      }),
      createReplicaHttp: () => ({
        createReplica: async () => ({
          replicaHandle: REPLICA_HANDLE,
          locatorSalt: new Uint8Array(32).fill(8),
          capabilities: ["awsm.replica.inventory.read", "awsm.replica.item.read"],
          quotaBytes: null,
          storedBytes: 0,
        }),
      }),
      createRemoteId: () => REMOTE_ID,
    } as never);

    await expect(
      service.create({
        vaultId: identifier("Vault", new Uint8Array(32).fill(7)),
        endpoint: "https://host.example/",
        name: "Hosted copy",
        username: "archive_reader",
        password: "correct horse battery staple",
      }),
    ).rejects.toThrow(/item.write/u);
    expect(configured).toEqual([]);
  });
});
