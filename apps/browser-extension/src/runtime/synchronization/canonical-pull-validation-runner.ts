import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import { decodeOpaqueEnvelope } from "../../storage/opaque-envelope";
import type { EpochSecretState } from "../vault/canonical-local-state";
import {
  type CanonicalPulledCompactCandidate,
  classifyPulledCompactCandidate,
} from "./canonical-pull-candidate";
import {
  type CanonicalPullSynchronizationJob,
  encodeCanonicalPullSynchronizationJob,
} from "./canonical-state";

type QuarantineReader = {
  readonly readQuarantine: (input: {
    readonly remoteId: string;
    readonly storageItemId: Identifier<"StorageItem">;
  }) => Promise<Uint8Array | undefined>;
};

/**
 * Opens retained Compact Quarantine input into authenticated candidates without promoting it.
 * Authority, dependency, DAG, and Replica-state validation remain the next trusted boundary.
 */
export class CanonicalPullValidationRunner {
  constructor(private readonly dependencies: QuarantineReader) {}

  async run(input: {
    readonly remote: {
      readonly remoteId: string;
      readonly locatorSalt: Uint8Array;
    };
    readonly job: CanonicalPullSynchronizationJob;
    readonly epochSecrets: readonly EpochSecretState[];
  }): Promise<{
    readonly candidates: readonly CanonicalPulledCompactCandidate[];
    readonly unclassifiedStorageItemIds: readonly Identifier<"StorageItem">[];
  }> {
    encodeCanonicalPullSynchronizationJob(input.job);
    if (input.job.remoteId !== input.remote.remoteId) {
      throw new TypeError(
        "Synchronization Job Remote does not match the configured Replica Remote",
      );
    }
    if (input.job.state !== 1 || input.job.stage !== 2) {
      throw new TypeError(
        "Pull validation requires an active validation-stage Synchronization Job",
      );
    }

    const candidates: CanonicalPulledCompactCandidate[] = [];
    const unclassifiedStorageItemIds: Identifier<"StorageItem">[] = [];
    for (const reference of input.job.quarantineReferences) {
      const bytes = await this.dependencies.readQuarantine({
        remoteId: input.remote.remoteId,
        storageItemId: reference.storageItemId,
      });
      if (bytes === undefined) {
        throw new TypeError("Synchronization Job Quarantine bytes are unavailable");
      }
      const envelope = decodeOpaqueEnvelope(bytes);
      if (!bytesEqual(envelope.storageItemId, reference.storageItemId)) {
        throw new TypeError("Synchronization Job Quarantine bytes do not match their reference");
      }
      const candidate = await classifyPulledCompactCandidate({
        vaultId: input.job.vaultId,
        epochSecrets: input.epochSecrets,
        envelopeBytes: bytes,
        locatorSalt: input.remote.locatorSalt,
        locator: reference.locator,
      });
      if (candidate === null) {
        unclassifiedStorageItemIds.push(reference.storageItemId);
      } else {
        candidates.push(candidate);
      }
    }
    return { candidates, unclassifiedStorageItemIds };
  }
}
