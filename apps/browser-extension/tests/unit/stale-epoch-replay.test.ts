import { describe, expect, it, vi } from "vitest";

import { prepareCaptureRegistration } from "../../src/runtime/capture/registration";
import { prepareStaleCaptureReplay } from "../../src/runtime/synchronization/stale-epoch-replay";
import { importVaultRootKey, VaultKeyring } from "../../src/runtime/vault/keyring";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("stale key-epoch semantic replay", () => {
  it("replays an unpublished capture with fresh IDs under the active epoch", async () => {
    const vaultId = id(1);
    const deviceId = id(2);
    const oldEpochId = id(3);
    const activeEpochId = id(4);
    const plaintext = new Uint8Array([1, 2, 3, 4]);
    const checksum = new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(plaintext)),
    );
    const oldKeyring = new VaultKeyring(oldEpochId, [
      {
        keyEpochId: oldEpochId,
        ordinal: 0,
        rootKey: await importVaultRootKey(new Uint8Array(32).fill(1)),
      },
    ]);
    const keyring = new VaultKeyring(activeEpochId, [
      ...oldKeyring.list(),
      {
        keyEpochId: activeEpochId,
        ordinal: 1,
        rootKey: await importVaultRootKey(new Uint8Array(32).fill(2)),
      },
    ]);
    const sourceArtifact = {
      version: 1 as const,
      objectId: id(7),
      objectType: "Artifact" as const,
      keyEpochId: oldEpochId,
      envelopeFormat: "artifact:xchacha20poly1305-chunked:v1" as const,
      envelopeByteLength: 100,
      envelopeChecksumAlgorithm: "hash:sha256:v1" as const,
      envelopeChecksum: new Uint8Array(32),
    };
    const source = await prepareCaptureRegistration({
      keyring: oldKeyring,
      vaultId,
      deviceId,
      commandId: id(5),
      bundleId: id(6),
      descriptorObjectId: id(8),
      eventId: id(9),
      collectionId: id(10),
      capturedAt: "2026-07-25T20:00:00.000Z",
      metadata: {
        version: 1,
        originalUrl: "https://example.test/article",
        finalUrl: "https://example.test/article",
        title: "Article",
        capturedAt: "2026-07-25T20:00:00.000Z",
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
          object: sourceArtifact,
          reference: {
            artifactVersion: 1,
            artifactObjectId: sourceArtifact.objectId,
            kind: "CAPTURE",
            role: "PRIMARY",
            mimeType: "application/vnd.awsm.web-page+zip",
            acquiredAt: "2026-07-25T20:00:00.000Z",
            plaintextByteLength: plaintext.byteLength,
            checksumAlgorithm: "hash:sha256:v1",
            plaintextChecksum: checksum,
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
    let nextId = 20;
    const remove = vi.fn(async () => undefined);
    const replay = await prepareStaleCaptureReplay({
      vaultId,
      deviceId,
      event: source.event,
      objects: new Map(source.objects.map((object) => [object.objectId, object])),
      keyring,
      artifacts: {
        openPlaintext: async () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(plaintext);
              controller.close();
            },
          }),
        prepare: async ({ objectId }) => ({
          object: {
            ...sourceArtifact,
            objectId,
            keyEpochId: activeEpochId,
          },
          plaintextByteLength: plaintext.byteLength,
          plaintextChecksum: checksum,
        }),
        remove,
      },
      uuid: () => id(nextId++),
    });

    expect(replay.oldEventId).toBe(source.event.eventId);
    expect(replay.registration.event.eventId).not.toBe(source.event.eventId);
    expect(replay.registration.objects.map((object) => object.objectId)).not.toContain(
      sourceArtifact.objectId,
    );
    expect(
      replay.registration.objects.every((object) =>
        object.objectType === "Artifact" ? object.keyEpochId === activeEpochId : true,
      ),
    ).toBe(true);
    expect(replay.preparedArtifactObjectIds).toHaveLength(1);
    expect(remove).not.toHaveBeenCalled();

    const rejectedObjectId = id(90);
    await expect(
      prepareStaleCaptureReplay({
        vaultId,
        deviceId,
        event: source.event,
        objects: new Map(source.objects.map((object) => [object.objectId, object])),
        keyring,
        artifacts: {
          openPlaintext: async () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(plaintext);
                controller.close();
              },
            }),
          prepare: async ({ objectId }) => ({
            object: {
              ...sourceArtifact,
              objectId,
              keyEpochId: activeEpochId,
            },
            plaintextByteLength: plaintext.byteLength,
            plaintextChecksum: new Uint8Array(32).fill(255),
          }),
          remove,
        },
        uuid: () => rejectedObjectId,
      }),
    ).rejects.toMatchObject({ id: "SYNCHRONIZATION_CONFLICT" });
    expect(remove).toHaveBeenCalledWith(vaultId, rejectedObjectId);
  });
});
