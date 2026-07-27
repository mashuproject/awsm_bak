import { describe, expect, it, vi } from "vitest";

import type { StoredAccountMetadataV1 } from "../../src/drivers/indexeddb/schema";
import {
  prepareReplacementAuthority,
  wipeReplacementAuthority,
} from "../../src/runtime/recovery/replacement-authority";
import {
  type StagedVaultReplacement,
  VaultReplacementRemote,
} from "../../src/runtime/recovery/replacement-remote";
import type { PreparedVaultReplacement } from "../../src/runtime/recovery/replacement-rewrite";
import { VaultService } from "../../src/runtime/vault/service";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const account: StoredAccountMetadataV1 = {
  version: 1,
  accountId: id(1),
  sessionId: id(2),
  username: "owner_test",
  inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
  scope: "Account",
};

function session(accessToken: string) {
  return {
    account: {
      accountId: account.accountId,
      username: account.username,
      inactiveDeletionAt: account.inactiveDeletionAt,
    },
    sessionId: id(3),
    scope: "VaultDevice" as const,
    accessToken,
    accessExpiresAt: "2026-07-25T23:00:00.000Z",
    refreshToken: "replacement-refresh",
    refreshExpiresAt: "2026-08-25T23:00:00.000Z",
  };
}

describe("replacement Vault remote handoff", () => {
  it("stages under source authority, switches to replacement authority, and activates by CAS", async () => {
    const target = await new VaultService({
      load: async () => undefined,
      setManualLock: async () => undefined,
    }).prepareCreate({
      name: "Replacement",
      createdAt: "2026-07-25T22:00:00.000Z",
    });
    let nextId = 20;
    const authority = await prepareReplacementAuthority({
      account,
      target,
      displayName: "Firefox",
      clientKind: "FirefoxExtension",
      randomUuid: () => id(nextId++),
      now: () => "2026-07-25T22:01:00.000Z",
    });
    const replacement = {
      generation: target.records.generation,
      head: target.records.head,
      objects: [],
      events: [],
      identifierMappings: [],
      projections: {
        items: [],
        topologyEvents: [],
        vaultName: "Replacement",
      },
    } as unknown as PreparedVaultReplacement;
    const source = {
      sourceVaultId: id(4),
      generationId: id(5),
      generationNumber: 8,
      headCursor: 34,
    };
    const uploadId = id(6);
    const purgeId = id(7);
    const calls: {
      readonly method: string;
      readonly path: string;
      readonly body: unknown;
      readonly idempotencyKey?: string;
    }[] = [];
    const useDeviceAccessToken = vi.fn();
    const transport = {
      request: vi.fn(
        async (
          method: string,
          path: string,
          body?: unknown,
          idempotencyKey?: string,
        ): Promise<{ status: number; body: unknown }> => {
          calls.push({
            method,
            path,
            body,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          });
          if (path.endsWith("/replacement-candidates"))
            return {
              status: 201,
              body: {
                vault: {
                  vaultId: target.records.metadata.vaultId,
                  state: "Provisional",
                  generationId: target.records.generation.generationId,
                  generationNumber: 0,
                  headCursor: 0,
                  activeKeyEpochId: target.records.metadata.activeKeyEpochId,
                },
                upload: {
                  uploadId,
                  objectId: target.records.generation.generationId,
                  state: "Open",
                  partSizeBytes: 17,
                  partCount: 10,
                  receivedParts: [],
                  expiresAt: "2026-07-26T22:00:00.000Z",
                },
                ticket: { url: "/transfer/{partNumber}" },
                session: session("replacement-access"),
              },
            };
          if (path.endsWith("/complete"))
            return path.includes("/uploads/")
              ? { status: 200, body: {} }
              : {
                  status: 200,
                  body: {
                    vaultId: target.records.metadata.vaultId,
                    state: "Provisional",
                    generationId: target.records.generation.generationId,
                    generationNumber: 0,
                  },
                };
          if (path.endsWith("/activate"))
            return {
              status: 202,
              body: {
                sourceVaultId: source.sourceVaultId,
                sourceState: "Replaced",
                vault: {
                  vaultId: target.records.metadata.vaultId,
                  state: "Active",
                  generationId: target.records.generation.generationId,
                  generationNumber: 0,
                  headCursor: 1,
                },
                purge: {
                  purgeId,
                  state: "Pending",
                  stage: "Detach",
                  processedBytes: 0,
                  totalBytes: 4096,
                },
              },
            };
          if (path.endsWith(`/purges/${purgeId}`))
            return {
              status: 200,
              body: {
                purgeId,
                state: "Succeeded",
                stage: "Complete",
                processedBytes: 4096,
                totalBytes: 4096,
              },
            };
          throw new Error(`Unexpected request ${method} ${path}`);
        },
      ),
      putTransfer: vi.fn(async () => undefined),
      useDeviceAccessToken,
    };
    const idempotency = {
      candidateIdempotencyKey: id(100),
      generationUploadCompleteIdempotencyKey: id(101),
      candidateCompleteIdempotencyKey: id(102),
      activationIdempotencyKey: id(103),
    };
    const remote = new VaultReplacementRemote(transport);

    const staged = await remote.stage({
      source,
      authority: authority.prepared,
      replacement,
      idempotency,
    });

    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `/api/vaults/${source.sourceVaultId}/replacement-candidates`,
      idempotencyKey: idempotency.candidateIdempotencyKey,
      body: {
        expectedSourceGenerationId: source.generationId,
        expectedSourceGenerationNumber: source.generationNumber,
        expectedSourceHeadCursor: source.headCursor,
        replacement: {
          vaultId: target.records.metadata.vaultId,
          generationId: target.records.generation.generationId,
          generationNumber: 0,
          keyEpochs: [
            {
              keyEpochId: target.records.metadata.activeKeyEpochId,
              ordinal: 0,
              activatedAt: target.records.metadata.createdAt,
            },
          ],
          activeKeyEpochId: target.records.metadata.activeKeyEpochId,
        },
      },
    });
    expect(transport.putTransfer).toHaveBeenCalled();
    expect(useDeviceAccessToken).toHaveBeenCalledWith("replacement-access");
    expect(staged.session.scope).toBe("VaultDevice");

    await expect(remote.activate(staged)).resolves.toEqual({
      sourceVaultId: source.sourceVaultId,
      targetVaultId: target.records.metadata.vaultId,
      targetHeadCursor: 1,
      purge: {
        purgeId,
        state: "Pending",
        stage: "Detach",
        processedBytes: 0,
        totalBytes: 4096,
      },
    });
    expect(calls.at(-1)).toMatchObject({
      path: `/api/vaults/${source.sourceVaultId}/replacement-candidates/${target.records.metadata.vaultId}/activate`,
      idempotencyKey: idempotency.activationIdempotencyKey,
      body: {
        expectedSourceGenerationId: source.generationId,
        expectedSourceGenerationNumber: source.generationNumber,
        expectedSourceHeadCursor: source.headCursor,
        replacementGenerationId: target.records.generation.generationId,
        replacementGenerationNumber: 0,
      },
    });
    await expect(remote.purgeStatus(source.sourceVaultId, purgeId)).resolves.toEqual({
      purgeId,
      state: "Succeeded",
      stage: "Complete",
      processedBytes: 4096,
      totalBytes: 4096,
    });
    expect(calls.at(-1)).toMatchObject({
      method: "GET",
      path: `/api/vaults/${source.sourceVaultId}/purges/${purgeId}`,
    });

    await wipeReplacementAuthority(authority.prepared);
  });

  it("rejects activation when the server changes replacement authority", async () => {
    const staged: StagedVaultReplacement = {
      source: {
        sourceVaultId: id(50),
        generationId: id(51),
        generationNumber: 1,
        headCursor: 2,
      },
      targetVaultId: id(52),
      targetGenerationId: id(53),
      targetGenerationNumber: 0,
      session: session("access"),
      idempotency: {
        candidateIdempotencyKey: id(55),
        generationUploadCompleteIdempotencyKey: id(56),
        candidateCompleteIdempotencyKey: id(57),
        activationIdempotencyKey: id(58),
      },
    };
    const remote = new VaultReplacementRemote({
      request: async () => ({
        status: 202,
        body: {
          sourceVaultId: staged.source.sourceVaultId,
          sourceState: "Replaced",
          vault: {
            vaultId: id(99),
            state: "Active",
            generationId: staged.targetGenerationId,
            generationNumber: 0,
            headCursor: 1,
          },
          purge: {
            purgeId: id(54),
            state: "Pending",
            stage: "Detach",
            processedBytes: 0,
            totalBytes: 1,
          },
        },
      }),
      putTransfer: async () => undefined,
      useDeviceAccessToken: () => undefined,
    });

    await expect(remote.activate(staged)).rejects.toMatchObject({
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  });
});
