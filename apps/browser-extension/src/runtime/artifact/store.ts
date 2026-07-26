import type { ArtifactReferenceV1 } from "../../domain/artifact-graph";
import type { StoredArtifactObjectV1 } from "../../drivers/indexeddb/schema";
import type { VaultKeyring } from "../vault/keyring";

export interface PreparedArtifact {
  readonly object: StoredArtifactObjectV1;
  readonly plaintextByteLength: number;
  readonly plaintextChecksum: Uint8Array;
}

export interface ArtifactStore {
  prepare(input: {
    readonly vaultId: string;
    readonly objectId: string;
    readonly keyring: VaultKeyring;
    readonly plaintext: AsyncIterable<Uint8Array>;
    readonly noncePrefix?: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<PreparedArtifact>;

  prepareEncrypted(input: {
    readonly vaultId: string;
    readonly object: StoredArtifactObjectV1;
    readonly encrypted: ReadableStream<Uint8Array>;
    readonly signal?: AbortSignal;
    readonly afterFirstWrite?: () => Promise<void>;
  }): Promise<void>;

  openEncrypted(vaultId: string, objectId: string): Promise<ReadableStream<Uint8Array>>;

  has(vaultId: string, objectId: string): Promise<boolean>;

  verifyEncrypted(vaultId: string, object: StoredArtifactObjectV1): Promise<boolean>;

  openPlaintext(input: {
    readonly vaultId: string;
    readonly object: StoredArtifactObjectV1;
    readonly reference: ArtifactReferenceV1;
    readonly keyring: VaultKeyring;
    readonly signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>>;

  remove(vaultId: string, objectId: string): Promise<void>;

  reconcile(vaultId: string, authoritativeIds: ReadonlySet<string>): Promise<void>;
}
