import { describe, expect, it, vi } from "vitest";

import { decodeEncryptedEnvelopeBytes } from "../../src/crypto/envelope";
import { prepareCaptureRegistration } from "../../src/runtime/capture/registration";
import { prepareLibraryStateChange } from "../../src/runtime/library/lifecycle";
import { VaultReplacementRewriter } from "../../src/runtime/recovery/replacement-rewrite";
import { verifyVaultGeneration } from "../../src/runtime/vault/generation";
import { importVaultRootKey, VaultKeyring } from "../../src/runtime/vault/keyring";
import { prepareVaultNameChange } from "../../src/runtime/vault/name-crypto";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("maximum-security Vault replacement rewrite", () => {
  it("creates an independent Vault graph with fresh identities and active-epoch ciphertext", async () => {
    const sourceVaultId = id(1);
    const sourceDeviceId = id(2);
    const sourceEpochId = id(3);
    const targetVaultId = id(4);
    const targetDeviceId = id(5);
    const targetEpochId = id(6);
    const sourceKeyring = new VaultKeyring(sourceEpochId, [
      {
        keyEpochId: sourceEpochId,
        ordinal: 0,
        rootKey: await importVaultRootKey(new Uint8Array(32).fill(1)),
      },
    ]);
    const targetKeyring = new VaultKeyring(targetEpochId, [
      {
        keyEpochId: targetEpochId,
        ordinal: 0,
        rootKey: await importVaultRootKey(new Uint8Array(32).fill(2)),
      },
    ]);
    const plaintext = new Uint8Array([1, 2, 3, 4]);
    const plaintextChecksum = new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext));
    const artifact = {
      version: 1 as const,
      objectId: id(10),
      objectType: "Artifact" as const,
      keyEpochId: sourceEpochId,
      envelopeFormat: "artifact:xchacha20poly1305-chunked:v1" as const,
      envelopeByteLength: 80,
      envelopeChecksumAlgorithm: "hash:sha256:v1" as const,
      envelopeChecksum: new Uint8Array(32).fill(8),
    };
    const capture = await prepareCaptureRegistration({
      keyring: sourceKeyring,
      vaultId: sourceVaultId,
      deviceId: sourceDeviceId,
      commandId: id(11),
      bundleId: id(12),
      descriptorObjectId: id(13),
      eventId: id(14),
      collectionId: id(15),
      capturedAt: "2026-07-25T21:00:00.000Z",
      metadata: {
        version: 1,
        originalUrl: "https://example.test/article",
        finalUrl: "https://example.test/article",
        title: "Independent archive",
        capturedAt: "2026-07-25T21:00:00.000Z",
        contentType: "text/html",
        viewport: { width: 1280, height: 720 },
        document: { width: 1280, height: 2000 },
        browserName: "Firefox",
        browserVersion: "140",
        extensionVersion: "0.1.5",
        captureProfileId: "WebPageSnapshot-v1",
        captureProfileVersion: 1,
      },
      artifacts: [
        {
          object: artifact,
          reference: {
            artifactVersion: 1,
            artifactObjectId: artifact.objectId,
            kind: "CAPTURE",
            role: "PRIMARY",
            mimeType: "application/vnd.awsm.web-page+zip",
            acquiredAt: "2026-07-25T21:00:00.000Z",
            plaintextByteLength: plaintext.byteLength,
            checksumAlgorithm: "hash:sha256:v1",
            plaintextChecksum,
          },
        },
      ],
      warnings: [
        "SCREENSHOT_UNAVAILABLE",
        "STRUCTURED_CONTENT_EXTRACTION_FAILED",
        "TEXT_EXTRACTION_FAILED",
      ],
      clientVersion: "0.1.5",
    });
    const name = await prepareVaultNameChange({
      keyring: sourceKeyring,
      eventType: "VaultCreated",
      vaultId: sourceVaultId,
      deviceId: sourceDeviceId,
      eventId: id(16),
      timestamp: "2026-07-25T20:59:00.000Z",
      name: "Archive",
    });
    const deletion = await prepareLibraryStateChange({
      keyring: sourceKeyring,
      vaultId: sourceVaultId,
      deviceId: sourceDeviceId,
      eventId: id(17),
      timestamp: "2026-07-25T21:01:00.000Z",
      operation: "Delete",
      items: [
        {
          version: 1,
          bundleId: capture.graph.bundleId,
          descriptorObjectId: capture.graph.descriptorObjectId,
          status: "Active",
          assignedCollectionId: id(15),
          title: "Independent archive",
          originalUrl: "https://example.test/article",
          capturedAt: "2026-07-25T21:00:00.000Z",
          artifactRoles: ["PRIMARY"],
          warnings: [
            "SCREENSHOT_UNAVAILABLE",
            "STRUCTURED_CONTENT_EXTRACTION_FAILED",
            "TEXT_EXTRACTION_FAILED",
          ],
        },
      ],
    });
    let nextId = 100;
    const remove = vi.fn(async () => undefined);
    const prepared = await new VaultReplacementRewriter(
      {
        openPlaintext: async () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(plaintext);
              controller.close();
            },
          }),
        prepare: async ({ objectId }) => ({
          object: {
            ...artifact,
            objectId,
            keyEpochId: targetEpochId,
          },
          plaintextByteLength: plaintext.byteLength,
          plaintextChecksum,
        }),
        remove,
      },
      () => id(nextId++),
      () => "2026-07-25T22:00:00.000Z",
    ).prepare({
      sourceVaultId,
      sourceDeviceId,
      sourceHead: {
        version: 1,
        vaultId: sourceVaultId,
        generationId: id(20),
        generationNumber: 0,
        appendedObjectIds: capture.objects.map((object) => object.objectId).toSorted(),
        appendedEventIds: [
          name.event.eventId,
          capture.event.eventId,
          deletion.event.eventId,
        ].toSorted(),
      },
      sourceRetainedEventIds: [],
      sourceRetainedObjectIds: [],
      sourceKeyring,
      sourceEvents: [name.event, capture.event, deletion.event],
      sourceObjects: capture.objects,
      targetVaultId,
      targetDeviceId,
      targetKeyring,
    });

    expect(prepared.head.vaultId).toBe(targetVaultId);
    expect(prepared.head.generationNumber).toBe(0);
    expect(prepared.objects).toHaveLength(capture.objects.length);
    expect(prepared.events).toHaveLength(3);
    expect(prepared.objects.map((object) => object.objectId)).not.toContain(artifact.objectId);
    expect(
      prepared.events.every(
        (event) =>
          event.vaultId === targetVaultId &&
          decodeEncryptedEnvelopeBytes(event.envelopeBytes).keyEpochId === targetEpochId,
      ),
    ).toBe(true);
    expect(
      prepared.objects.every((object) =>
        object.objectType === "Artifact"
          ? object.keyEpochId === targetEpochId
          : decodeEncryptedEnvelopeBytes(object.envelopeBytes).keyEpochId === targetEpochId,
      ),
    ).toBe(true);
    expect(
      prepared.identifierMappings.find(
        (mapping) => mapping.kind === "Bundle" && mapping.sourceId === capture.graph.bundleId,
      )?.targetId,
    ).not.toBe(capture.graph.bundleId);
    await expect(
      verifyVaultGeneration(targetKeyring, targetVaultId, prepared.generation),
    ).resolves.toEqual({ retainedObjectIds: [], retainedEventIds: [] });
    expect(remove).not.toHaveBeenCalled();
  });
});
