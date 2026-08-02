import {
  deriveRecoveryCredential,
  encodeRecoveryPhrase,
  type RecoveryCredentialKeys,
} from "../../crypto/canonical";
import { sealCompactItem } from "../../crypto/compact";
import {
  openKeyEnvelope,
  type SealedKeyEnvelope,
  sealKeyEnvelope,
} from "../../crypto/key-envelope";
import { readySodium, wipe } from "../../crypto/sodium";
import { DEPENDENCY_TYPES } from "../../domain/canonical/dependencies";
import { advisoryExtensions } from "../../domain/canonical/features";
import { type Identifier, randomIdentifier } from "../../domain/canonical/identifiers";
import { type AuthenticatedVaultEvent, signVaultEvent } from "../../domain/canonical/record";
import { transcript } from "../../domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import type { OpaqueEnvelope } from "../../storage/opaque-envelope";
import type { ReplayedCanonicalVault } from "../projection/canonical-replay";
import type { CanonicalReplicaState, EpochSecretState } from "./canonical-local-state";
import { requireCanonicalClientSecret } from "./canonical-service";

export interface PreparedCanonicalRecoveryCredential {
  readonly recoveryCredentialId: Identifier<"RecoveryCredential">;
  readonly memberId: Identifier<"Member">;
  readonly revision: number;
  readonly signingPublicKey: Uint8Array;
  readonly wrappingPublicKey: Uint8Array;
}

export interface CanonicalRecoveryReplacementDeterminism {
  readonly recoveryCredentialId?: Identifier<"RecoveryCredential">;
  readonly recoveryEntropy?: Uint8Array;
  readonly recoveryEnvelopePaddings?: readonly Uint8Array[];
  readonly eventProtectionParameters?: Uint8Array;
}

export interface PreparedCanonicalRecoveryCredentialReplacement {
  readonly recoveryPhrase: string;
  readonly recoveryCredential: PreparedCanonicalRecoveryCredential;
  readonly replacedRecoveryCredentialIds: readonly Identifier<"RecoveryCredential">[];
  readonly recoveryKeyEnvelopes: readonly SealedKeyEnvelope[];
  readonly event: AuthenticatedVaultEvent;
  readonly eventEnvelope: OpaqueEnvelope;
  readonly nextReplicaState: CanonicalReplicaState;
}

function byteKey(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return byteKey(left).localeCompare(byteKey(right));
}

function indexedMap(...values: readonly CanonicalValue[]): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap(values.map((value, index) => [index, value] as const));
}

async function wipeRecoveryKeys(keys: RecoveryCredentialKeys): Promise<void> {
  await Promise.all([
    wipe(keys.signingSeed),
    wipe(keys.signingSecretKey),
    wipe(keys.wrappingPrivateKey),
  ]);
}

export async function wipePreparedCanonicalRecoveryCredentialReplacement(
  prepared: PreparedCanonicalRecoveryCredentialReplacement,
): Promise<void> {
  await Promise.all(
    prepared.recoveryKeyEnvelopes.flatMap((envelope) => [
      wipe(envelope.keyEpochKey),
      wipe(envelope.bytes),
    ]),
  );
}

export async function prepareCanonicalRecoveryCredentialReplacement(input: {
  readonly replay: ReplayedCanonicalVault;
  readonly epochSecrets: readonly EpochSecretState[];
  readonly assertedAt: number | bigint;
  readonly deterministic?: CanonicalRecoveryReplacementDeterminism;
}): Promise<PreparedCanonicalRecoveryCredentialReplacement> {
  const { replay } = input;
  if (replay.vault.replicaState.lifecycle !== 1) {
    throw new TypeError("Closed Vaults cannot replace a Recovery Credential");
  }
  const clientSecret = requireCanonicalClientSecret(replay.vault);
  const clientAuthority = replay.authority.clientCredentials.get(
    byteKey(clientSecret.clientCredentialId),
  );
  if (
    clientAuthority === undefined ||
    !clientAuthority.active ||
    !bytesEqual(clientAuthority.memberId, clientSecret.memberId)
  ) {
    throw new TypeError("Recovery Replacement requires an active same-member Client Credential");
  }
  const effectiveRecovery = replay.authority.recoveryCredentials
    .filter(({ memberId, effective }) => effective && bytesEqual(memberId, clientSecret.memberId))
    .sort((left, right) => compareBytes(left.recoveryCredentialId, right.recoveryCredentialId));
  if (effectiveRecovery.length === 0) {
    throw new TypeError("Recovery Replacement requires an effective Recovery Credential head");
  }

  const epochs = [...replay.authority.keyEpochs].sort(
    (left, right) =>
      left.displayNumber - right.displayNumber || compareBytes(left.keyEpochId, right.keyEpochId),
  );
  if (epochs.length === 0 || input.epochSecrets.length !== epochs.length) {
    throw new TypeError("Recovery Replacement requires the complete local Key Epoch set");
  }
  const orderedEpochSecrets = epochs.map((epoch) => {
    const matches = input.epochSecrets.filter(({ keyEpochId }) =>
      bytesEqual(keyEpochId, epoch.keyEpochId),
    );
    if (matches.length !== 1) {
      throw new TypeError("Recovery Replacement requires the complete local Key Epoch set");
    }
    const secret = matches[0];
    if (
      secret === undefined ||
      !bytesEqual(secret.vaultId, replay.vault.replicaState.vaultId) ||
      secret.displayNumber !== epoch.displayNumber
    ) {
      throw new TypeError("Recovery Replacement Key Epoch metadata does not match Authority State");
    }
    return secret;
  });

  const deterministic = input.deterministic ?? {};
  const entropy =
    deterministic.recoveryEntropy === undefined
      ? crypto.getRandomValues(new Uint8Array(16))
      : Uint8Array.from(deterministic.recoveryEntropy);
  let recoveryKeys: RecoveryCredentialKeys | undefined;
  const recoveryKeyEnvelopes: SealedKeyEnvelope[] = [];
  let succeeded = false;
  try {
    const recoveryPhrase = encodeRecoveryPhrase(entropy);
    recoveryKeys = await deriveRecoveryCredential(entropy);
    const recoveryCredentialId =
      deterministic.recoveryCredentialId ?? randomIdentifier("RecoveryCredential");
    if (
      replay.authority.recoveryCredentials.some(({ recoveryCredentialId: existing }) =>
        bytesEqual(existing, recoveryCredentialId),
      )
    ) {
      throw new TypeError("Recovery Replacement reuses a Recovery Credential identity");
    }
    const revision =
      effectiveRecovery.reduce(
        (maximum, credential) => Math.max(maximum, credential.revision),
        -1,
      ) + 1;
    const recoveryCredential: PreparedCanonicalRecoveryCredential = {
      recoveryCredentialId,
      memberId: clientSecret.memberId,
      revision,
      signingPublicKey: recoveryKeys.signingPublicKey,
      wrappingPublicKey: recoveryKeys.wrappingPublicKey,
    };
    const descriptor = indexedMap(
      recoveryCredentialId,
      clientSecret.memberId,
      revision,
      recoveryKeys.signingPublicKey,
      recoveryKeys.wrappingPublicKey,
    );

    for (const [index, epoch] of orderedEpochSecrets.entries()) {
      const envelope = await sealKeyEnvelope({
        vaultId: replay.vault.replicaState.vaultId,
        keyEpochId: epoch.keyEpochId,
        keyEpochKey: epoch.key,
        targetKind: 1,
        targetCredentialId: recoveryCredentialId,
        targetRevision: revision,
        recipientWrappingPublicKey: recoveryKeys.wrappingPublicKey,
        ...(deterministic.recoveryEnvelopePaddings?.[index] === undefined
          ? {}
          : { outerPadding: deterministic.recoveryEnvelopePaddings[index] }),
      });
      const challenge = await openKeyEnvelope({
        targetKind: 1,
        recipientWrappingPrivateKey: recoveryKeys.wrappingPrivateKey,
        envelopeBytes: envelope.envelope.bytes,
      });
      try {
        if (
          !bytesEqual(challenge.id, envelope.id) ||
          !bytesEqual(challenge.vaultId, replay.vault.replicaState.vaultId) ||
          !bytesEqual(challenge.keyEpochId, epoch.keyEpochId) ||
          !bytesEqual(challenge.keyEpochKey, epoch.key) ||
          !bytesEqual(challenge.targetCredentialId, recoveryCredentialId) ||
          challenge.targetRevision !== revision
        ) {
          throw new TypeError("Replacement Recovery wrapping-key challenge failed");
        }
      } finally {
        await Promise.all([wipe(challenge.keyEpochKey), wipe(challenge.bytes)]);
      }
      recoveryKeyEnvelopes.push(envelope);
    }

    const recoveryEnvelopeSlots = canonicalSet(
      recoveryKeyEnvelopes.map((envelope) =>
        indexedMap(envelope.keyEpochId, 1, recoveryCredentialId, revision, envelope.id),
      ),
    );
    const sodium = await readySodium();
    const possessionSignature = Uint8Array.from(
      sodium.crypto_sign_detached(
        transcript("awsm:recovery-replacement-possession:v1", [
          replay.vault.replicaState.vaultId,
          clientSecret.memberId,
          encodeCanonicalValue(canonicalSet(replay.vault.replicaState.authorityFrontier)),
          encodeCanonicalValue(descriptor),
          encodeCanonicalValue(recoveryEnvelopeSlots),
        ]),
        recoveryKeys.signingSecretKey,
      ),
    );
    const replacedRecoveryCredentialIds = effectiveRecovery.map(
      ({ recoveryCredentialId }) => recoveryCredentialId,
    );
    const event = await signVaultEvent(
      {
        vaultId: replay.vault.replicaState.vaultId,
        generationId: replay.vault.replicaState.generationId,
        parentRecordIds: replay.vault.replicaState.causalFrontier,
        authorityParentRecordIds: replay.vault.replicaState.authorityFrontier,
        dependencies: recoveryKeyEnvelopes.map(({ id }) => ({
          type: DEPENDENCY_TYPES.KeyEnvelope,
          id,
        })),
        requiredFeatureSetId: replay.vault.replicaState.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 11,
        signerCredentialId: clientSecret.clientCredentialId,
        assertedAt: input.assertedAt,
        body: indexedMap(
          clientSecret.memberId,
          canonicalSet(replacedRecoveryCredentialIds),
          descriptor,
          recoveryEnvelopeSlots,
          possessionSignature,
        ),
      },
      clientSecret.signingSecretKey,
    );
    const currentEpoch = orderedEpochSecrets.find(({ keyEpochId }) =>
      bytesEqual(keyEpochId, replay.vault.replicaState.currentKeyEpochId),
    );
    if (currentEpoch === undefined) {
      throw new TypeError("Recovery Replacement lacks the accepted current Key Epoch");
    }
    const eventEnvelope = await sealCompactItem({
      vaultId: replay.vault.replicaState.vaultId,
      keyEpochId: currentEpoch.keyEpochId,
      keyEpochKey: currentEpoch.key,
      payloadType: 1,
      payloadBytes: event.bytes,
      ...(deterministic.eventProtectionParameters === undefined
        ? {}
        : { protectionParameters: deterministic.eventProtectionParameters }),
    });
    const nextReplicaState: CanonicalReplicaState = {
      ...replay.vault.replicaState,
      causalFrontier: [event.recordId],
      authorityFrontier: [event.recordId],
      continuityRecordIds: canonicalSet([
        ...replay.vault.replicaState.continuityRecordIds,
        event.recordId,
      ]),
    };
    succeeded = true;
    return {
      recoveryPhrase,
      recoveryCredential,
      replacedRecoveryCredentialIds,
      recoveryKeyEnvelopes,
      event,
      eventEnvelope,
      nextReplicaState,
    };
  } finally {
    await Promise.all([
      wipe(entropy),
      ...(recoveryKeys === undefined ? [] : [wipeRecoveryKeys(recoveryKeys)]),
    ]);
    if (!succeeded) {
      await Promise.all(
        recoveryKeyEnvelopes.flatMap((envelope) => [
          wipe(envelope.keyEpochKey),
          wipe(envelope.bytes),
        ]),
      );
    }
  }
}
