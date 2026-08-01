import { describe, expect, it } from "vitest";

import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { advisoryExtensions } from "../../src/domain/canonical/features";
import { identifier } from "../../src/domain/canonical/identifiers";
import {
  ARTIFACT_OBJECT,
  artifactId,
  BUNDLE_DESCRIPTOR_OBJECT,
  encodeVaultObject,
} from "../../src/domain/canonical/object";
import { encodeVaultBaseline, signVaultEvent } from "../../src/domain/canonical/record";
import { type CanonicalValue, canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { collectCompleteExportReachability } from "../../src/runtime/complete-export/reachability";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

function keys(values: readonly Uint8Array[]): string[] {
  return values.map((value) => Buffer.from(value).toString("hex")).toSorted();
}

async function fixture() {
  const creation = await prepareCanonicalVaultCreation({ label: "Research", assertedAt: 1 });
  const artifactDigest = filled("Artifact", 10);
  const artifactObject = encodeVaultObject({
    vaultId: creation.ids.vaultId,
    objectType: ARTIFACT_OBJECT,
    requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
    extensions: advisoryExtensions([]),
    body: indexedMap(
      1,
      "awsm.artifact.capture",
      "application/vnd.awsm.web-page+zip",
      "awsm.representation.web-page-zip",
      0,
      artifactDigest,
      indexedMap(1, 1_048_576, 16, 0, artifactDigest),
      new Uint8Array([0xa1, 0x00, 0x01]),
    ),
  });
  const bundleId = filled("Bundle", 11);
  const descriptor = encodeVaultObject({
    vaultId: creation.ids.vaultId,
    objectType: BUNDLE_DESCRIPTOR_OBJECT,
    requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
    extensions: advisoryExtensions([]),
    body: indexedMap(
      1,
      bundleId,
      2,
      "https://example.com/",
      "https://example.com/",
      "awsm.capture.web-page-snapshot",
      "awsm.adapter.browser-web-page",
      1,
      "Example",
      canonicalSet([indexedMap(artifactObject.objectId, "awsm.artifact.primary")]),
      [],
      indexedMap(1, new Uint8Array([0xa1, 0x00, 0x01])),
    ),
  });
  const capture = await signVaultEvent(
    {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      parentRecordIds: [creation.genesis.recordId],
      authorityParentRecordIds: [creation.genesis.recordId],
      dependencies: [{ type: DEPENDENCY_TYPES.BundleDescriptorObject, id: descriptor.objectId }],
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 2,
      type: 3,
      signerCredentialId: creation.ids.clientCredentialId,
      assertedAt: 2,
      body: indexedMap(bundleId, descriptor.objectId, filled("Collection", 12)),
    },
    creation.secrets.client.signingSecretKey,
  );
  return { creation, artifactObject, descriptor, capture };
}

describe("Complete Export logical reachability", () => {
  it("collects exact causal, Continuity, Object, Key Envelope, and Artifact closure", async () => {
    const { creation, artifactObject, descriptor, capture } = await fixture();
    const records = new Map([
      [Buffer.from(creation.baseline.recordId).toString("hex"), creation.baseline],
      [Buffer.from(creation.genesis.recordId).toString("hex"), creation.genesis],
      [Buffer.from(capture.recordId).toString("hex"), capture],
    ]);
    const objects = new Map([
      [Buffer.from(descriptor.objectId).toString("hex"), descriptor],
      [Buffer.from(artifactObject.objectId).toString("hex"), artifactObject],
    ]);
    const result = await collectCompleteExportReachability({
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      baselineId: creation.baseline.recordId,
      causalFrontier: [capture.recordId],
      authorityFrontier: [creation.genesis.recordId],
      loadRecord: async (id) => records.get(Buffer.from(id).toString("hex")),
      loadObject: async (id) => objects.get(Buffer.from(id).toString("hex")),
    });

    expect(keys(result.recordIds)).toEqual(
      keys([creation.baseline.recordId, creation.genesis.recordId, capture.recordId]),
    );
    expect(keys(result.vaultObjectIds)).toEqual(
      keys([descriptor.objectId, artifactObject.objectId]),
    );
    expect(keys(result.keyEnvelopeIds)).toEqual(
      keys([creation.recoveryKeyEnvelope.id, creation.clientKeyEnvelope.id]),
    );
    expect(keys(result.artifactIds)).toEqual(keys([artifactId(artifactObject)]));
    expect(result.featureManifestIds).toEqual([]);
    expect(result.typedLogicalRoots).toEqual([
      { type: DEPENDENCY_TYPES.VaultRecord, id: capture.recordId },
      { type: DEPENDENCY_TYPES.VaultBaseline, id: creation.baseline.recordId },
    ]);
  });

  it("fails closed when a reachable authenticated dependency is absent", async () => {
    const { creation, capture } = await fixture();
    const records = new Map([
      [Buffer.from(creation.baseline.recordId).toString("hex"), creation.baseline],
      [Buffer.from(creation.genesis.recordId).toString("hex"), creation.genesis],
      [Buffer.from(capture.recordId).toString("hex"), capture],
    ]);

    await expect(
      collectCompleteExportReachability({
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        baselineId: creation.baseline.recordId,
        causalFrontier: [capture.recordId],
        authorityFrontier: [creation.genesis.recordId],
        loadRecord: async (id) => records.get(Buffer.from(id).toString("hex")),
        loadObject: async () => undefined,
      }),
    ).rejects.toThrow(/reachable Vault Object is unavailable/u);
  });

  it("rejects causal Records from outside the selected Generation", async () => {
    const { creation, capture } = await fixture();
    const records = new Map([
      [Buffer.from(creation.baseline.recordId).toString("hex"), creation.baseline],
      [Buffer.from(creation.genesis.recordId).toString("hex"), creation.genesis],
      [Buffer.from(capture.recordId).toString("hex"), capture],
    ]);

    await expect(
      collectCompleteExportReachability({
        vaultId: creation.ids.vaultId,
        generationId: filled("Generation", 99),
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        baselineId: creation.baseline.recordId,
        causalFrontier: [capture.recordId],
        authorityFrontier: [creation.genesis.recordId],
        loadRecord: async (id) => records.get(Buffer.from(id).toString("hex")),
        loadObject: async () => undefined,
      }),
    ).rejects.toThrow(/selected Generation/u);
  });

  it("does not retain unrelated causal Content parents of Continuity-only Events", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: null, assertedAt: 1 });
    const successorGenerationId = filled("Generation", 31);
    const successor = encodeVaultBaseline({
      ...creation.baseline,
      generationId: successorGenerationId,
    });
    const omittedContentParent = filled("VaultRecord", 32);
    const vacuum = await signVaultEvent(
      {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        parentRecordIds: [omittedContentParent],
        authorityParentRecordIds: [creation.genesis.recordId],
        dependencies: [{ type: DEPENDENCY_TYPES.VaultBaseline, id: successor.recordId }],
        requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 3,
        type: 1,
        signerCredentialId: creation.ids.clientCredentialId,
        assertedAt: 2,
        body: indexedMap(
          creation.ids.generationId,
          canonicalSet([omittedContentParent]),
          successorGenerationId,
          successor.recordId,
          new Uint8Array(32).fill(1),
          new Uint8Array(32).fill(2),
          new Uint8Array(32).fill(3),
        ),
      },
      creation.secrets.client.signingSecretKey,
    );
    const records = new Map([
      [Buffer.from(creation.baseline.recordId).toString("hex"), creation.baseline],
      [Buffer.from(creation.genesis.recordId).toString("hex"), creation.genesis],
      [Buffer.from(successor.recordId).toString("hex"), successor],
      [Buffer.from(vacuum.recordId).toString("hex"), vacuum],
    ]);

    const result = await collectCompleteExportReachability({
      vaultId: creation.ids.vaultId,
      generationId: successorGenerationId,
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      baselineId: successor.recordId,
      causalFrontier: [successor.recordId],
      authorityFrontier: [vacuum.recordId],
      loadRecord: async (id) => records.get(Buffer.from(id).toString("hex")),
      loadObject: async () => undefined,
    });

    expect(keys(result.recordIds)).toEqual(
      keys([
        creation.baseline.recordId,
        creation.genesis.recordId,
        successor.recordId,
        vacuum.recordId,
      ]),
    );
    expect(keys(result.recordIds)).not.toContain(Buffer.from(omittedContentParent).toString("hex"));
  });
});
