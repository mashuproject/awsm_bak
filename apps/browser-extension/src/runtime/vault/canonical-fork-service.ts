import { normalizeRecoveryPhrase } from "../../crypto/canonical";
import { wipe } from "../../crypto/sodium";
import type { Identifier } from "../../domain/canonical/identifiers";
import { artifactId, decodeVaultObject } from "../../domain/canonical/object";
import type {
  CanonicalIndexedDb,
  NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import { identifierStorageKey } from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES, type StorageRealm } from "../../drivers/indexeddb/canonical-schema";
import type { CanonicalArtifactStore } from "../artifact/canonical-store";
import { CanonicalReplayService } from "../projection/canonical-replay";
import { type PreparedCanonicalFork, prepareCanonicalFork } from "./canonical-fork-prepare";
import type { LogicalResolution } from "./canonical-local-state";
import { prepareCanonicalVaultStorage } from "./canonical-local-state";
import type { CanonicalVaultService, CreatedCanonicalVault } from "./canonical-service";

export class CanonicalForkCeremony {
  readonly recoveryPhrase: string;
  private active = true;

  constructor(
    private readonly storage: CanonicalIndexedDb,
    private readonly realm: StorageRealm,
    private readonly prepared: PreparedCanonicalFork,
  ) {
    this.recoveryPhrase = prepared.creation.recoveryPhrase;
  }

  async confirm(completeRecoveryPhrase: string): Promise<CreatedCanonicalVault> {
    this.assertActive();
    if (normalizeRecoveryPhrase(completeRecoveryPhrase) !== this.recoveryPhrase) {
      throw Object.assign(new Error("The full Recovery Phrase does not match."), {
        id: "RECOVERY_PHRASE_MISMATCH",
      });
    }
    const { creation } = this.prepared;
    const vaultKey = identifierStorageKey(creation.ids.vaultId);
    const additionalImmutableItems: NamespaceBytes[] = this.prepared.objects.map(
      ({ destination, envelope }) => ({
        namespace: NAMESPACES.vaultObject.key,
        scopeKey: vaultKey,
        itemKey: identifierStorageKey(destination.objectId),
        bytes: envelope.bytes,
      }),
    );
    const additionalLogicalResolutions: LogicalResolution[] = [
      ...this.prepared.objects.map(
        ({ destination, envelope }): LogicalResolution => ({
          vaultId: creation.ids.vaultId,
          kind: 3,
          logicalId: destination.objectId,
          storageItemId: envelope.storageItemId,
          keyEpochId: creation.secrets.keyEpoch.id,
          availability: 1,
        }),
      ),
      ...this.prepared.artifacts.map(
        ({ destinationObject, representation }): LogicalResolution => ({
          vaultId: creation.ids.vaultId,
          kind: 5,
          logicalId: artifactId(destinationObject),
          storageItemId: representation.storageItemId,
          keyEpochId: creation.secrets.keyEpoch.id,
          availability: 1,
        }),
      ),
    ];
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const preparedStorage = await prepareCanonicalVaultStorage({
      creation,
      label: this.prepared.content.state.vaultLabel.value,
      realm: this.realm,
      wrappingKey,
      additionalImmutableItems,
      additionalLogicalResolutions,
    });
    try {
      for (const { representation } of this.prepared.artifacts) {
        await representation.promote();
      }
      await this.storage.commitInitialVault(preparedStorage.commit);
      this.active = false;
      const result = {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        memberId: creation.ids.firstMemberId,
        clientCredentialId: creation.ids.clientCredentialId,
      };
      await this.wipePreparedSecrets();
      return result;
    } catch (error) {
      await Promise.all(
        this.prepared.artifacts.map(({ representation }) =>
          representation.discard().catch(() => undefined),
        ),
      );
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await Promise.all(
      this.prepared.artifacts.map(({ representation }) =>
        representation.discard().catch(() => undefined),
      ),
    );
    await this.wipePreparedSecrets();
  }

  private assertActive(): void {
    if (!this.active) throw new Error("The Fork ceremony is no longer active.");
  }

  private async wipePreparedSecrets(): Promise<void> {
    const { creation } = this.prepared;
    const { client, recovery, keyEpoch } = creation.secrets;
    await Promise.all([
      wipe(client.signingSeed),
      wipe(client.signingSecretKey),
      wipe(client.wrappingPrivateKey),
      wipe(recovery.signingSeed),
      wipe(recovery.signingSecretKey),
      wipe(recovery.wrappingPrivateKey),
      wipe(keyEpoch.key),
      wipe(creation.clientKeyEnvelope.keyEpochKey),
      wipe(creation.clientKeyEnvelope.bytes),
      wipe(creation.recoveryKeyEnvelope.keyEpochKey),
      wipe(creation.recoveryKeyEnvelope.bytes),
    ]);
  }
}

export class CanonicalForkService {
  readonly replay: CanonicalReplayService;

  constructor(
    readonly vaults: CanonicalVaultService,
    readonly artifacts: CanonicalArtifactStore,
  ) {
    this.replay = new CanonicalReplayService(vaults);
  }

  async begin(input: {
    readonly sourceVaultId: Identifier<"Vault">;
    readonly assertedAt: number | bigint;
  }): Promise<CanonicalForkCeremony> {
    const replay = await this.replay.replay(input.sourceVaultId);
    const prepared = await prepareCanonicalFork({
      replay,
      artifactStore: this.artifacts,
      assertedAt: input.assertedAt,
      openObject: async (objectId) =>
        decodeVaultObject(
          (
            await this.vaults.openResolvedCompactItem({
              vault: replay.vault,
              kind: 3,
              logicalId: objectId,
              namespace: NAMESPACES.vaultObject.key,
              payloadType: 2,
            })
          ).payloadBytes,
        ),
      readArtifactResolution: async (logicalArtifactId) =>
        this.vaults.readLogicalResolution({
          vault: replay.vault,
          kind: 5,
          logicalId: logicalArtifactId,
        }),
    });
    return new CanonicalForkCeremony(this.vaults.storage, this.vaults.realm, prepared);
  }
}
