import { decodeRecoveryPhrase, deriveRecoveryCredential } from "../../crypto/canonical";
import { openKeyEnvelope } from "../../crypto/key-envelope";
import { wipe } from "../../crypto/sodium";
import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import { identifierStorageKey } from "../../drivers/indexeddb/canonical-database";
import {
  COMPACT_STORAGE_CLASS,
  decodeOpaqueEnvelope,
  PORTABLE_COMPACT_CEILING,
} from "../../storage/opaque-envelope";
import {
  CanonicalHostedReplicaHttp,
  type CanonicalOpaqueInventoryItem,
} from "./canonical-host-http";

const DISCOVERY_INVENTORY_PAGE_SIZE = 128;
const MAX_COMPACT_OUTER_BYTES = PORTABLE_COMPACT_CEILING + 4_108;

type RecoveryDiscoveryHttp = Pick<
  CanonicalHostedReplicaHttp,
  "listReplicas" | "inventory" | "item"
>;

export interface CanonicalHostedRecoveryEnvelopeCandidate {
  readonly replicaHandle: string;
  readonly storageItemId: Identifier<"StorageItem">;
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEpochKey: Uint8Array;
  readonly recoveryCredentialId: Identifier<"RecoveryCredential">;
  readonly recoveryCredentialRevision: number;
  readonly envelopeBytes: Uint8Array;
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return bytesEqual(left, right);
}

async function readCompactEnvelope(
  stream: ReadableStream<Uint8Array>,
  byteLength: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_COMPACT_OUTER_BYTES) {
    throw new TypeError(
      "Recovery discovery Compact item exceeds the accepted outer-envelope bound",
    );
  }
  const bytes = new Uint8Array(byteLength);
  const reader = stream.getReader();
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
        throw new TypeError("Recovery discovery Compact item chunks must contain bytes");
      }
      if (offset + next.value.byteLength > bytes.byteLength) {
        throw new TypeError("Recovery discovery Compact item exceeds its declared length");
      }
      bytes.set(next.value, offset);
      offset += next.value.byteLength;
    }
    if (offset !== bytes.byteLength) {
      throw new TypeError("Recovery discovery Compact item ended before its declared length");
    }
    return bytes;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function verifyInventoryEnvelope(item: CanonicalOpaqueInventoryItem, bytes: Uint8Array): void {
  const envelope = decodeOpaqueEnvelope(bytes);
  if (
    envelope.storageClass !== COMPACT_STORAGE_CLASS ||
    !same(envelope.storageItemId, item.storageItemId) ||
    envelope.bytes.byteLength !== item.byteLength ||
    !same(envelope.ciphertextDigest, item.ciphertextDigest)
  ) {
    throw new TypeError("Recovery discovery opaque bytes disagree with Host inventory metadata");
  }
}

/** Scans a Host's opaque Compact inventory for Recovery Envelopes without identifying a Vault to it. */
export class CanonicalHostedRecoveryDiscoveryService {
  constructor(
    private readonly dependencies: {
      readonly createHttp?: (input: {
        readonly endpoint: string;
        readonly bearerToken: string;
      }) => RecoveryDiscoveryHttp;
    } = {},
  ) {}

  async discover(input: {
    readonly endpoint: string;
    readonly bearerToken: string;
    readonly recoveryPhrase: string;
  }): Promise<readonly CanonicalHostedRecoveryEnvelopeCandidate[]> {
    const entropy = decodeRecoveryPhrase(input.recoveryPhrase);
    const recovery = await deriveRecoveryCredential(entropy);
    const candidates: CanonicalHostedRecoveryEnvelopeCandidate[] = [];
    let succeeded = false;
    try {
      const http =
        this.dependencies.createHttp?.({
          endpoint: input.endpoint,
          bearerToken: input.bearerToken,
        }) ??
        new CanonicalHostedReplicaHttp({
          endpoint: input.endpoint,
          bearerToken: input.bearerToken,
        });
      const replicas = await http.listReplicas();
      for (const replica of replicas.toSorted((left, right) =>
        left.replicaHandle.localeCompare(right.replicaHandle),
      )) {
        const itemIds = new Set<string>();
        const positions = new Set<string>();
        let snapshotCursor: number | undefined;
        let position: Identifier<"StorageItem"> | undefined;
        for (;;) {
          const page = await http.inventory({
            replicaHandle: replica.replicaHandle,
            ...(snapshotCursor === undefined ? {} : { snapshotCursor }),
            ...(position === undefined ? {} : { position }),
            limit: DISCOVERY_INVENTORY_PAGE_SIZE,
          });
          if (snapshotCursor === undefined) snapshotCursor = page.snapshotCursor;
          else if (snapshotCursor !== page.snapshotCursor) {
            throw new TypeError("Recovery discovery Host inventory changed its observed snapshot");
          }
          for (const item of page.items) {
            const itemKey = identifierStorageKey(item.storageItemId);
            if (itemIds.has(itemKey)) {
              throw new TypeError(
                "Recovery discovery Host inventory repeats an opaque Storage Item",
              );
            }
            itemIds.add(itemKey);
            if (item.storageClass !== COMPACT_STORAGE_CLASS) continue;
            const bytes = await readCompactEnvelope(
              await http.item({
                replicaHandle: replica.replicaHandle,
                storageItemId: item.storageItemId,
                byteLength: item.byteLength,
              }),
              item.byteLength,
            );
            verifyInventoryEnvelope(item, bytes);
            try {
              const opened = await openKeyEnvelope({
                targetKind: 1,
                recipientWrappingPrivateKey: recovery.wrappingPrivateKey,
                envelopeBytes: bytes,
              });
              if (opened.targetKind !== 1 || opened.targetRevision === null) {
                throw new TypeError("Recovery discovery opened a non-Recovery Key Envelope");
              }
              candidates.push({
                replicaHandle: replica.replicaHandle,
                storageItemId: item.storageItemId,
                vaultId: opened.vaultId,
                keyEpochId: opened.keyEpochId,
                keyEpochKey: Uint8Array.from(opened.keyEpochKey),
                recoveryCredentialId: opened.targetCredentialId as Identifier<"RecoveryCredential">,
                recoveryCredentialRevision: opened.targetRevision,
                envelopeBytes: Uint8Array.from(bytes),
              });
            } catch {
              // An opaque Compact item is not a phrase-owned Recovery Envelope until local HPKE opening succeeds.
            }
          }
          if (page.nextPosition === null) break;
          const next = identifierStorageKey(page.nextPosition);
          if (positions.has(next)) {
            throw new TypeError("Recovery discovery Host inventory repeats a page position");
          }
          positions.add(next);
          position = page.nextPosition;
        }
      }
      succeeded = true;
      return candidates;
    } finally {
      await Promise.all([
        wipe(entropy),
        wipe(recovery.signingSeed),
        wipe(recovery.signingSecretKey),
        wipe(recovery.wrappingPrivateKey),
        ...(succeeded ? [] : candidates.map(({ keyEpochKey }) => wipe(keyEpochKey))),
      ]);
    }
  }
}
