import type { StoredVaultHeadV1 } from "../../drivers/indexeddb/schema";
import type {
  StorageReliefCheckpointV1,
  StorageReliefJobV1,
  StoredRemoteOnlyArtifactV1,
} from "../../drivers/indexeddb/storage-relief-schema";
import type { VaultKeyring } from "../vault/keyring";
import type { StorageReliefEstimate } from "./candidates";
import { storageReliefError } from "./contracts";

interface StorageReliefServiceRepository {
  getVaultHead(): Promise<StoredVaultHeadV1 | undefined>;
  listRemoteOnlyArtifacts(vaultId: string): Promise<readonly StoredRemoteOnlyArtifactV1[]>;
  createStorageReliefJob(input: {
    readonly job: StorageReliefJobV1;
    readonly expectedLocalHead: StoredVaultHeadV1;
    readonly expectedAvailability: readonly StoredRemoteOnlyArtifactV1[];
    readonly candidates: readonly StorageReliefCheckpointV1[];
  }): Promise<void>;
}

interface StorageReliefEnumerator {
  enumerate(vaultId: string, keyring: VaultKeyring): Promise<StorageReliefEstimate>;
}

interface StartStorageReliefInput {
  readonly vaultId: string;
  readonly keyring: VaultKeyring;
  readonly accountId: string;
  readonly serverOrigin: string;
  readonly candidateArtifacts: number;
  readonly candidateBytes: number;
  readonly now: string;
  readonly signal?: AbortSignal;
}

interface StorageReliefCreationFaults {
  afterJobCreated?(signal?: AbortSignal): Promise<void>;
  afterCandidateCheckpoint?(signal?: AbortSignal): Promise<void>;
}

export class StorageReliefService {
  constructor(
    private readonly repository: StorageReliefServiceRepository,
    private readonly enumerator: StorageReliefEnumerator,
    private readonly uuid: () => string = () => crypto.randomUUID(),
    private readonly faults: StorageReliefCreationFaults = {},
  ) {}

  estimate(vaultId: string, keyring: VaultKeyring): Promise<StorageReliefEstimate> {
    return this.enumerator.enumerate(vaultId, keyring);
  }

  async start(input: StartStorageReliefInput): Promise<{ readonly jobId: string }> {
    const [head, availability, estimate] = await Promise.all([
      this.repository.getVaultHead(),
      this.repository.listRemoteOnlyArtifacts(input.vaultId),
      this.enumerator.enumerate(input.vaultId, input.keyring),
    ]);
    if (head === undefined || head.vaultId !== input.vaultId)
      throw storageReliefError("VAULT_CONTEXT_CHANGED", "The active Vault head is unavailable.");
    if (
      estimate.candidateArtifacts !== input.candidateArtifacts ||
      estimate.candidateBytes !== input.candidateBytes
    )
      throw storageReliefError(
        "STORAGE_RELIEF_ESTIMATE_CHANGED",
        "The storage-relief estimate changed.",
      );
    const jobId = this.uuid();
    const job: StorageReliefJobV1 = {
      version: 1,
      vaultId: input.vaultId,
      jobId,
      state: "Created",
      stage: "Synchronize",
      createdAt: input.now,
      updatedAt: input.now,
      expectedServerOrigin: input.serverOrigin,
      expectedAccountId: input.accountId,
      candidateArtifacts: estimate.candidateArtifacts,
      candidateBytes: estimate.candidateBytes,
      verifiedArtifacts: 0,
      verifiedBytes: 0,
      evictedArtifacts: 0,
      freedBytes: 0,
      skippedArtifacts: 0,
      skippedBytes: 0,
      cancellationRequested: false,
    };
    const candidates: StorageReliefCheckpointV1[] = estimate.candidates.map((candidate) => ({
      version: 1,
      vaultId: input.vaultId,
      jobId,
      artifactObjectId: candidate.object.objectId,
      keyEpochId: candidate.object.keyEpochId,
      envelopeByteLength: candidate.object.envelopeByteLength,
      envelopeChecksum: candidate.object.envelopeChecksum,
      state: "Candidate",
    }));
    await this.repository.createStorageReliefJob({
      job,
      expectedLocalHead: head,
      expectedAvailability: availability,
      candidates,
    });
    await this.faults.afterJobCreated?.(input.signal);
    await this.faults.afterCandidateCheckpoint?.(input.signal);
    return { jobId };
  }
}
