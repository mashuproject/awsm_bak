import { type CompactPayloadType, sealCompactItem } from "../../crypto/compact";
import { sealKeyEnvelope } from "../../crypto/key-envelope";
import { wipe } from "../../crypto/sodium";
import { type Identifier, identifier } from "../../domain/canonical/identifiers";
import { decodeVaultObject, type VaultObject } from "../../domain/canonical/object";
import {
  type AuthenticatedVaultEvent,
  decodeVaultBaseline,
  decodeVaultEvent,
  type VaultBaseline,
} from "../../domain/canonical/record";
import { decodeCanonicalValue } from "../../domain/canonical/value";
import { bytesEqual, sha256 } from "../../domain/hash";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import { decodeOpaqueEnvelope } from "../../storage/opaque-envelope";
import { collectCompleteExportReachability } from "../complete-export/reachability";
import type { CanonicalAuthorityState } from "../projection/canonical-authority-replay";
import type { CanonicalReplayService } from "../projection/canonical-replay";
import type { EpochSecretState } from "../vault/canonical-local-state";
import type {
  CanonicalVaultService,
  PersistedOpenedCanonicalVault,
} from "../vault/canonical-service";
import { CanonicalHostedReplicaHttp } from "./canonical-host-http";
import {
  deriveHostedReplicaOpaqueLocator,
  type HostedReplicaLogicalNamespace,
} from "./canonical-hosted-replica-locator";
import type { CanonicalRemoteMaterializationLedgerService } from "./canonical-remote-materialization-ledger-service";
import type { CanonicalReplicaRemoteService } from "./canonical-remote-service";
import type { CanonicalRemoteMaterializationLedgerEntry } from "./canonical-state";

type VaultRecord = AuthenticatedVaultEvent | VaultBaseline;

interface ResolvedCompactItem {
  readonly logicalNamespace: 1 | 3 | 4;
  readonly logicalId: Identifier<"VaultRecord" | "VaultObject" | "FeatureManifest">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly payloadType: 1 | 2 | 3;
  readonly payloadBytes: Uint8Array;
}

interface ResolvedKeyEnvelope {
  readonly logicalNamespace: 2;
  readonly logicalId: Identifier<"KeyEnvelope">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly targetKind: 1 | 2;
  readonly targetCredentialId: Identifier<"RecoveryCredential" | "ClientCredential">;
  readonly targetRevision: number | null;
  readonly recipientWrappingPublicKey: Uint8Array;
}

type MaterializationTarget = ResolvedCompactItem | ResolvedKeyEnvelope;

type ReplayPort = Pick<CanonicalReplayService, "replay"> & {
  readonly vaults: Pick<CanonicalVaultService, "listEpochSecrets" | "openResolvedCompactItem">;
};

type LedgerPort = Pick<CanonicalRemoteMaterializationLedgerService, "confirm" | "find" | "prepare">;

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function decodeRecord(bytes: Uint8Array): VaultRecord {
  const value = decodeCanonicalValue(bytes);
  if (!(value instanceof Map)) throw new TypeError("Hosted materialization Record is not a map");
  const kind = value.get(6);
  if (kind === 1) return decodeVaultEvent(bytes);
  if (kind === 2) return decodeVaultBaseline(bytes);
  throw new TypeError("Hosted materialization Record kind is unsupported");
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function compareTargets(left: MaterializationTarget, right: MaterializationTarget): number {
  return (
    left.logicalNamespace - right.logicalNamespace || compareBytes(left.logicalId, right.logicalId)
  );
}

function wrappingPublicKey(
  authority: CanonicalAuthorityState,
  slot: CanonicalAuthorityState["keyEnvelopeSlots"][number],
): Uint8Array {
  if (slot.targetKind === 1) {
    const candidates = authority.recoveryCredentials.filter(
      (credential) =>
        bytesEqual(credential.recoveryCredentialId, slot.targetCredentialId) &&
        credential.revision === slot.targetRevision,
    );
    if (candidates.length !== 1) {
      throw new TypeError("Key Envelope target Recovery Credential is not authoritative");
    }
    const credential = candidates[0];
    if (credential === undefined) throw new TypeError("Key Envelope target is unavailable");
    return credential.wrappingPublicKey;
  }
  const credential = authority.clientCredentials.get(key(slot.targetCredentialId));
  if (
    credential === undefined ||
    !bytesEqual(credential.clientCredentialId, slot.targetCredentialId)
  ) {
    throw new TypeError("Key Envelope target Client Credential is not authoritative");
  }
  return credential.wrappingPublicKey;
}

function keyEnvelopeTargets(input: {
  readonly authority: CanonicalAuthorityState;
  readonly keyEnvelopeIds: readonly Identifier<"KeyEnvelope">[];
}): readonly ResolvedKeyEnvelope[] {
  const slots = new Map(
    input.authority.keyEnvelopeSlots.map((slot) => [key(slot.keyEnvelopeId), slot]),
  );
  if (slots.size !== input.authority.keyEnvelopeSlots.length) {
    throw new TypeError("Authority State repeats a Key Envelope slot");
  }
  return input.keyEnvelopeIds.map((logicalId) => {
    const slot = slots.get(key(logicalId));
    if (slot === undefined || !bytesEqual(slot.keyEnvelopeId, logicalId)) {
      throw new TypeError("Reachable Key Envelope has no authoritative target slot");
    }
    return {
      logicalNamespace: 2,
      logicalId,
      keyEpochId: slot.keyEpochId,
      targetKind: slot.targetKind,
      targetCredentialId: identifier(
        slot.targetKind === 1 ? "RecoveryCredential" : "ClientCredential",
        slot.targetCredentialId,
      ),
      targetRevision: slot.targetRevision,
      recipientWrappingPublicKey: wrappingPublicKey(input.authority, slot),
    };
  });
}

async function sealedBytes(input: {
  readonly target: MaterializationTarget;
  readonly vaultId: Identifier<"Vault">;
  readonly epochs: ReadonlyMap<string, EpochSecretState>;
}): Promise<{ readonly keyEpochId: Identifier<"KeyEpoch">; readonly bytes: Uint8Array }> {
  const epoch = input.epochs.get(key(input.target.keyEpochId));
  if (epoch === undefined || !bytesEqual(epoch.keyEpochId, input.target.keyEpochId)) {
    throw new TypeError("Hosted materialization requires the target Key Epoch locally");
  }
  if (input.target.logicalNamespace === 2) {
    const sealed = await sealKeyEnvelope({
      vaultId: input.vaultId,
      keyEpochId: epoch.keyEpochId,
      keyEpochKey: epoch.key,
      targetKind: input.target.targetKind,
      targetCredentialId: input.target.targetCredentialId,
      targetRevision: input.target.targetRevision,
      recipientWrappingPublicKey: input.target.recipientWrappingPublicKey,
    });
    if (!bytesEqual(sealed.id, input.target.logicalId)) {
      throw new TypeError("Fresh Key Envelope does not preserve its logical identity");
    }
    return { keyEpochId: epoch.keyEpochId, bytes: sealed.envelope.bytes };
  }
  const envelope = await sealCompactItem({
    vaultId: input.vaultId,
    keyEpochId: epoch.keyEpochId,
    keyEpochKey: epoch.key,
    payloadType: input.target.payloadType as CompactPayloadType,
    payloadBytes: input.target.payloadBytes,
  });
  return { keyEpochId: epoch.keyEpochId, bytes: envelope.bytes };
}

/**
 * Materializes an authenticated Compact closure to one Hosted Replica without making that Host an
 * authority. Streamable Artifact wrappers remain sparse and are retrieved by explicit hydration.
 */
export class CanonicalHostedCompactMaterializationService {
  constructor(
    private readonly dependencies: {
      readonly remotes: Pick<CanonicalReplicaRemoteService, "withLoaded">;
      readonly replays: ReplayPort;
      readonly ledger: LedgerPort;
      readonly createHttp?: (input: {
        readonly endpoint: string;
        readonly bearerToken: string;
      }) => Pick<CanonicalHostedReplicaHttp, "admitCompact">;
    },
  ) {}

  async materialize(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
  }): Promise<{
    readonly remoteId: string;
    readonly materializedCompactItemCount: number;
    readonly retriedCompactItemCount: number;
    readonly alreadyConfirmedCompactItemCount: number;
  }> {
    return this.dependencies.remotes.withLoaded(input, async ({ remote, bearerToken }) => {
      if (!remote.enabled) throw new TypeError("Cannot materialize to a disabled Replica Remote");
      if (remote.remoteId !== input.remoteId || !bytesEqual(remote.vaultId, input.vaultId)) {
        throw new TypeError("Configured Replica Remote does not match the requested Vault");
      }
      const replay = await this.dependencies.replays.replay(input.vaultId);
      same(replay.vault.replicaState.vaultId, input.vaultId, "Materialized Vault ID");
      const epochs = await this.dependencies.replays.vaults.listEpochSecrets(replay.vault);
      try {
        const targets = await this.targets(replay.vault, replay.authority);
        const epochById = new Map(epochs.map((epoch) => [key(epoch.keyEpochId), epoch]));
        if (epochById.size !== epochs.length) {
          throw new TypeError("Local Key Epoch inventory repeats an identity");
        }
        const http =
          this.dependencies.createHttp?.({ endpoint: remote.endpoint, bearerToken }) ??
          new CanonicalHostedReplicaHttp({ endpoint: remote.endpoint, bearerToken });
        let materializedCompactItemCount = 0;
        let retriedCompactItemCount = 0;
        let alreadyConfirmedCompactItemCount = 0;
        for (const target of targets) {
          const locator = await deriveHostedReplicaOpaqueLocator({
            locatorSalt: remote.locatorSalt,
            logicalNamespace: target.logicalNamespace as HostedReplicaLogicalNamespace,
            logicalId: target.logicalId,
          });
          const existing = await this.dependencies.ledger.find({
            vaultId: input.vaultId,
            remoteId: input.remoteId,
            logicalNamespace: target.logicalNamespace,
            logicalId: target.logicalId,
          });
          if (existing !== null) {
            if (!bytesEqual(existing.entry.locator, locator)) {
              throw new TypeError(
                "Remote materialization ledger locator does not match this Remote",
              );
            }
            if (existing.entry.state === "Confirmed") {
              alreadyConfirmedCompactItemCount += 1;
              continue;
            }
            if (existing.bytes === null) {
              throw new TypeError("Prepared Remote materialization has no retry bytes");
            }
            const admission = await http.admitCompact({
              replicaHandle: remote.hostedReplicaHandle,
              locator,
              bytes: existing.bytes,
            });
            await this.dependencies.ledger.confirm({ entry: existing.entry, admission });
            retriedCompactItemCount += 1;
            continue;
          }
          const sealed = await sealedBytes({ target, vaultId: input.vaultId, epochs: epochById });
          const envelope = decodeOpaqueEnvelope(sealed.bytes);
          const entry: CanonicalRemoteMaterializationLedgerEntry = {
            vaultId: input.vaultId,
            remoteId: input.remoteId,
            logicalNamespace: target.logicalNamespace,
            logicalId: target.logicalId,
            keyEpochId: sealed.keyEpochId,
            locator,
            storageItemId: envelope.storageItemId,
            byteLength: envelope.bytes.byteLength,
            byteDigest: await sha256(envelope.bytes),
            state: "Prepared",
          };
          await this.dependencies.ledger.prepare({ entry, bytes: envelope.bytes });
          const admission = await http.admitCompact({
            replicaHandle: remote.hostedReplicaHandle,
            locator,
            bytes: envelope.bytes,
          });
          await this.dependencies.ledger.confirm({ entry, admission });
          materializedCompactItemCount += 1;
        }
        return {
          remoteId: input.remoteId,
          materializedCompactItemCount,
          retriedCompactItemCount,
          alreadyConfirmedCompactItemCount,
        };
      } finally {
        await Promise.all(epochs.map(({ key: epochKey }) => wipe(epochKey)));
      }
    });
  }

  private async targets(
    vault: PersistedOpenedCanonicalVault,
    authority: CanonicalAuthorityState,
  ): Promise<readonly MaterializationTarget[]> {
    const recordCache = new Map<string, ResolvedCompactItem & { readonly value: VaultRecord }>();
    const objectCache = new Map<string, ResolvedCompactItem & { readonly value: VaultObject }>();
    const featureCache = new Map<string, ResolvedCompactItem>();
    const loadRecord = async (id: Identifier<"VaultRecord">): Promise<VaultRecord> => {
      const cached = recordCache.get(key(id));
      if (cached !== undefined) return cached.value;
      const opened = await this.dependencies.replays.vaults.openResolvedCompactItem({
        vault,
        kind: 1,
        logicalId: id,
        namespace: NAMESPACES.vaultRecord.key,
        payloadType: 1,
      });
      const value = decodeRecord(opened.payloadBytes);
      same(value.recordId, id, "Materialized Record ID");
      recordCache.set(key(id), {
        logicalNamespace: 1,
        logicalId: id,
        keyEpochId: opened.keyEpochId,
        payloadType: 1,
        payloadBytes: opened.payloadBytes,
        value,
      });
      return value;
    };
    const loadObject = async (id: Identifier<"VaultObject">): Promise<VaultObject> => {
      const cached = objectCache.get(key(id));
      if (cached !== undefined) return cached.value;
      const opened = await this.dependencies.replays.vaults.openResolvedCompactItem({
        vault,
        kind: 3,
        logicalId: id,
        namespace: NAMESPACES.vaultObject.key,
        payloadType: 2,
      });
      const value = decodeVaultObject(opened.payloadBytes);
      same(value.objectId, id, "Materialized Vault Object ID");
      objectCache.set(key(id), {
        logicalNamespace: 3,
        logicalId: id,
        keyEpochId: opened.keyEpochId,
        payloadType: 2,
        payloadBytes: opened.payloadBytes,
        value,
      });
      return value;
    };
    const loadFeatureManifest = async (id: Identifier<"FeatureManifest">): Promise<Uint8Array> => {
      const cached = featureCache.get(key(id));
      if (cached !== undefined) return cached.payloadBytes;
      const opened = await this.dependencies.replays.vaults.openResolvedCompactItem({
        vault,
        kind: 4,
        logicalId: id,
        namespace: NAMESPACES.featureManifest.key,
        payloadType: 3,
      });
      featureCache.set(key(id), {
        logicalNamespace: 4,
        logicalId: id,
        keyEpochId: opened.keyEpochId,
        payloadType: 3,
        payloadBytes: opened.payloadBytes,
      });
      return opened.payloadBytes;
    };
    const reachability = await collectCompleteExportReachability({
      vaultId: vault.replicaState.vaultId,
      generationId: vault.replicaState.generationId,
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      baselineId: vault.replicaState.baselineId,
      causalFrontier: vault.replicaState.causalFrontier,
      authorityFrontier: vault.replicaState.authorityFrontier,
      loadRecord,
      loadObject,
      loadFeatureManifest,
    });
    const compactTargets: ResolvedCompactItem[] = [
      ...reachability.recordIds.map((id) => {
        const resolved = recordCache.get(key(id));
        if (resolved === undefined) throw new TypeError("Reachable Record cache is incomplete");
        return resolved;
      }),
      ...reachability.vaultObjectIds.map((id) => {
        const resolved = objectCache.get(key(id));
        if (resolved === undefined)
          throw new TypeError("Reachable Vault Object cache is incomplete");
        return resolved;
      }),
      ...reachability.featureManifestIds.map((id) => {
        const resolved = featureCache.get(key(id));
        if (resolved === undefined)
          throw new TypeError("Reachable Feature Manifest cache is incomplete");
        return resolved;
      }),
    ];
    return [
      ...compactTargets,
      ...keyEnvelopeTargets({ authority, keyEnvelopeIds: reachability.keyEnvelopeIds }),
    ].toSorted(compareTargets);
  }
}
