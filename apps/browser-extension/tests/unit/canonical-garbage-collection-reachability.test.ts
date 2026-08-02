import { describe, expect, it } from "vitest";

import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { advisoryExtensions } from "../../src/domain/canonical/features";
import { identifier } from "../../src/domain/canonical/identifiers";
import { encodeVaultBaseline, signVaultEvent } from "../../src/domain/canonical/record";
import { type CanonicalValue, canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { collectReplicaGarbageCollectionReachability } from "../../src/runtime/storage/garbage-collection-reachability";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

function key(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

async function fixture() {
  const creation = await prepareCanonicalVaultCreation({ label: "Research", assertedAt: 1 });
  const predecessorContent = await signVaultEvent(
    {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      parentRecordIds: [creation.genesis.recordId],
      authorityParentRecordIds: [creation.genesis.recordId],
      dependencies: [],
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 2,
      type: 1,
      signerCredentialId: creation.ids.clientCredentialId,
      assertedAt: 2,
      body: indexedMap("Predecessor label"),
    },
    creation.secrets.client.signingSecretKey,
  );
  const successorGenerationId = filled("Generation", 34);
  const successor = encodeVaultBaseline({
    ...creation.baseline,
    generationId: successorGenerationId,
  });
  const vacuum = await signVaultEvent(
    {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      parentRecordIds: [predecessorContent.recordId],
      authorityParentRecordIds: [creation.genesis.recordId],
      dependencies: [{ type: DEPENDENCY_TYPES.VaultBaseline, id: successor.recordId }],
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 3,
      type: 1,
      signerCredentialId: creation.ids.clientCredentialId,
      assertedAt: 3,
      body: indexedMap(
        creation.ids.generationId,
        canonicalSet([predecessorContent.recordId]),
        successorGenerationId,
        successor.recordId,
        new Uint8Array(32).fill(35),
        new Uint8Array(32).fill(36),
        new Uint8Array(32).fill(37),
      ),
    },
    creation.secrets.client.signingSecretKey,
  );
  const records = new Map(
    [creation.baseline, creation.genesis, predecessorContent, successor, vacuum].map((record) => [
      key(record.recordId),
      record,
    ]),
  );
  return { creation, predecessorContent, successor, successorGenerationId, vacuum, records };
}

describe("canonical Replica Garbage Collection reachability", () => {
  it("reclaims predecessor Content and the Initial Baseline after adopted Vacuum", async () => {
    const subject = await fixture();
    subject.records.delete(key(subject.creation.baseline.recordId));

    const reachable = await collectReplicaGarbageCollectionReachability({
      vaultId: subject.creation.ids.vaultId,
      generationId: subject.successorGenerationId,
      requiredFeatureSetId: subject.creation.genesis.requiredFeatureSetId,
      baselineId: subject.successor.recordId,
      causalFrontier: [subject.successor.recordId],
      authorityFrontier: [subject.vacuum.recordId],
      continuityRecordIds: [subject.creation.genesis.recordId, subject.vacuum.recordId],
      preservationRoots: [],
      adopted: true,
      loadRecord: async (id) => subject.records.get(key(id)),
      loadObject: async () => undefined,
    });

    expect([...reachable.recordIds].map(key).toSorted()).toEqual(
      [subject.creation.genesis.recordId, subject.successor.recordId, subject.vacuum.recordId]
        .map(key)
        .toSorted(),
    );
    expect([...reachable.recordIds].map(key)).not.toContain(
      key(subject.predecessorContent.recordId),
    );
    expect([...reachable.recordIds].map(key)).not.toContain(
      key(subject.creation.baseline.recordId),
    );
  });

  it("retains a predecessor branch and its Initial Baseline through a preservation root", async () => {
    const subject = await fixture();

    const reachable = await collectReplicaGarbageCollectionReachability({
      vaultId: subject.creation.ids.vaultId,
      generationId: subject.successorGenerationId,
      requiredFeatureSetId: subject.creation.genesis.requiredFeatureSetId,
      baselineId: subject.successor.recordId,
      causalFrontier: [subject.successor.recordId],
      authorityFrontier: [subject.vacuum.recordId],
      continuityRecordIds: [subject.creation.genesis.recordId, subject.vacuum.recordId],
      preservationRoots: [subject.predecessorContent.recordId],
      adopted: true,
      loadRecord: async (id) => subject.records.get(key(id)),
      loadObject: async () => undefined,
    });

    expect([...reachable.recordIds].map(key)).toEqual(
      expect.arrayContaining([
        key(subject.predecessorContent.recordId),
        key(subject.creation.baseline.recordId),
      ]),
    );
  });
});
