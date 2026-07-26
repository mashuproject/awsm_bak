import { describe, expect, it } from "vitest";
import { decodeEncryptedEnvelopeBytes, decryptEnvelope } from "../../src/crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../src/crypto/hkdf";
import { decodeCanonicalCbor } from "../../src/domain/cbor";
import type { LibraryItemV1 } from "../../src/domain/contracts";
import type { CollectionTopologyEventV1 } from "../../src/runtime/library/collections";
import {
  invertCaptureMoves,
  planCaptureMove,
  planCollectionMerge,
  prepareCollectionOperation,
} from "../../src/runtime/library/management";
import { TEST_KEY_EPOCH_ID, testKeyring } from "../helpers/keyring";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

function item(
  bundle: number,
  collection: number,
  status: "Active" | "Deleted" = "Active",
): LibraryItemV1 {
  return {
    version: 1,
    bundleId: id(bundle),
    descriptorObjectId: id(bundle + 100),
    assignedCollectionId: id(collection),
    title: `Capture ${String(bundle)}`,
    originalUrl: `https://fixture.test/${String(bundle)}`,
    capturedAt: `2026-07-18T${String(bundle).padStart(2, "0")}:00:00.000Z`,
    artifactRoles: ["PRIMARY"],
    status,
    warnings: [],
  };
}

describe("Library Collection management planning", () => {
  it("plans an explicit whole-identity merge without rewriting captures", () => {
    const items = [item(1, 20), item(2, 21), item(3, 21, "Deleted")];
    expect(planCollectionMerge(items, [], id(20), [id(21)], id(40))).toEqual({
      eventId: id(40),
      eventType: "CollectionsMerged",
      destinationCollectionId: id(20),
      sourceCollectionIds: [id(21)],
    });
    expect(items.map((capture) => capture.assignedCollectionId)).toEqual([id(20), id(21), id(21)]);
  });

  it("rejects stale, duplicate, self, and inactive-only merge inputs", () => {
    const items = [item(1, 20), item(2, 21), item(3, 22, "Deleted")];
    expect(() => planCollectionMerge(items, [], id(20), [], id(40))).toThrow();
    expect(() => planCollectionMerge(items, [], id(20), [id(21), id(21)], id(40))).toThrow();
    expect(() => planCollectionMerge(items, [], id(20), [id(20)], id(40))).toThrow();
    expect(() => planCollectionMerge(items, [], id(20), [id(22)], id(40))).toThrow();
    expect(() => planCollectionMerge(items, [], id(99), [id(21)], id(40))).toThrow();
  });

  it("moves a deterministic Active selection while preserving prior assigned IDs", () => {
    const first = item(1, 20);
    const second = item(2, 20);
    const destination = item(3, 30);
    expect(
      planCaptureMove(
        [first, second, destination],
        [],
        [second.bundleId, first.bundleId],
        destination.assignedCollectionId,
      ),
    ).toEqual([
      {
        bundleId: first.bundleId,
        fromCollectionId: id(20),
        toCollectionId: id(30),
      },
      {
        bundleId: second.bundleId,
        fromCollectionId: id(20),
        toCollectionId: id(30),
      },
    ]);
  });

  it("extracts through the same move plan and rejects invalid selections atomically", () => {
    const first = item(1, 20);
    const secondSource = item(2, 21);
    const deleted = item(3, 20, "Deleted");
    expect(
      planCaptureMove([first], [], [first.bundleId], id(99), { allowNewDestination: true }),
    ).toEqual([
      {
        bundleId: first.bundleId,
        fromCollectionId: id(20),
        toCollectionId: id(99),
      },
    ]);
    expect(() => planCaptureMove([first], [], [], id(99), { allowNewDestination: true })).toThrow();
    expect(() =>
      planCaptureMove([first, secondSource], [], [first.bundleId, secondSource.bundleId], id(99), {
        allowNewDestination: true,
      }),
    ).toThrow();
    expect(() =>
      planCaptureMove([first, deleted], [], [deleted.bundleId], id(99), {
        allowNewDestination: true,
      }),
    ).toThrow();
  });

  it("resolves effective sources but records exact assignments for reversible moves", () => {
    const topology: readonly CollectionTopologyEventV1[] = [
      {
        eventId: id(40),
        eventType: "CollectionsMerged",
        destinationCollectionId: id(20),
        sourceCollectionIds: [id(21)],
      },
    ];
    const source = item(1, 21);
    const destination = item(2, 30);
    const moves = planCaptureMove(
      [source, destination],
      topology,
      [source.bundleId],
      destination.assignedCollectionId,
    );
    expect(moves[0]?.fromCollectionId).toBe(id(21));
    expect(
      invertCaptureMoves(
        [{ ...source, assignedCollectionId: id(30) }, destination],
        topology,
        moves,
      ),
    ).toEqual([
      {
        bundleId: source.bundleId,
        fromCollectionId: id(30),
        toCollectionId: id(21),
      },
    ]);
  });

  it("rejects Undo after a conflicting membership change", () => {
    const source = { ...item(1, 20), assignedCollectionId: id(31) };
    const originalMoves = [
      { bundleId: source.bundleId, fromCollectionId: id(20), toCollectionId: id(30) },
    ];
    expect(() => invertCaptureMoves([source], [], originalMoves)).toThrow();
  });

  it("encrypts a move Event and every changed item Projection as one intent", async () => {
    const rootKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(8),
      "HKDF",
      false,
      ["deriveBits"],
    );
    const source = item(1, 20);
    const destination = item(2, 30);
    const moves = planCaptureMove(
      [source, destination],
      [],
      [source.bundleId],
      destination.assignedCollectionId,
    );
    const prepared = await prepareCollectionOperation({
      keyring: testKeyring(rootKey),
      vaultId: id(90),
      deviceId: id(91),
      eventId: id(92),
      timestamp: "2026-07-18T12:00:00.000Z",
      items: [source, destination],
      topology: [],
      fact: { eventType: "CapturesMoved", moves },
    });
    expect(prepared.projections).toHaveLength(1);
    expect(prepared.collectionProjection).toBeUndefined();

    const eventKey = await deriveContextKeyFromCryptoKey(rootKey, {
      vaultId: id(90),
      keyEpochId: TEST_KEY_EPOCH_ID,
      domain: "vault:event:v1",
      contextId: id(92),
      keyVersion: 1,
    });
    await expect(
      decryptEnvelope(
        decodeEncryptedEnvelopeBytes(prepared.event.envelopeBytes),
        eventKey,
        TEST_KEY_EPOCH_ID,
      ).then(decodeCanonicalCbor),
    ).resolves.toMatchObject({ eventType: "CapturesMoved", moves });

    const projectionKey = await deriveContextKeyFromCryptoKey(rootKey, {
      vaultId: id(90),
      keyEpochId: TEST_KEY_EPOCH_ID,
      domain: "vault:projection:v1",
      contextId: `LibraryItem-v1:${source.bundleId}`,
      keyVersion: 1,
    });
    await expect(
      decryptEnvelope(
        decodeEncryptedEnvelopeBytes(prepared.projections[0]?.envelopeBytes ?? new Uint8Array()),
        projectionKey,
        TEST_KEY_EPOCH_ID,
      ).then(decodeCanonicalCbor),
    ).resolves.toMatchObject({ assignedCollectionId: id(30) });
  });

  it("encrypts merge topology without rewriting item Projections", async () => {
    const rootKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(9),
      "HKDF",
      false,
      ["deriveBits"],
    );
    const captures = [item(1, 20), item(2, 21)];
    const mergeEvent = planCollectionMerge(captures, [], id(20), [id(21)], id(40));
    const prepared = await prepareCollectionOperation({
      keyring: testKeyring(rootKey),
      vaultId: id(90),
      deviceId: id(91),
      eventId: mergeEvent.eventId,
      timestamp: "2026-07-18T12:00:00.000Z",
      items: captures,
      topology: [],
      fact: mergeEvent,
    });
    expect(prepared.projections).toEqual([]);
    expect(prepared.collectionProjection?.projectionId).toBe(id(90));

    const key = await deriveContextKeyFromCryptoKey(rootKey, {
      vaultId: id(90),
      keyEpochId: TEST_KEY_EPOCH_ID,
      domain: "vault:projection:v1",
      contextId: `LibraryCollections-v1:${id(90)}`,
      keyVersion: 1,
    });
    await expect(
      decryptEnvelope(
        decodeEncryptedEnvelopeBytes(
          prepared.collectionProjection?.envelopeBytes ?? new Uint8Array(),
        ),
        key,
        TEST_KEY_EPOCH_ID,
      ).then(decodeCanonicalCbor),
    ).resolves.toMatchObject({
      version: 1,
      topologyEvents: [mergeEvent],
    });
  });
});
