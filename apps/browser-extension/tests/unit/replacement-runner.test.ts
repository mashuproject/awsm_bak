import { describe, expect, it, vi } from "vitest";

import type {
  StoredAccountMetadataV1,
  VaultReplacementJobV1,
} from "../../src/drivers/indexeddb/schema";
import type { AuthenticatedSession } from "../../src/runtime/account/http";
import {
  prepareReplacementAuthority,
  wipeReplacementAuthority,
} from "../../src/runtime/recovery/replacement-authority";
import { encodeVaultReplacementSensitiveCheckpoint } from "../../src/runtime/recovery/replacement-checkpoint";
import type { VaultReplacementLocalPromoter } from "../../src/runtime/recovery/replacement-promotion";
import type { VaultReplacementRemote } from "../../src/runtime/recovery/replacement-remote";
import type { PreparedVaultReplacement } from "../../src/runtime/recovery/replacement-rewrite";
import { VaultReplacementRunner } from "../../src/runtime/recovery/replacement-runner";
import type { VaultReplacementGraphUploader } from "../../src/runtime/recovery/replacement-upload";
import { VaultService } from "../../src/runtime/vault/service";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const account: StoredAccountMetadataV1 = {
  version: 1,
  accountId: id(1),
  sessionId: id(2),
  email: "owner@example.test",
  scope: "Account",
};

const session: AuthenticatedSession = {
  account: {
    accountId: account.accountId,
    email: account.email,
  },
  sessionId: id(3),
  scope: "VaultDevice",
  accessToken: "replacement-access",
  accessExpiresAt: "2026-07-26T00:00:00.000Z",
  refreshToken: "replacement-refresh",
  refreshExpiresAt: "2026-08-25T00:00:00.000Z",
};

function jobFor(target: Awaited<ReturnType<VaultService["prepareCreate"]>>): VaultReplacementJobV1 {
  return {
    version: 1,
    jobId: id(10),
    accountId: account.accountId,
    sourceVaultId: id(11),
    sourceHead: {
      version: 1,
      vaultId: id(11),
      generationId: id(12),
      generationNumber: 4,
      appendedObjectIds: [],
      appendedEventIds: [],
    },
    sourceHeadCursor: 9,
    verifiedExportJobId: id(13),
    safelyStoredConfirmed: true,
    candidateIdempotencyKey: id(14),
    generationUploadCompleteIdempotencyKey: id(15),
    candidateCompleteIdempotencyKey: id(16),
    activationIdempotencyKey: id(17),
    state: "Running",
    stage: "StageRemote",
    createdAt: "2026-07-25T20:00:00.000Z",
    updatedAt: "2026-07-25T20:01:00.000Z",
    targetVaultId: target.records.metadata.vaultId,
    targetDeviceId: target.records.metadata.deviceId,
    targetRecoveryGenerationId: id(20),
    targetKeyEpochId: target.records.metadata.activeKeyEpochId,
    targetGenerationId: target.records.generation.generationId,
    targetGenerationNumber: 0,
    completedItems: 0,
    totalItems: 0,
    processedBytes: 0,
    totalBytes: 0,
    retryCount: 0,
  };
}

describe("restart-safe replacement runner", () => {
  it("resumes staged authority through upload, validation, activation, and local promotion", async () => {
    const target = await new VaultService({
      load: async () => undefined,
      setManualLock: async () => undefined,
    }).prepareCreate({
      name: "Archive",
      createdAt: "2026-07-25T20:00:00.000Z",
    });
    let nextId = 20;
    const authority = await prepareReplacementAuthority({
      account,
      target,
      displayName: "Firefox",
      clientKind: "FirefoxExtension",
      randomUuid: () => id(nextId++),
      now: () => "2026-07-25T20:00:00.000Z",
    });
    let current: VaultReplacementJobV1 = {
      ...jobFor(target),
      targetRecoveryGenerationId: authority.prepared.recoveryGenerationId,
    };
    const encoded = encodeVaultReplacementSensitiveCheckpoint({
      version: 1,
      targetVaultId: target.records.metadata.vaultId,
      recoveryGenerationId: authority.prepared.recoveryGenerationId,
      accountSessionId: account.sessionId,
      deviceProofSignature: authority.prepared.deviceProofSignature,
      rootKey: authority.prepared.rootKey,
      identity: authority.prepared.identity,
      certificate: authority.prepared.certificate,
      envelope: authority.prepared.envelope,
      recoveryKit: authority.prepared.recoveryKit,
      identifierMappings: [],
      session,
    });
    const stages: string[] = [];
    const jobs = {
      openCheckpoint: vi.fn(async () => Uint8Array.from(encoded)),
      sealCheckpoint: vi.fn(async () => undefined),
      save: vi.fn(async (replacement: VaultReplacementJobV1, expectedUpdatedAt: string) => {
        expect(current.updatedAt).toBe(expectedUpdatedAt);
        current = replacement;
        stages.push(replacement.stage);
      }),
    };
    const graph = {
      target,
      replacement: {
        generation: target.records.generation,
        head: target.records.head,
        objects: [],
        events: [],
        identifierMappings: [],
        preparedArtifactObjectIds: [],
      } as unknown as PreparedVaultReplacement,
    };
    const local = {
      hasStagedVaultReplacement: vi.fn(async () => true),
      loadStagedGraph: vi.fn(async () => graph),
      loadReplacementNameCache: vi.fn(async () => ({
        version: 1 as const,
        vaultId: target.records.metadata.vaultId,
        sourceEventId: id(30),
        nonce: new Uint8Array(12),
        ciphertext: new Uint8Array(16),
      })),
      loadReplacementAccessToken: vi.fn(async () => session.accessToken),
    };
    const useSession = vi.fn();
    const remote = {
      useAccessToken: vi.fn(),
      useSession,
      activate: vi.fn(async () => ({
        sourceVaultId: current.sourceVaultId,
        targetVaultId: target.records.metadata.vaultId,
        targetHeadCursor: 1,
        purge: {
          purgeId: id(31),
          state: "Pending" as const,
          stage: "Detach" as const,
          processedBytes: 0,
          totalBytes: 10,
        },
      })),
      purgeStatus: vi.fn(async () => ({
        purgeId: id(31),
        state: "Pending" as const,
        stage: "Detach" as const,
        processedBytes: 0,
        totalBytes: 10,
      })),
    };
    const uploader = {
      run: vi.fn(async () => undefined),
    };
    const validation = {
      validateRemoteGraph: vi.fn(async () => undefined),
    };
    const promoter = {
      promote: vi.fn(async ({ job }: { job: VaultReplacementJobV1 }) => {
        current = {
          ...job,
          stage: "PurgeSource",
          updatedAt: "2026-07-25T20:09:00.000Z",
        };
        return current;
      }),
      finishServerPurge: vi.fn(),
    };
    let tick = 2;
    const runner = new VaultReplacementRunner(
      jobs,
      local,
      remote as unknown as VaultReplacementRemote,
      uploader as unknown as VaultReplacementGraphUploader,
      validation,
      promoter as unknown as VaultReplacementLocalPromoter,
      () => `2026-07-25T20:${String(tick++).padStart(2, "0")}:00.000Z`,
    );

    const result = await runner.run(current, account);

    expect(stages).toEqual(["Upload", "CompleteRemote", "ActivateRemote", "PromoteLocal"]);
    expect(result.stage).toBe("PurgeSource");
    expect(uploader.run).toHaveBeenCalledOnce();
    expect(validation.validateRemoteGraph).toHaveBeenCalledOnce();
    expect(remote.activate).toHaveBeenCalledOnce();
    expect(promoter.promote).toHaveBeenCalledOnce();
    expect(remote.purgeStatus).toHaveBeenCalledOnce();
    expect(useSession).toHaveBeenCalledWith(session);
    await wipeReplacementAuthority(authority.prepared);
  });

  it("finishes a promoted purge from installed Device authority without a checkpoint", async () => {
    const target = await new VaultService({
      load: async () => undefined,
      setManualLock: async () => undefined,
    }).prepareCreate({
      name: "Archive",
      createdAt: "2026-07-25T20:00:00.000Z",
    });
    const promoted = {
      ...jobFor(target),
      stage: "PurgeSource" as const,
      targetHeadCursor: 1,
      purgeId: id(40),
    };
    const openCheckpoint = vi.fn();
    const completed = {
      ...promoted,
      state: "Succeeded" as const,
      stage: "Terminal" as const,
    };
    const remote = {
      useAccessToken: vi.fn(),
      useSession: vi.fn(),
      purgeStatus: vi.fn(async () => ({
        purgeId: id(40),
        state: "Succeeded" as const,
        stage: "Complete" as const,
        processedBytes: 10,
        totalBytes: 10,
      })),
    };
    const promoter = {
      finishServerPurge: vi.fn(async () => completed),
    };
    const runner = new VaultReplacementRunner(
      {
        openCheckpoint,
        save: vi.fn(),
        sealCheckpoint: vi.fn(),
      },
      {
        hasStagedVaultReplacement: vi.fn(),
        loadStagedGraph: vi.fn(),
        loadReplacementNameCache: vi.fn(),
        loadReplacementAccessToken: vi.fn(async () => session.accessToken),
      },
      remote as unknown as VaultReplacementRemote,
      { run: vi.fn() } as unknown as VaultReplacementGraphUploader,
      { validateRemoteGraph: vi.fn() },
      promoter as unknown as VaultReplacementLocalPromoter,
    );

    await expect(runner.run(promoted, account)).resolves.toEqual(completed);
    expect(openCheckpoint).not.toHaveBeenCalled();
    expect(remote.useAccessToken).toHaveBeenCalledWith(session.accessToken);
    expect(promoter.finishServerPurge).toHaveBeenCalledOnce();
  });
});
