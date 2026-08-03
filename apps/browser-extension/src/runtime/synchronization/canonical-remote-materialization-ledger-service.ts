import type { Identifier } from "../../domain/canonical/identifiers";
import { transcript, uint8 } from "../../domain/canonical/transcript";
import { bytesEqual, sha256 } from "../../domain/hash";
import {
  type CanonicalIndexedDb,
  identifierStorageKey,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES, type StorageRealm } from "../../drivers/indexeddb/canonical-schema";
import { decodeOpaqueEnvelope } from "../../storage/opaque-envelope";
import {
  canonicalLocalStorageContext,
  openWrappedLocalState,
  prepareWrappedLocalStateItem,
} from "../vault/canonical-local-state";
import {
  type CanonicalRemoteMaterializationLedgerEntry,
  decodeCanonicalRemoteMaterializationLedgerEntry,
  encodeCanonicalRemoteMaterializationLedgerEntry,
} from "./canonical-state";

const textEncoder = new TextEncoder();

function itemKey(
  entry: Pick<CanonicalRemoteMaterializationLedgerEntry, "logicalNamespace" | "logicalId">,
): string {
  return `${entry.logicalNamespace}:${identifierStorageKey(entry.logicalId as Identifier<"VaultRecord">)}`;
}

function identity(
  entry: Pick<
    CanonicalRemoteMaterializationLedgerEntry,
    "remoteId" | "logicalNamespace" | "logicalId"
  >,
): Uint8Array {
  return transcript("awsm:remote-materialization-ledger:v1", [
    textEncoder.encode(entry.remoteId),
    uint8(entry.logicalNamespace),
    entry.logicalId,
  ]);
}

export class CanonicalRemoteMaterializationLedgerService {
  constructor(
    private readonly storage: CanonicalIndexedDb,
    private readonly realm: StorageRealm,
  ) {}

  async prepare(input: {
    readonly entry: CanonicalRemoteMaterializationLedgerEntry;
    readonly bytes: Uint8Array;
  }): Promise<void> {
    if (input.entry.state !== "Prepared") {
      throw new TypeError("Only a prepared Remote materialization can be installed");
    }
    const envelope = decodeOpaqueEnvelope(input.bytes);
    if (
      !bytesEqual(envelope.storageItemId, input.entry.storageItemId) ||
      envelope.bytes.byteLength !== input.entry.byteLength ||
      !bytesEqual(await sha256(envelope.bytes), input.entry.byteDigest)
    ) {
      throw new TypeError("Remote materialization ledger does not match its prepared outer bytes");
    }
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const ledger = await prepareWrappedLocalStateItem({
      namespace: NAMESPACES.remoteMaterializationLedger.key,
      scopeKey: input.entry.remoteId,
      itemKey: itemKey(input.entry),
      wrappingKey,
      domain: "awsm.local.remote-materialization-ledger",
      context: canonicalLocalStorageContext(input.entry.vaultId, identity(input.entry)),
      bytes: encodeCanonicalRemoteMaterializationLedgerEntry(input.entry),
    });
    await this.storage.commitExecutionMutation({
      realm: this.realm,
      expectedAbsentItems: [
        {
          namespace: ledger.namespace,
          scopeKey: ledger.scopeKey,
          itemKey: ledger.itemKey,
        },
      ],
      immutableItems: [
        {
          namespace: NAMESPACES.preparedOutgoingItem.key,
          scopeKey: input.entry.remoteId,
          itemKey: identifierStorageKey(input.entry.storageItemId),
          bytes: Uint8Array.from(envelope.bytes),
        },
      ],
      mutableItems: [ledger],
    });
  }

  async find(input: {
    readonly vaultId: CanonicalRemoteMaterializationLedgerEntry["vaultId"];
    readonly remoteId: string;
    readonly logicalNamespace: CanonicalRemoteMaterializationLedgerEntry["logicalNamespace"];
    readonly logicalId: Uint8Array;
  }): Promise<{
    readonly entry: CanonicalRemoteMaterializationLedgerEntry;
    readonly bytes: Uint8Array | null;
  } | null> {
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const key = {
      namespace: NAMESPACES.remoteMaterializationLedger.key,
      scopeKey: input.remoteId,
      itemKey: itemKey(input),
    };
    const wrappedBytes = await this.storage.getBytes(this.realm, key);
    if (wrappedBytes === undefined) return null;
    const entry = decodeCanonicalRemoteMaterializationLedgerEntry(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.remote-materialization-ledger",
        vaultId: input.vaultId,
        identity: identity(input),
        wrappedBytes,
      }),
    );
    if (
      !bytesEqual(entry.vaultId, input.vaultId) ||
      entry.remoteId !== input.remoteId ||
      entry.logicalNamespace !== input.logicalNamespace ||
      !bytesEqual(entry.logicalId, input.logicalId)
    ) {
      throw new TypeError(
        "Remote materialization ledger storage identity does not match its state",
      );
    }
    if (entry.state === "Confirmed") return { entry, bytes: null };
    const preparedBytes = await this.storage.getBytes(this.realm, {
      namespace: NAMESPACES.preparedOutgoingItem.key,
      scopeKey: entry.remoteId,
      itemKey: identifierStorageKey(entry.storageItemId),
    });
    if (preparedBytes === undefined) {
      throw new TypeError("Prepared Remote materialization bytes are unavailable");
    }
    const envelope = decodeOpaqueEnvelope(preparedBytes);
    if (
      !bytesEqual(envelope.storageItemId, entry.storageItemId) ||
      envelope.bytes.byteLength !== entry.byteLength ||
      !bytesEqual(await sha256(envelope.bytes), entry.byteDigest)
    ) {
      throw new TypeError("Remote materialization ledger does not match its prepared outer bytes");
    }
    return { entry, bytes: envelope.bytes };
  }

  async load(input: {
    readonly vaultId: CanonicalRemoteMaterializationLedgerEntry["vaultId"];
    readonly remoteId: string;
    readonly logicalNamespace: CanonicalRemoteMaterializationLedgerEntry["logicalNamespace"];
    readonly logicalId: Uint8Array;
  }): Promise<{
    readonly entry: CanonicalRemoteMaterializationLedgerEntry;
    readonly bytes: Uint8Array | null;
  }> {
    const found = await this.find(input);
    if (found === null) throw new TypeError("Remote materialization ledger is unavailable");
    return found;
  }

  async confirm(input: {
    readonly entry: CanonicalRemoteMaterializationLedgerEntry;
    readonly admission: {
      readonly storageItemId: CanonicalRemoteMaterializationLedgerEntry["storageItemId"];
      readonly byteLength: number;
      readonly admission: "stored" | "already_present";
    };
  }): Promise<CanonicalRemoteMaterializationLedgerEntry> {
    if (input.entry.state !== "Prepared") {
      throw new TypeError("Only a prepared Remote materialization can be confirmed");
    }
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const expected = encodeCanonicalRemoteMaterializationLedgerEntry(input.entry);
    const key = {
      namespace: NAMESPACES.remoteMaterializationLedger.key,
      scopeKey: input.entry.remoteId,
      itemKey: itemKey(input.entry),
    };
    const wrappedBytes = await this.storage.getBytes(this.realm, key);
    if (wrappedBytes === undefined) {
      throw new TypeError("Prepared Remote materialization ledger is unavailable");
    }
    const current = decodeCanonicalRemoteMaterializationLedgerEntry(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.remote-materialization-ledger",
        vaultId: input.entry.vaultId,
        identity: identity(input.entry),
        wrappedBytes,
      }),
    );
    if (!bytesEqual(encodeCanonicalRemoteMaterializationLedgerEntry(current), expected)) {
      throw new TypeError("Prepared Remote materialization ledger has changed");
    }
    const preparedKey = {
      namespace: NAMESPACES.preparedOutgoingItem.key,
      scopeKey: current.remoteId,
      itemKey: identifierStorageKey(current.storageItemId),
    };
    const preparedBytes = await this.storage.getBytes(this.realm, preparedKey);
    if (preparedBytes === undefined) {
      throw new TypeError("Prepared Remote materialization bytes are unavailable");
    }
    const envelope = decodeOpaqueEnvelope(preparedBytes);
    if (
      !bytesEqual(envelope.storageItemId, current.storageItemId) ||
      envelope.bytes.byteLength !== current.byteLength ||
      !bytesEqual(await sha256(envelope.bytes), current.byteDigest) ||
      !bytesEqual(input.admission.storageItemId, current.storageItemId) ||
      input.admission.byteLength !== current.byteLength
    ) {
      throw new TypeError("Remote materialization confirmation does not match its prepared item");
    }
    const confirmed: CanonicalRemoteMaterializationLedgerEntry = { ...current, state: "Confirmed" };
    const next = await prepareWrappedLocalStateItem({
      namespace: key.namespace,
      scopeKey: key.scopeKey,
      itemKey: key.itemKey,
      wrappingKey,
      domain: "awsm.local.remote-materialization-ledger",
      context: canonicalLocalStorageContext(confirmed.vaultId, identity(confirmed)),
      bytes: encodeCanonicalRemoteMaterializationLedgerEntry(confirmed),
    });
    await this.storage.commitExecutionMutation({
      realm: this.realm,
      expectedMutableItems: [{ ...key, bytes: wrappedBytes }],
      mutableItems: [next],
      deletedItems: [preparedKey],
    });
    return confirmed;
  }
}
