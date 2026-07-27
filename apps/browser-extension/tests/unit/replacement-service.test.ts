import { describe, expect, it, vi } from "vitest";

import type {
  ExportJobV1,
  StoredAccountMetadataV1,
  VaultReplacementJobV1,
} from "../../src/drivers/indexeddb/schema";
import type { AtomicVaultReplacementStage } from "../../src/drivers/indexeddb/workspace-repository";
import { decodeVaultReplacementSensitiveCheckpoint } from "../../src/runtime/recovery/replacement-checkpoint";
import {
  type ReplacementSourceSnapshot,
  VaultReplacementService,
} from "../../src/runtime/recovery/replacement-service";
import { prepareVaultNameChange } from "../../src/runtime/vault/name-crypto";
import { VaultService } from "../../src/runtime/vault/service";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

async function fixture() {
  const prepared = await new VaultService({
    load: async () => undefined,
    setManualLock: async () => undefined,
  }).prepareCreate({
    name: "Archive",
    createdAt: "2026-07-25T20:00:00.000Z",
  });
  const name = await prepareVaultNameChange({
    keyring: prepared.keyring,
    eventType: "VaultCreated",
    vaultId: prepared.records.metadata.vaultId,
    deviceId: prepared.records.metadata.deviceId,
    eventId: id(10),
    timestamp: "2026-07-25T20:00:00.000Z",
    name: "Archive",
  });
  const head = {
    ...prepared.records.head,
    appendedEventIds: [name.event.eventId],
  };
  const source: ReplacementSourceSnapshot = {
    records: {
      ...prepared.records,
      head,
    },
    head,
    headCursor: 7,
    keyring: prepared.keyring,
    events: [name.event],
    objects: [],
  };
  const latestExport: ExportJobV1 = {
    version: 1,
    vaultId: head.vaultId,
    jobId: id(11),
    packageId: id(12),
    state: "Succeeded",
    stage: "Download",
    createdAt: "2026-07-25T20:01:00.000Z",
    updatedAt: "2026-07-25T20:02:00.000Z",
    completedEntries: 1,
    totalEntries: 1,
    processedBytes: 1,
    totalBytes: 1,
    cancellationRequested: false,
    verifiedSnapshot: {
      vaultId: head.vaultId,
      generationId: head.generationId,
      generationNumber: head.generationNumber,
      appendedObjectIds: head.appendedObjectIds,
      appendedEventIds: head.appendedEventIds,
      coverage: "Complete",
      verifiedAt: "2026-07-25T20:01:59.000Z",
      downloadedAt: "2026-07-25T20:02:00.000Z",
    },
  };
  const account: StoredAccountMetadataV1 = {
    version: 1,
    accountId: id(1),
    sessionId: id(2),
    username: "owner_test",
    inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
    scope: "Account",
  };
  return { account, latestExport, source };
}

function harness() {
  const jobs = new Map<string, VaultReplacementJobV1>();
  let sealed: Uint8Array | undefined;
  const stageVaultReplacement = vi.fn(async (_input: AtomicVaultReplacementStage) => undefined);
  const discardStagedVaultReplacement = vi.fn(async () => undefined);
  let nextId = 100;
  const repository = {
    create: async (job: VaultReplacementJobV1) => {
      jobs.set(job.jobId, job);
    },
    find: async (jobId: string) => jobs.get(jobId),
    save: async (job: VaultReplacementJobV1, expectedUpdatedAt: string) => {
      expect(jobs.get(job.jobId)?.updatedAt).toBe(expectedUpdatedAt);
      jobs.set(job.jobId, job);
    },
    sealCheckpoint: async ({ plaintext }: { readonly plaintext: Uint8Array }) => {
      sealed = Uint8Array.from(plaintext);
    },
    clearSensitive: async () => undefined,
  };
  const workspace = {
    stageVaultReplacement,
    discardStagedVaultReplacement,
  };
  const artifacts = {
    openPlaintext: vi.fn(),
    prepare: vi.fn(),
    remove: vi.fn(async () => undefined),
  };
  let tick = 0;
  const makeService = () =>
    new VaultReplacementService(
      repository,
      workspace,
      artifacts,
      () => id(nextId++),
      () => `2026-07-25T21:${String(tick++).padStart(2, "0")}:00.000Z`,
    );
  const service = makeService();
  return {
    discardStagedVaultReplacement,
    jobs,
    restart: makeService,
    service,
    stageVaultReplacement,
    sealed: () => sealed,
  };
}

describe("Vault replacement orchestration", () => {
  it("requires an exact verified Complete Export before preparing authority", async () => {
    const { account, source } = await fixture();
    const { jobs, service } = harness();

    await expect(
      service.prepare({
        account,
        source,
        latestExport: undefined,
        safelyStoredConfirmed: true,
        vaultName: "Archive",
        displayName: "Firefox",
        clientKind: "FirefoxExtension",
      }),
    ).rejects.toMatchObject({ id: "VAULT_REPLACEMENT_EXPORT_REQUIRED" });
    expect(jobs.size).toBe(0);
  });

  it("keeps phrase confirmation retryable and seals only post-confirmation authority", async () => {
    const { account, latestExport, source } = await fixture();
    const { jobs, sealed, service, stageVaultReplacement } = harness();
    const prepared = await service.prepare({
      account,
      source,
      latestExport,
      safelyStoredConfirmed: true,
      vaultName: "Archive",
      displayName: "Firefox",
      clientKind: "FirefoxExtension",
    });
    const waiting = jobs.get(prepared.replacementId);

    await expect(
      service.confirmAndStage({
        replacementId: prepared.replacementId,
        recoveryPhrase: prepared.recoveryPhrase
          .split(" ")
          .map((word, index) => (index === 0 ? "notaword" : word))
          .join(" "),
        source,
      }),
    ).rejects.toMatchObject({ id: "RECOVERY_PHRASE_INVALID" });
    expect(jobs.get(prepared.replacementId)).toEqual(waiting);
    expect(stageVaultReplacement).not.toHaveBeenCalled();

    const staged = await service.confirmAndStage({
      replacementId: prepared.replacementId,
      recoveryPhrase: prepared.recoveryPhrase,
      source,
    });

    expect(staged).toMatchObject({
      state: "Running",
      stage: "StageRemote",
      verifiedExportJobId: latestExport.jobId,
    });
    expect(stageVaultReplacement).toHaveBeenCalledOnce();
    const checkpointBytes = sealed();
    if (checkpointBytes === undefined) throw new Error("Expected a sealed replacement checkpoint.");
    const checkpoint = decodeVaultReplacementSensitiveCheckpoint(checkpointBytes);
    expect(checkpoint).toMatchObject({
      targetVaultId: staged.targetVaultId,
      accountSessionId: account.sessionId,
    });
    expect(new TextDecoder().decode(checkpointBytes)).not.toContain(prepared.recoveryPhrase);
  });

  it("terminally fails source drift without exposing a staged target", async () => {
    const { account, latestExport, source } = await fixture();
    const { jobs, service, stageVaultReplacement } = harness();
    const prepared = await service.prepare({
      account,
      source,
      latestExport,
      safelyStoredConfirmed: true,
      vaultName: "Archive",
      displayName: "Chrome",
      clientKind: "ChromeExtension",
    });

    await expect(
      service.confirmAndStage({
        replacementId: prepared.replacementId,
        recoveryPhrase: prepared.recoveryPhrase,
        source: { ...source, headCursor: source.headCursor + 1 },
      }),
    ).rejects.toMatchObject({ id: "VAULT_REPLACEMENT_CONFLICT" });

    expect(jobs.get(prepared.replacementId)).toMatchObject({
      state: "Failed",
      stage: "Terminal",
      errorId: "VAULT_REPLACEMENT_CONFLICT",
    });
    expect(stageVaultReplacement).not.toHaveBeenCalled();
  });

  it("cancels an interrupted pre-confirmation ceremony after restart", async () => {
    const { account, latestExport, source } = await fixture();
    const { jobs, restart, service } = harness();
    const prepared = await service.prepare({
      account,
      source,
      latestExport,
      safelyStoredConfirmed: true,
      vaultName: "Archive",
      displayName: "Firefox",
      clientKind: "FirefoxExtension",
    });

    await restart().cancel(prepared.replacementId);

    expect(jobs.get(prepared.replacementId)).toMatchObject({
      state: "Aborted",
      stage: "Terminal",
    });
  });
});
