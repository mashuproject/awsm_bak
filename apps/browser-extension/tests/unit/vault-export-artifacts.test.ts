import { BlobWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import { writeArtifactEnvelope } from "../../src/crypto/artifact-envelope";
import { deriveContextKeyFromCryptoKey } from "../../src/crypto/hkdf";
import type { ArtifactReferenceV1, CaptureMetadataV1 } from "../../src/domain/artifact-graph";
import {
  encodeStructuredContentSequence,
  normalizedTextFromBlocks,
} from "../../src/domain/structured-content";
import type {
  StoredArtifactObjectV1,
  StoredEvent,
  StoredObjectV1,
  StoredVaultGenerationV1,
  StoredVaultHeadV1,
} from "../../src/drivers/indexeddb/schema";
import type { ArtifactStore } from "../../src/runtime/artifact";
import {
  type PreparedCaptureArtifact,
  prepareCaptureRegistration,
} from "../../src/runtime/capture/registration";
import {
  VaultExportService,
  type VaultExportSource,
  validateVaultPackage,
  withAuthenticatedVaultPackage,
  writeVaultPackage,
} from "../../src/runtime/export";
import { prepareImportedArtifacts } from "../../src/runtime/import/artifacts";
import { prepareImportedVaultCredentials } from "../../src/runtime/import/credentials";
import { createPageSnapshotBlob } from "../../src/runtime/page-snapshot";
import { type VaultRecordsV1, type VaultRepository, VaultService } from "../../src/runtime/vault";
import { prepareVaultNameChange } from "../../src/runtime/vault/name-crypto";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

async function packageFixture(entries: Parameters<typeof writeVaultPackage>[1]): Promise<Blob> {
  const output = new BlobWriter("application/vnd.awsm.vault+zip");
  await writeVaultPackage(output, entries);
  return output.getData();
}

class MemoryVaultRepository implements VaultRepository {
  records: VaultRecordsV1 | undefined;
  async load(): Promise<VaultRecordsV1 | undefined> {
    return this.records;
  }
  async setManualLock(): Promise<void> {}
}

class MemoryExportSource implements VaultExportSource {
  constructor(
    readonly head: StoredVaultHeadV1,
    readonly generation: StoredVaultGenerationV1,
    readonly events: ReadonlyMap<string, StoredEvent>,
    readonly objects: ReadonlyMap<string, StoredObjectV1>,
  ) {}
  async getVaultHead() {
    return this.head;
  }
  async getVaultGeneration() {
    return this.generation;
  }
  async getStoredEvent(value: string) {
    return this.events.get(value);
  }
  async getStoredObject(value: string) {
    return this.objects.get(value);
  }
  async listAuthoritativeIds() {
    return {
      eventIds: [...this.events.keys()].toSorted(),
      objectIds: [...this.objects.keys()].toSorted(),
    };
  }
}

class MemoryArtifactStore {
  readonly encrypted = new Map<string, Uint8Array>();
  readonly imported = new Map<string, Uint8Array>();
  openEncrypted(_vaultId: string, objectId: string): Promise<ReadableStream<Uint8Array>> {
    const bytes = this.encrypted.get(objectId);
    if (bytes === undefined) throw new Error("missing Artifact");
    return Promise.resolve(new Blob([Uint8Array.from(bytes).buffer]).stream());
  }
  async prepareEncrypted(input: {
    readonly object: StoredArtifactObjectV1;
    readonly encrypted: ReadableStream<Uint8Array>;
  }): Promise<void> {
    this.imported.set(
      input.object.objectId,
      new Uint8Array(await new Response(input.encrypted).arrayBuffer()),
    );
  }
}

async function prepareArtifact(
  store: MemoryArtifactStore,
  rootKey: CryptoKey,
  vaultId: string,
  objectId: string,
  plaintext: Uint8Array,
  role: ArtifactReferenceV1["role"],
  kind: ArtifactReferenceV1["kind"],
  mimeType: string,
  acquiredAt: string,
): Promise<PreparedCaptureArtifact> {
  const key = await deriveContextKeyFromCryptoKey(rootKey, {
    vaultId,
    domain: "vault:artifact:v1",
    contextId: objectId,
    keyVersion: 1,
  });
  const chunks: Uint8Array[] = [];
  const summary = await writeArtifactEnvelope({
    objectId,
    key,
    noncePrefix: new Uint8Array(16).fill(Number(objectId.slice(-1))),
    plaintext: (async function* () {
      yield plaintext;
    })(),
    write: (chunk) => {
      chunks.push(Uint8Array.from(chunk));
    },
  });
  const encrypted = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    encrypted.set(chunk, offset);
    offset += chunk.byteLength;
  }
  store.encrypted.set(objectId, encrypted);
  const object: StoredArtifactObjectV1 = {
    version: 1,
    objectId,
    objectType: "Artifact",
    envelopeFormat: "artifact:xchacha20poly1305-chunked:v1",
    envelopeByteLength: summary.envelopeByteLength,
    envelopeChecksumAlgorithm: "hash:sha256:v1",
    envelopeChecksum: summary.envelopeChecksum,
  };
  return {
    object,
    reference: {
      artifactVersion: 1,
      artifactObjectId: objectId,
      kind,
      role,
      mimeType,
      acquiredAt,
      plaintextByteLength: summary.plaintextByteLength,
      checksumAlgorithm: "hash:sha256:v1",
      plaintextChecksum: summary.plaintextChecksum,
    },
  };
}

describe("Artifact graph Vault Export", () => {
  it("validates Complete and Selective packages against the exact active Generation", async () => {
    const repository = new MemoryVaultRepository();
    const creator = new VaultService(repository);
    const preparedVault = await creator.prepareCreate({
      name: "Amber Archive",
      createdAt: "2026-07-18T20:00:00.000Z",
    });
    repository.records = preparedVault.records;
    const vault = new VaultService(repository, preparedVault.records.metadata.vaultId);
    vault.activatePrepared(preparedVault);
    const vaultId = preparedVault.records.metadata.vaultId;
    const capturedAt = "2026-07-18T20:00:30.000Z";
    const metadata: CaptureMetadataV1 = {
      version: 1,
      originalUrl: "https://fixture.test/article",
      finalUrl: "https://fixture.test/article",
      title: "Fixture",
      capturedAt,
      contentType: "text/html",
      viewport: { width: 800, height: 600 },
      document: { width: 800, height: 1200 },
      browserName: "Chrome",
      browserVersion: "149",
      extensionVersion: "0.1.0",
      captureProfileId: "WebPageSnapshot-v1",
      captureProfileVersion: 1,
    };
    const blocks = [
      {
        blockVersion: 1 as const,
        blockId: "B000001",
        kind: "Paragraph" as const,
        text: "Fixture text",
        links: [],
      },
    ];
    const structured = encodeStructuredContentSequence(blocks);
    const text = normalizedTextFromBlocks(blocks);
    const primary = new Uint8Array(
      await (
        await createPageSnapshotBlob({
          capturedAt,
          originalUrl: metadata.originalUrl,
          finalUrl: metadata.finalUrl,
          documents: [
            {
              originalUrl: metadata.originalUrl,
              finalUrl: metadata.finalUrl,
              bytes: new TextEncoder().encode("<!doctype html><title>Fixture</title>"),
              scrollX: 0,
              scrollY: 0,
            },
          ],
          resources: [],
          omissions: [],
        })
      ).blob.arrayBuffer(),
    );
    const store = new MemoryArtifactStore();
    const artifacts = await Promise.all([
      prepareArtifact(
        store,
        preparedVault.rootKey,
        vaultId,
        id(20),
        primary,
        "PRIMARY",
        "CAPTURE",
        "application/vnd.awsm.web-page+zip",
        capturedAt,
      ),
      prepareArtifact(
        store,
        preparedVault.rootKey,
        vaultId,
        id(21),
        text,
        "TEXT_EXTRACTED",
        "TEXT",
        "text/plain;charset=utf-8",
        capturedAt,
      ),
      prepareArtifact(
        store,
        preparedVault.rootKey,
        vaultId,
        id(22),
        structured,
        "CONTENT_STRUCTURED",
        "STRUCTURED_CONTENT",
        "application/cbor-seq",
        capturedAt,
      ),
    ]);
    const registration = await prepareCaptureRegistration({
      rootKey: preparedVault.rootKey,
      vaultId,
      deviceId: preparedVault.records.metadata.deviceId,
      commandId: id(10),
      bundleId: id(11),
      descriptorObjectId: id(12),
      eventId: id(13),
      collectionId: id(14),
      capturedAt,
      metadata,
      artifacts,
      warnings: [],
      clientVersion: "0.1.0",
    });
    const created = await prepareVaultNameChange({
      rootKey: preparedVault.rootKey,
      eventType: "VaultCreated",
      vaultId,
      deviceId: preparedVault.records.metadata.deviceId,
      eventId: id(9),
      timestamp: "2026-07-18T20:00:00.000Z",
      name: "Amber Archive",
    });
    const source = new MemoryExportSource(
      {
        ...preparedVault.records.head,
        appendedEventIds: [created.event.eventId, registration.event.eventId].toSorted(),
        appendedObjectIds: registration.objects.map((object) => object.objectId).toSorted(),
      },
      preparedVault.records.generation,
      new Map([
        [created.event.eventId, created.event],
        [registration.event.eventId, registration.event],
      ]),
      new Map(registration.objects.map((object) => [object.objectId, object])),
    );
    const service = new VaultExportService(
      source,
      vault,
      vaultId,
      store as unknown as ArtifactStore,
    );
    const options = {
      packageId: "10000000-0000-4000-8000-000000000001",
      createdAt: "2026-07-18T20:01:00.000Z",
      passphrase: "correct horse battery staple",
      salt: new Uint8Array(16).fill(7),
      nonce: new Uint8Array(24).fill(9),
    };
    const complete = await service.prepare(options);
    expect(complete.manifest).toMatchObject({
      coverage: "Complete",
      objectCount: 4,
      artifactPayloadCount: 3,
    });
    const completeBlob = await packageFixture(complete.entries);
    await expect(validateVaultPackage(completeBlob, options.passphrase)).resolves.toMatchObject({
      manifest: {
        coverage: "Complete",
        generationId: preparedVault.records.generation.generationId,
      },
      generation: preparedVault.records.generation,
      head: source.head,
      currentVaultName: "Amber Archive",
      vaultCreatedAt: "2026-07-18T20:00:00.000Z",
    });
    const validated = await validateVaultPackage(completeBlob, options.passphrase);
    expect(validated.events.map((event) => event.eventId)).toEqual([
      created.event.eventId,
      registration.event.eventId,
    ]);
    expect(validated.objects.map((object) => object.objectId).toSorted()).toEqual(
      registration.objects.map((object) => object.objectId).toSorted(),
    );
    let scopedRawRootKey: Uint8Array | undefined;
    await expect(
      withAuthenticatedVaultPackage(
        completeBlob,
        options.passphrase,
        (authenticated, rawRootKey) => {
          scopedRawRootKey = rawRootKey;
          expect(rawRootKey).toHaveLength(32);
          expect(authenticated.rootKey.extractable).toBe(false);
          return authenticated.manifest.originatingVaultId;
        },
      ),
    ).resolves.toBe(preparedVault.records.metadata.vaultId);
    expect(scopedRawRootKey).toEqual(new Uint8Array(32));
    const consumerFailure = Object.assign(new Error("Import capability boundary"), {
      id: "SELECTIVE_IMPORT_UNSUPPORTED",
    });
    await expect(
      withAuthenticatedVaultPackage(completeBlob, options.passphrase, () => {
        throw consumerFailure;
      }),
    ).rejects.toBe(consumerFailure);
    const importedRecords = await withAuthenticatedVaultPackage(
      completeBlob,
      options.passphrase,
      (authenticated, rawRootKey) => prepareImportedVaultCredentials(authenticated, rawRootKey),
    );
    expect(importedRecords.metadata).toMatchObject({
      vaultId: preparedVault.records.metadata.vaultId,
      createdAt: "2026-07-18T20:00:00.000Z",
      manuallyLocked: true,
    });
    expect(importedRecords.metadata.deviceId).not.toBe(preparedVault.records.metadata.deviceId);
    expect(importedRecords.deviceSlot.vaultId).toBe(preparedVault.records.metadata.vaultId);
    expect(importedRecords.deviceSlot.deviceId).toBe(importedRecords.metadata.deviceId);
    expect(importedRecords.deviceKey.extractable).toBe(false);
    expect(importedRecords.generation).toEqual(preparedVault.records.generation);
    expect(importedRecords.head).toEqual(source.head);
    await prepareImportedArtifacts({
      source: completeBlob,
      vaultId: importedRecords.metadata.vaultId,
      objects: validated.objects,
      artifactStore: store as unknown as ArtifactStore,
    });
    expect([...store.imported.keys()].toSorted()).toEqual(
      validated.objects
        .filter((object) => object.objectType === "Artifact")
        .map((object) => object.objectId)
        .toSorted(),
    );
    for (const [objectId, bytes] of store.imported) {
      expect(bytes).toEqual(store.encrypted.get(objectId));
    }

    const remoteOnlyObjectId = id(20);
    const remoteOnlyBytes = store.encrypted.get(remoteOnlyObjectId);
    expect(remoteOnlyBytes).toBeDefined();
    store.encrypted.delete(remoteOnlyObjectId);
    const remoteReads: string[] = [];
    const remoteComplete = await new VaultExportService(source, vault, vaultId, {
      openEncrypted: async (requestedVaultId, objectId, object) => {
        expect(requestedVaultId).toBe(vaultId);
        if (objectId === remoteOnlyObjectId) {
          remoteReads.push(objectId);
          expect(object.envelopeByteLength).toBe(remoteOnlyBytes?.byteLength);
          return new Blob([Uint8Array.from(remoteOnlyBytes ?? []).buffer]).stream();
        }
        return store.openEncrypted(requestedVaultId, objectId);
      },
    }).prepare({
      ...options,
      packageId: "10000000-0000-4000-8000-000000000003",
    });
    expect(remoteComplete.manifest.coverage).toBe("Complete");
    await expect(
      validateVaultPackage(await packageFixture(remoteComplete.entries), options.passphrase),
    ).resolves.toMatchObject({ manifest: { coverage: "Complete" } });
    expect(remoteReads).toEqual([remoteOnlyObjectId, remoteOnlyObjectId]);
    if (remoteOnlyBytes !== undefined) store.encrypted.set(remoteOnlyObjectId, remoteOnlyBytes);

    const selective = await service.prepare({
      ...options,
      packageId: "10000000-0000-4000-8000-000000000002",
      omitArtifactObjectIds: new Set([id(20)]),
    });
    expect(selective.manifest).toMatchObject({
      coverage: "Selective",
      artifactPayloadCount: 2,
    });
    expect(selective.manifest.omissions.map((entry) => entry.artifactObjectId)).toEqual([id(20)]);
    await expect(
      validateVaultPackage(await packageFixture(selective.entries), options.passphrase),
    ).resolves.toMatchObject({ manifest: { coverage: "Selective" } });
  }, 30_000);
});
