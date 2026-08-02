import { sha256 } from "@noble/hashes/sha2.js";

import {
  type ClientCredentialKeys,
  createClientCredentialKeys,
  decodeRecoveryPhrase,
  deriveRecoveryCredential,
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
import type {
  CanonicalReplicaState,
  ClientSecretState,
  EpochSecretState,
} from "./canonical-local-state";

export interface CanonicalRecoveryKeyEnvelopeRequirement {
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly displayNumber: number;
  readonly keyEnvelopeId: Identifier<"KeyEnvelope">;
  readonly recoveryCredentialId: Identifier<"RecoveryCredential">;
  readonly recoveryCredentialRevision: number;
}

export interface CanonicalMemberRecoveryDeterminism {
  readonly clientCredentialId?: Identifier<"ClientCredential">;
  readonly clientSigningSeed?: Uint8Array;
  readonly clientWrappingPrivateKey?: Uint8Array;
  readonly clientEnvelopePaddings?: readonly Uint8Array[];
  readonly eventProtectionParameters?: Uint8Array;
}

export interface PreparedCanonicalMemberRecoveryEnrollment {
  readonly recoveryCredentialId: Identifier<"RecoveryCredential">;
  readonly event: AuthenticatedVaultEvent;
  readonly eventEnvelope: OpaqueEnvelope;
  readonly clientKeyEnvelopes: readonly SealedKeyEnvelope[];
  readonly recoveredEpochs: readonly EpochSecretState[];
  readonly clientSecret: ClientSecretState;
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

async function wipeClientCredential(keys: ClientCredentialKeys): Promise<void> {
  await Promise.all([
    wipe(keys.signingSeed),
    wipe(keys.signingSecretKey),
    wipe(keys.wrappingPrivateKey),
  ]);
}

export async function wipePreparedCanonicalMemberRecoveryEnrollment(
  prepared: PreparedCanonicalMemberRecoveryEnrollment,
): Promise<void> {
  await Promise.all([
    wipe(prepared.clientSecret.signingSecretKey),
    wipe(prepared.clientSecret.wrappingPrivateKey),
    ...prepared.recoveredEpochs.map(({ key }) => wipe(key)),
    ...prepared.clientKeyEnvelopes.flatMap((envelope) => [
      wipe(envelope.keyEpochKey),
      wipe(envelope.bytes),
    ]),
  ]);
}

export async function prepareCanonicalMemberRecoveryEnrollment(input: {
  readonly replay: ReplayedCanonicalVault;
  readonly recoveryPhrase: string;
  readonly readRecoveryKeyEnvelope: (
    requirement: CanonicalRecoveryKeyEnvelopeRequirement,
  ) => Promise<Uint8Array>;
  readonly assertedAt: number | bigint;
  readonly deterministic?: CanonicalMemberRecoveryDeterminism;
}): Promise<PreparedCanonicalMemberRecoveryEnrollment> {
  const { replay } = input;
  if (replay.vault.replicaState.lifecycle !== 1) {
    throw new TypeError("Closed Vaults cannot enroll a Client Credential");
  }

  const recoveryEntropy = decodeRecoveryPhrase(input.recoveryPhrase);
  let recoveryKeys: Awaited<ReturnType<typeof deriveRecoveryCredential>> | undefined;
  const openedRecoveryEnvelopes: Awaited<ReturnType<typeof openKeyEnvelope>>[] = [];
  const recoveredEpochs: EpochSecretState[] = [];
  const clientKeyEnvelopes: SealedKeyEnvelope[] = [];
  let clientKeys: ClientCredentialKeys | undefined;
  let succeeded = false;

  try {
    const derivedRecoveryKeys = await deriveRecoveryCredential(recoveryEntropy);
    recoveryKeys = derivedRecoveryKeys;
    const matchingCredentials = replay.authority.recoveryCredentials
      .filter(
        (credential) =>
          credential.effective &&
          bytesEqual(credential.signingPublicKey, derivedRecoveryKeys.signingPublicKey) &&
          bytesEqual(credential.wrappingPublicKey, derivedRecoveryKeys.wrappingPublicKey),
      )
      .sort((left, right) => compareBytes(left.recoveryCredentialId, right.recoveryCredentialId));
    if (matchingCredentials.length === 0) {
      throw new TypeError("Recovery Phrase does not match an effective Recovery Credential");
    }
    const memberIds = new Set(matchingCredentials.map(({ memberId }) => byteKey(memberId)));
    if (memberIds.size !== 1) {
      throw new TypeError("Recovery Phrase matches more than one active Member");
    }
    const recoveryCredential = matchingCredentials[0];
    if (recoveryCredential === undefined) {
      throw new TypeError("Recovery Phrase does not match an effective Recovery Credential");
    }

    const epochs = [...replay.authority.keyEpochs].sort(
      (left, right) =>
        left.displayNumber - right.displayNumber || compareBytes(left.keyEpochId, right.keyEpochId),
    );
    if (epochs.length === 0) throw new TypeError("Recovery requires an accepted Key Epoch");
    const matchingSlots = replay.authority.keyEnvelopeSlots.filter(
      (slot) =>
        slot.targetKind === 1 &&
        slot.targetRevision === recoveryCredential.revision &&
        bytesEqual(slot.targetCredentialId, recoveryCredential.recoveryCredentialId),
    );
    if (matchingSlots.length !== epochs.length) {
      throw new TypeError("Recovery Key Envelope slots are not the complete Key Epoch set");
    }

    const requirements = epochs.map((epoch): CanonicalRecoveryKeyEnvelopeRequirement => {
      const slots = matchingSlots.filter((slot) => bytesEqual(slot.keyEpochId, epoch.keyEpochId));
      if (slots.length !== 1) {
        throw new TypeError("Recovery Key Envelope slots are not the complete Key Epoch set");
      }
      const slot = slots[0];
      if (slot === undefined) {
        throw new TypeError("Recovery Key Envelope slot is missing");
      }
      return {
        keyEpochId: epoch.keyEpochId,
        displayNumber: epoch.displayNumber,
        keyEnvelopeId: slot.keyEnvelopeId,
        recoveryCredentialId: recoveryCredential.recoveryCredentialId,
        recoveryCredentialRevision: recoveryCredential.revision,
      };
    });

    for (const requirement of requirements) {
      const opened = await openKeyEnvelope({
        targetKind: 1,
        recipientWrappingPrivateKey: derivedRecoveryKeys.wrappingPrivateKey,
        envelopeBytes: await input.readRecoveryKeyEnvelope(requirement),
      });
      openedRecoveryEnvelopes.push(opened);
      if (
        !bytesEqual(opened.id, requirement.keyEnvelopeId) ||
        !bytesEqual(opened.vaultId, replay.vault.replicaState.vaultId) ||
        !bytesEqual(opened.keyEpochId, requirement.keyEpochId) ||
        !bytesEqual(opened.targetCredentialId, requirement.recoveryCredentialId) ||
        opened.targetRevision !== requirement.recoveryCredentialRevision
      ) {
        throw new TypeError("Recovery Key Envelope does not match its authenticated slot");
      }
      recoveredEpochs.push({
        vaultId: replay.vault.replicaState.vaultId,
        keyEpochId: requirement.keyEpochId,
        displayNumber: requirement.displayNumber,
        key: Uint8Array.from(opened.keyEpochKey),
      });
    }

    const deterministic = input.deterministic ?? {};
    const clientCredentialId =
      deterministic.clientCredentialId ?? randomIdentifier("ClientCredential");
    if (replay.authority.clientCredentials.has(byteKey(clientCredentialId))) {
      throw new TypeError("Recovery Enrollment reuses a Client Credential identity");
    }
    clientKeys = await createClientCredentialKeys({
      ...(deterministic.clientSigningSeed === undefined
        ? {}
        : { signingSeed: deterministic.clientSigningSeed }),
      ...(deterministic.clientWrappingPrivateKey === undefined
        ? {}
        : { wrappingPrivateKey: deterministic.clientWrappingPrivateKey }),
    });
    const clientSecret: ClientSecretState = {
      vaultId: replay.vault.replicaState.vaultId,
      memberId: recoveryCredential.memberId,
      clientCredentialId,
      signingPublicKey: clientKeys.signingPublicKey,
      signingSecretKey: clientKeys.signingSecretKey,
      wrappingPublicKey: clientKeys.wrappingPublicKey,
      wrappingPrivateKey: clientKeys.wrappingPrivateKey,
    };

    for (const [index, epoch] of recoveredEpochs.entries()) {
      const envelope = await sealKeyEnvelope({
        vaultId: replay.vault.replicaState.vaultId,
        keyEpochId: epoch.keyEpochId,
        keyEpochKey: epoch.key,
        targetKind: 2,
        targetCredentialId: clientCredentialId,
        targetRevision: null,
        recipientWrappingPublicKey: clientKeys.wrappingPublicKey,
        ...(deterministic.clientEnvelopePaddings?.[index] === undefined
          ? {}
          : { outerPadding: deterministic.clientEnvelopePaddings[index] }),
      });
      const challenge = await openKeyEnvelope({
        targetKind: 2,
        recipientWrappingPrivateKey: clientKeys.wrappingPrivateKey,
        envelopeBytes: envelope.envelope.bytes,
      });
      try {
        if (
          !bytesEqual(challenge.id, envelope.id) ||
          !bytesEqual(challenge.vaultId, replay.vault.replicaState.vaultId) ||
          !bytesEqual(challenge.keyEpochId, epoch.keyEpochId) ||
          !bytesEqual(challenge.keyEpochKey, epoch.key) ||
          !bytesEqual(challenge.targetCredentialId, clientCredentialId)
        ) {
          throw new TypeError("Proposed Client wrapping-key challenge failed");
        }
      } finally {
        await Promise.all([wipe(challenge.keyEpochKey), wipe(challenge.bytes)]);
      }
      clientKeyEnvelopes.push(envelope);
    }

    const clientCertificate = indexedMap(
      clientCredentialId,
      recoveryCredential.memberId,
      clientKeys.signingPublicKey,
      clientKeys.wrappingPublicKey,
    );
    const envelopeSlots = canonicalSet(
      clientKeyEnvelopes.map((envelope) =>
        indexedMap(envelope.keyEpochId, 2, clientCredentialId, null, envelope.id),
      ),
    );
    const proposalPrefix = indexedMap(
      replay.vault.replicaState.vaultId,
      recoveryCredential.memberId,
      canonicalSet(replay.vault.replicaState.authorityFrontier),
      clientCertificate,
      envelopeSlots,
    );
    const sodium = await readySodium();
    const proposal = indexedMap(
      ...proposalPrefix.values(),
      Uint8Array.from(
        sodium.crypto_sign_detached(
          transcript("awsm:client-enrollment-proposal:v1", [encodeCanonicalValue(proposalPrefix)]),
          clientKeys.signingSecretKey,
        ),
      ),
    );
    const proposalId = sha256(
      transcript("awsm:client-enrollment-proposal-id:v1", [encodeCanonicalValue(proposal)]),
    );
    const recoveryAuthorization = Uint8Array.from(
      sodium.crypto_sign_detached(
        transcript("awsm:recovery-client-enrollment-authorization:v1", [proposalId]),
        derivedRecoveryKeys.signingSecretKey,
      ),
    );
    const event = await signVaultEvent(
      {
        vaultId: replay.vault.replicaState.vaultId,
        generationId: replay.vault.replicaState.generationId,
        parentRecordIds: replay.vault.replicaState.causalFrontier,
        authorityParentRecordIds: replay.vault.replicaState.authorityFrontier,
        dependencies: clientKeyEnvelopes.map(({ id }) => ({
          type: DEPENDENCY_TYPES.KeyEnvelope,
          id,
        })),
        requiredFeatureSetId: replay.vault.replicaState.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 9,
        signerCredentialId: clientCredentialId,
        assertedAt: input.assertedAt,
        body: indexedMap(
          proposal,
          2,
          recoveryCredential.recoveryCredentialId,
          recoveryAuthorization,
        ),
      },
      clientKeys.signingSecretKey,
    );
    const currentEpoch = recoveredEpochs.find(({ keyEpochId }) =>
      bytesEqual(keyEpochId, replay.vault.replicaState.currentKeyEpochId),
    );
    if (currentEpoch === undefined) {
      throw new TypeError("Recovery did not open the accepted current Key Epoch");
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
      authoringClientCredentialId: clientCredentialId,
      memberId: recoveryCredential.memberId,
    };
    succeeded = true;
    return {
      recoveryCredentialId: recoveryCredential.recoveryCredentialId,
      event,
      eventEnvelope,
      clientKeyEnvelopes,
      recoveredEpochs,
      clientSecret,
      nextReplicaState,
    };
  } finally {
    await Promise.all([
      wipe(recoveryEntropy),
      ...(recoveryKeys === undefined
        ? []
        : [
            wipe(recoveryKeys.signingSeed),
            wipe(recoveryKeys.signingSecretKey),
            wipe(recoveryKeys.wrappingPrivateKey),
          ]),
      ...openedRecoveryEnvelopes.flatMap((opened) => [
        wipe(opened.keyEpochKey),
        wipe(opened.bytes),
      ]),
      ...(clientKeys === undefined ? [] : [wipe(clientKeys.signingSeed)]),
    ]);
    if (!succeeded) {
      await Promise.all([
        ...recoveredEpochs.map(({ key }) => wipe(key)),
        ...clientKeyEnvelopes.flatMap((envelope) => [
          wipe(envelope.keyEpochKey),
          wipe(envelope.bytes),
        ]),
        ...(clientKeys === undefined ? [] : [wipeClientCredential(clientKeys)]),
      ]);
    }
  }
}
