import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import {
  type CanonicalIndexedDb,
  identifierStorageKey,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES, type StorageRealm } from "../../drivers/indexeddb/canonical-schema";
import {
  canonicalLocalStorageContext,
  openWrappedLocalState,
  prepareWrappedLocalStateItem,
} from "../vault/canonical-local-state";
import {
  type CanonicalReplicaRemote,
  decodeCanonicalRemoteCredential,
  decodeCanonicalReplicaRemote,
  encodeCanonicalRemoteCredential,
  encodeCanonicalReplicaRemote,
} from "./canonical-state";

const textEncoder = new TextEncoder();

function required(value: Uint8Array | undefined, field: string): Uint8Array {
  if (value === undefined) throw new TypeError(`${field} is unavailable`);
  return value;
}

export class CanonicalReplicaRemoteService {
  constructor(
    private readonly storage: CanonicalIndexedDb,
    private readonly realm: StorageRealm,
  ) {}

  async configure(input: {
    readonly remote: CanonicalReplicaRemote;
    readonly bearerToken: string;
  }): Promise<void> {
    const remoteBytes = encodeCanonicalReplicaRemote(input.remote);
    const credentialBytes = encodeCanonicalRemoteCredential({
      remoteId: input.remote.remoteId,
      bearerToken: input.bearerToken,
    });
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const remoteIdentity = textEncoder.encode(input.remote.remoteId);
    const vaultKey = identifierStorageKey(input.remote.vaultId);
    const [remote, credential] = await Promise.all([
      prepareWrappedLocalStateItem({
        namespace: NAMESPACES.replicaRemote.key,
        scopeKey: vaultKey,
        itemKey: input.remote.remoteId,
        wrappingKey,
        domain: "awsm.local.replica-remote",
        context: canonicalLocalStorageContext(input.remote.vaultId, remoteIdentity),
        bytes: remoteBytes,
      }),
      prepareWrappedLocalStateItem({
        namespace: NAMESPACES.remoteChannelCredential.key,
        scopeKey: input.remote.remoteId,
        itemKey: "bearer",
        wrappingKey,
        domain: "awsm.local.remote-channel-credential",
        context: canonicalLocalStorageContext(input.remote.vaultId, remoteIdentity),
        bytes: credentialBytes,
      }),
    ]);
    await this.storage.commitInstallationMutation({
      realm: this.realm,
      expectedAbsentItems: [
        {
          namespace: NAMESPACES.replicaRemote.key,
          scopeKey: vaultKey,
          itemKey: input.remote.remoteId,
        },
        {
          namespace: NAMESPACES.remoteChannelCredential.key,
          scopeKey: input.remote.remoteId,
          itemKey: "bearer",
        },
      ],
      mutableItems: [remote, credential],
    });
  }

  async list(vaultId: Identifier<"Vault">): Promise<readonly CanonicalReplicaRemote[]> {
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const vaultKey = identifierStorageKey(vaultId);
    const entries = await this.storage.listBytes(
      this.realm,
      NAMESPACES.replicaRemote.key,
      vaultKey,
    );
    return Promise.all(
      entries.map(async (entry) => {
        const remote = decodeCanonicalReplicaRemote(
          await openWrappedLocalState({
            wrappingKey,
            domain: "awsm.local.replica-remote",
            vaultId,
            identity: textEncoder.encode(entry.itemKey),
            wrappedBytes: entry.bytes,
          }),
        );
        if (!bytesEqual(remote.vaultId, vaultId) || remote.remoteId !== entry.itemKey) {
          throw new TypeError("Replica Remote storage identity does not match its protected state");
        }
        return remote;
      }),
    );
  }

  async load(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
  }): Promise<{ readonly remote: CanonicalReplicaRemote; readonly bearerToken: string }> {
    const remote = (await this.list(input.vaultId)).find(
      ({ remoteId }) => remoteId === input.remoteId,
    );
    if (remote === undefined)
      throw new TypeError("Replica Remote is not configured for this Vault");
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const credential = decodeCanonicalRemoteCredential(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.remote-channel-credential",
        vaultId: input.vaultId,
        identity: textEncoder.encode(input.remoteId),
        wrappedBytes: required(
          await this.storage.getBytes(this.realm, {
            namespace: NAMESPACES.remoteChannelCredential.key,
            scopeKey: input.remoteId,
            itemKey: "bearer",
          }),
          "Replica Remote credential",
        ),
      }),
    );
    if (credential.remoteId !== input.remoteId) {
      throw new TypeError("Replica Remote credential identity does not match its configuration");
    }
    return { remote, bearerToken: credential.bearerToken };
  }
}
