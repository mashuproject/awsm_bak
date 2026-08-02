import { wipe } from "../../crypto/sodium";
import { type Identifier, identifier } from "../../domain/canonical/identifiers";
import {
  ARTIFACT_OBJECT,
  artifactId,
  decodeVaultObject,
  type VaultObject,
} from "../../domain/canonical/object";
import { bytesEqual } from "../../domain/hash";
import {
  identifierStorageKey,
  type NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES, type StorageRealm } from "../../drivers/indexeddb/canonical-schema";
import type { CanonicalArtifactImportStore } from "../artifact/canonical-store";
import { verifyCanonicalArtifactRepresentation } from "../artifact/canonical-verify";
import {
  canonicalLocalStorageContext,
  type EpochSecretState,
  encodeLogicalResolution,
  type LogicalResolution,
  prepareWrappedLocalStateItem,
} from "../vault/canonical-local-state";
import type { PersistedOpenedCanonicalVault } from "../vault/canonical-service";
import {
  CanonicalHostedReplicaHttp,
  type CanonicalOpaqueInventoryItem,
} from "./canonical-host-http";
import {
  deriveHostedReplicaOpaqueLocator,
  HOSTED_REPLICA_LOGICAL_NAMESPACE,
} from "./canonical-hosted-replica-locator";
import type { CanonicalReplicaRemote } from "./canonical-state";

type ArtifactResolution = LogicalResolution & {
  readonly kind: 5;
  readonly logicalId: Identifier<"Artifact">;
};

type VaultPort = {
  readonly realm: StorageRealm;
  readonly storage: {
    commitReplicaMutation(input: {
      readonly realm: StorageRealm;
      readonly expectedReplicaState: Uint8Array;
      readonly expectedAbsentItems?: readonly Omit<NamespaceBytes, "bytes">[];
      readonly expectedMutableItems?: readonly NamespaceBytes[];
      readonly nextReplicaState: NamespaceBytes;
      readonly mutableItems?: readonly NamespaceBytes[];
    }): Promise<void>;
    getBytes(
      realm: StorageRealm,
      item: Omit<NamespaceBytes, "bytes">,
    ): Promise<Uint8Array | undefined>;
  };
  openVault(vaultId: Identifier<"Vault">): Promise<PersistedOpenedCanonicalVault>;
  listEpochSecrets(vault: PersistedOpenedCanonicalVault): Promise<readonly EpochSecretState[]>;
  openResolvedCompactItem(input: {
    readonly vault: PersistedOpenedCanonicalVault;
    readonly kind: 3;
    readonly logicalId: Identifier<"VaultObject">;
    readonly namespace: typeof NAMESPACES.vaultObject.key;
    readonly payloadType: 2;
  }): Promise<{ readonly payloadBytes: Uint8Array }>;
  readLogicalResolution(input: {
    readonly vault: PersistedOpenedCanonicalVault;
    readonly kind: 5;
    readonly logicalId: Identifier<"Artifact">;
  }): Promise<LogicalResolution>;
};

type RemotePort = {
  list(vaultId: Identifier<"Vault">): Promise<readonly CanonicalReplicaRemote[]>;
  load(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
  }): Promise<{ readonly remote: CanonicalReplicaRemote; readonly bearerToken: string }>;
};

type HttpPort = Pick<CanonicalHostedReplicaHttp, "inventory" | "item">;

function resolutionItem(vaultId: Identifier<"Vault">, artifactId: Identifier<"Artifact">) {
  return {
    namespace: NAMESPACES.logicalResolution.key,
    scopeKey: identifierStorageKey(vaultId),
    itemKey: `5:${identifierStorageKey(artifactId)}`,
  };
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function requireArtifactObject(
  input: VaultObject,
  vault: PersistedOpenedCanonicalVault,
  expectedArtifactId: Identifier<"Artifact">,
): VaultObject {
  if (input.objectType !== ARTIFACT_OBJECT) {
    throw new TypeError("Hydration target is not an Artifact Object");
  }
  same(input.vaultId, vault.replicaState.vaultId, "Artifact Object Vault ID");
  same(
    input.requiredFeatureSetId,
    vault.replicaState.requiredFeatureSetId,
    "Artifact Object Required Feature Set ID",
  );
  same(artifactId(input), expectedArtifactId, "Artifact Object ID");
  return input;
}

async function verifiedEpoch(input: {
  readonly artifacts: CanonicalArtifactImportStore;
  readonly storageItemId: Identifier<"StorageItem">;
  readonly object: VaultObject;
  readonly epochs: readonly EpochSecretState[];
}): Promise<EpochSecretState | undefined> {
  for (const epoch of input.epochs) {
    try {
      await verifyCanonicalArtifactRepresentation({
        store: input.artifacts,
        storageItemId: input.storageItemId,
        object: input.object,
        keyEpochId: epoch.keyEpochId,
        keyEpochKey: epoch.key,
        writePlaintext: async () => undefined,
      });
      return epoch;
    } catch {
      // A candidate remains untrusted until one locally held Epoch key validates every frame.
    }
  }
  return undefined;
}

async function artifactCandidates(input: {
  readonly http: HttpPort;
  readonly remote: CanonicalReplicaRemote;
  readonly artifactId: Identifier<"Artifact">;
}): Promise<readonly CanonicalOpaqueInventoryItem[]> {
  const expectedLocator = await deriveHostedReplicaOpaqueLocator({
    locatorSalt: input.remote.locatorSalt,
    logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.Artifact,
    logicalId: input.artifactId,
  });
  const candidates: CanonicalOpaqueInventoryItem[] = [];
  const positions = new Set<string>();
  let snapshotCursor: number | undefined;
  let position: Identifier<"StorageItem"> | undefined;
  for (;;) {
    const page = await input.http.inventory({
      replicaHandle: input.remote.hostedReplicaHandle,
      ...(snapshotCursor === undefined ? {} : { snapshotCursor }),
      ...(position === undefined ? {} : { position }),
      limit: input.remote.inventoryPageSize,
    });
    if (snapshotCursor === undefined) snapshotCursor = page.snapshotCursor;
    else if (page.snapshotCursor !== snapshotCursor) {
      throw new TypeError("Hosted Replica inventory changed its observed snapshot");
    }
    for (const item of page.items) {
      if (item.storageClass === 2 && bytesEqual(item.locator, expectedLocator))
        candidates.push(item);
    }
    if (page.nextPosition === null) return candidates;
    const next = identifierStorageKey(page.nextPosition);
    if (positions.has(next))
      throw new TypeError("Hosted Replica inventory repeats a page position");
    positions.add(next);
    position = page.nextPosition;
  }
}

async function downloadVerifiedArtifactCandidate(input: {
  readonly artifacts: CanonicalArtifactImportStore;
  readonly http: HttpPort;
  readonly remote: CanonicalReplicaRemote;
  readonly candidate: CanonicalOpaqueInventoryItem;
  readonly artifactId: Identifier<"Artifact">;
  readonly object: VaultObject;
  readonly epochs: readonly EpochSecretState[];
}): Promise<
  | {
      readonly storageItemId: Identifier<"StorageItem">;
      readonly epoch: EpochSecretState;
    }
  | undefined
> {
  try {
    const prepared = await input.artifacts.prepareOpaque({
      artifactId: input.artifactId,
      storageItemId: input.candidate.storageItemId,
      envelopeByteLength: input.candidate.byteLength,
      source: await input.http.item({
        replicaHandle: input.remote.hostedReplicaHandle,
        storageItemId: input.candidate.storageItemId,
        byteLength: input.candidate.byteLength,
      }),
    });
    try {
      await prepared.promote();
      const epoch = await verifiedEpoch({
        artifacts: input.artifacts,
        storageItemId: input.candidate.storageItemId,
        object: input.object,
        epochs: input.epochs,
      });
      return epoch === undefined
        ? undefined
        : { storageItemId: input.candidate.storageItemId, epoch };
    } finally {
      await prepared.discard().catch(() => undefined);
    }
  } catch {
    // The Remote supplied no usable representation. Its bytes cannot change local state.
    return undefined;
  }
}

/** Retrieves one known Streamable Artifact from configured opaque Remotes without giving a Host semantic authority. */
export class CanonicalHostedArtifactHydrationService {
  constructor(
    private readonly dependencies: {
      readonly remotes: RemotePort;
      readonly vaults: VaultPort;
      readonly artifacts: CanonicalArtifactImportStore;
      readonly createHttp?: (input: {
        readonly endpoint: string;
        readonly bearerToken: string;
      }) => HttpPort;
    },
  ) {}

  async hydrate(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly artifactId: Identifier<"Artifact">;
  }): Promise<{
    readonly artifactId: Identifier<"Artifact">;
    readonly storageItemId: Identifier<"StorageItem">;
    readonly remoteId: string;
  }> {
    const vault = await this.dependencies.vaults.openVault(input.vaultId);
    const object = requireArtifactObject(
      decodeVaultObject(
        (
          await this.dependencies.vaults.openResolvedCompactItem({
            vault,
            kind: 3,
            logicalId: identifier("VaultObject", input.artifactId),
            namespace: NAMESPACES.vaultObject.key,
            payloadType: 2,
          })
        ).payloadBytes,
      ),
      vault,
      input.artifactId,
    );
    const epochs = await this.dependencies.vaults.listEpochSecrets(vault);
    try {
      const item = resolutionItem(input.vaultId, input.artifactId);
      const existingBytes = await this.dependencies.vaults.storage.getBytes(
        this.dependencies.vaults.realm,
        item,
      );
      if (existingBytes !== undefined) {
        const existing = await this.dependencies.vaults.readLogicalResolution({
          vault,
          kind: 5,
          logicalId: input.artifactId,
        });
        if (existing.kind !== 5 || !bytesEqual(existing.logicalId, input.artifactId)) {
          throw new TypeError("Stored Artifact Resolution does not match its local identity");
        }
        if (
          existing.availability === 1 &&
          (await this.dependencies.artifacts.has(existing.storageItemId))
        ) {
          const epoch = await verifiedEpoch({
            artifacts: this.dependencies.artifacts,
            storageItemId: existing.storageItemId,
            object,
            epochs,
          });
          if (epoch !== undefined) {
            return {
              artifactId: input.artifactId,
              storageItemId: existing.storageItemId,
              remoteId: "local",
            };
          }
        }
      }
      const remotes = await this.dependencies.remotes.list(input.vaultId);
      const remoteIds = new Set<string>();
      for (const remote of remotes) {
        if (!bytesEqual(remote.vaultId, input.vaultId) || remoteIds.has(remote.remoteId)) {
          throw new TypeError(
            "Configured Replica Remote identity is invalid for Artifact hydration",
          );
        }
        remoteIds.add(remote.remoteId);
      }
      for (const configured of remotes.toSorted((left, right) =>
        left.remoteId.localeCompare(right.remoteId),
      )) {
        if (!configured.enabled) continue;
        let loaded: { readonly remote: CanonicalReplicaRemote; readonly bearerToken: string };
        try {
          loaded = await this.dependencies.remotes.load({
            vaultId: input.vaultId,
            remoteId: configured.remoteId,
          });
        } catch {
          // A locally unavailable channel must not prevent another configured Remote from serving the Artifact.
          continue;
        }
        const { remote, bearerToken } = loaded;
        if (
          !bytesEqual(remote.vaultId, input.vaultId) ||
          remote.remoteId !== configured.remoteId ||
          remote.endpoint !== configured.endpoint ||
          remote.hostedReplicaHandle !== configured.hostedReplicaHandle ||
          !bytesEqual(remote.locatorSalt, configured.locatorSalt) ||
          remote.enabled !== configured.enabled ||
          remote.inventoryPageSize !== configured.inventoryPageSize
        ) {
          throw new TypeError(
            "Loaded Replica Remote does not match Artifact hydration configuration",
          );
        }
        let http: HttpPort;
        let candidates: readonly CanonicalOpaqueInventoryItem[];
        try {
          http =
            this.dependencies.createHttp?.({ endpoint: remote.endpoint, bearerToken }) ??
            new CanonicalHostedReplicaHttp({ endpoint: remote.endpoint, bearerToken });
          candidates = await artifactCandidates({ http, remote, artifactId: input.artifactId });
        } catch {
          // An unavailable or malformed Remote must not prevent another configured Remote from serving the Artifact.
          continue;
        }
        for (const candidate of candidates) {
          const downloaded = await downloadVerifiedArtifactCandidate({
            artifacts: this.dependencies.artifacts,
            http,
            remote,
            candidate,
            artifactId: input.artifactId,
            object,
            epochs,
          });
          if (downloaded === undefined) continue;
          const resolution: ArtifactResolution = {
            vaultId: input.vaultId,
            kind: 5,
            logicalId: input.artifactId,
            storageItemId: downloaded.storageItemId,
            keyEpochId: downloaded.epoch.keyEpochId,
            availability: 1,
          };
          const nextResolution = await prepareWrappedLocalStateItem({
            ...item,
            wrappingKey: vault.installationWrappingKey,
            domain: "awsm.local.logical-resolution",
            context: canonicalLocalStorageContext(input.vaultId, input.artifactId),
            bytes: encodeLogicalResolution(resolution),
          });
          await this.dependencies.vaults.storage.commitReplicaMutation({
            realm: this.dependencies.vaults.realm,
            expectedReplicaState: vault.replicaStateStorageBytes,
            ...(existingBytes === undefined
              ? { expectedAbsentItems: [item] }
              : { expectedMutableItems: [{ ...item, bytes: existingBytes }] }),
            nextReplicaState: {
              namespace: NAMESPACES.replicaState.key,
              scopeKey: identifierStorageKey(input.vaultId),
              itemKey: "current",
              bytes: vault.replicaStateStorageBytes,
            },
            mutableItems: [nextResolution],
          });
          return {
            artifactId: input.artifactId,
            storageItemId: downloaded.storageItemId,
            remoteId: remote.remoteId,
          };
        }
      }
      throw Object.assign(new Error("No configured Remote supplied a verified Artifact wrapper."), {
        id: "ARTIFACT_REMOTE_UNAVAILABLE",
      });
    } finally {
      await Promise.all(epochs.map(({ key }) => wipe(key)));
    }
  }
}
