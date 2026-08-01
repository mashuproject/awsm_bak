import type sodium from "libsodium-wrappers-sumo";

import {
  type ClientCredentialKeys,
  createClientCredentialKeys,
  createKeyEpoch,
  deriveRecoveryCredential,
  encodeRecoveryPhrase,
  type KeyEpoch,
  type RecoveryCredentialKeys,
} from "../../crypto/canonical";
import { openCompactItem, sealCompactItem } from "../../crypto/compact";
import {
  openKeyEnvelope,
  type SealedKeyEnvelope,
  sealKeyEnvelope,
} from "../../crypto/key-envelope";
import { readySodium } from "../../crypto/sodium";
import { DEPENDENCY_TYPES } from "../../domain/canonical/dependencies";
import { advisoryExtensions, EMPTY_REQUIRED_FEATURE_SET_ID } from "../../domain/canonical/features";
import { type Identifier, keyEpochId, randomIdentifier } from "../../domain/canonical/identifiers";
import {
  type AuthenticatedVaultEvent,
  decodeVaultBaseline,
  decodeVaultEvent,
  encodeVaultBaseline,
  signVaultEvent,
  type VaultBaseline,
  verifyVaultEventSignature,
} from "../../domain/canonical/record";
import { transcript } from "../../domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import type { OpaqueEnvelope } from "../../storage/opaque-envelope";

export interface CanonicalVaultCreationIds {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly firstMemberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly recoveryCredentialId: Identifier<"RecoveryCredential">;
  readonly labelCauseId: Identifier<"BaselineCause">;
}

export interface CanonicalVaultCreationSecrets {
  readonly client: ClientCredentialKeys;
  readonly recovery: RecoveryCredentialKeys;
  readonly keyEpoch: KeyEpoch;
}

export interface PreparedCanonicalVaultCreation {
  readonly recoveryPhrase: string;
  readonly ids: CanonicalVaultCreationIds;
  readonly secrets: CanonicalVaultCreationSecrets;
  readonly clientCertificate: ReadonlyMap<number, CanonicalValue>;
  readonly recoveryCredential: ReadonlyMap<number, CanonicalValue>;
  readonly clientKeyEnvelope: SealedKeyEnvelope;
  readonly recoveryKeyEnvelope: SealedKeyEnvelope;
  readonly baseline: VaultBaseline;
  readonly genesis: AuthenticatedVaultEvent;
  readonly baselineEnvelope: OpaqueEnvelope;
  readonly genesisEnvelope: OpaqueEnvelope;
}

export interface CanonicalVaultCreationDeterminism {
  readonly ids?: Partial<CanonicalVaultCreationIds>;
  readonly recoveryEntropy?: Uint8Array;
  readonly clientSigningSeed?: Uint8Array;
  readonly clientWrappingPrivateKey?: Uint8Array;
  readonly keyEpochKey?: Uint8Array;
  readonly recoveryEnvelopePadding?: Uint8Array;
  readonly clientEnvelopePadding?: Uint8Array;
  readonly baselineProtectionParameters?: Uint8Array;
  readonly genesisProtectionParameters?: Uint8Array;
}

function indexedMap(...values: readonly CanonicalValue[]): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

function creationIds(supplied: Partial<CanonicalVaultCreationIds> = {}): CanonicalVaultCreationIds {
  return {
    vaultId: supplied.vaultId ?? randomIdentifier("Vault"),
    generationId: supplied.generationId ?? randomIdentifier("Generation"),
    firstMemberId: supplied.firstMemberId ?? randomIdentifier("Member"),
    clientCredentialId: supplied.clientCredentialId ?? randomIdentifier("ClientCredential"),
    recoveryCredentialId: supplied.recoveryCredentialId ?? randomIdentifier("RecoveryCredential"),
    labelCauseId: supplied.labelCauseId ?? randomIdentifier("BaselineCause"),
  };
}

function epochForCreation(
  vaultId: Identifier<"Vault">,
  suppliedKey: Uint8Array | undefined,
): KeyEpoch {
  if (suppliedKey === undefined) return createKeyEpoch(vaultId);
  const key = Uint8Array.from(suppliedKey);
  if (key.byteLength !== 32) throw new TypeError("Initial Key Epoch Key must contain 32 bytes");
  return { key, id: keyEpochId(vaultId, key) };
}

function clientCertificate(
  ids: CanonicalVaultCreationIds,
  keys: ClientCredentialKeys,
): ReadonlyMap<number, CanonicalValue> {
  return indexedMap(
    ids.clientCredentialId,
    ids.firstMemberId,
    keys.signingPublicKey,
    keys.wrappingPublicKey,
  );
}

function recoveryCredential(
  ids: CanonicalVaultCreationIds,
  keys: RecoveryCredentialKeys,
): ReadonlyMap<number, CanonicalValue> {
  return indexedMap(
    ids.recoveryCredentialId,
    ids.firstMemberId,
    0,
    keys.signingPublicKey,
    keys.wrappingPublicKey,
  );
}

async function possessionSignature(
  library: typeof sodium,
  bytes: Uint8Array,
  secretKey: Uint8Array,
): Promise<Uint8Array> {
  return Uint8Array.from(library.crypto_sign_detached(bytes, secretKey));
}

function assertOpenedEnvelope(
  opened: Awaited<ReturnType<typeof openKeyEnvelope>>,
  expected: SealedKeyEnvelope,
): void {
  if (
    !bytesEqual(opened.id, expected.id) ||
    !bytesEqual(opened.vaultId, expected.vaultId) ||
    !bytesEqual(opened.keyEpochId, expected.keyEpochId) ||
    !bytesEqual(opened.keyEpochKey, expected.keyEpochKey) ||
    !bytesEqual(opened.targetCredentialId, expected.targetCredentialId)
  ) {
    throw new TypeError("Initial Key Envelope challenge did not reproduce its protected binding");
  }
}

export async function prepareCanonicalVaultCreation(input: {
  readonly label: string | null;
  readonly assertedAt: number | bigint;
  readonly deterministic?: CanonicalVaultCreationDeterminism;
}): Promise<PreparedCanonicalVaultCreation> {
  const deterministic = input.deterministic ?? {};
  const ids = creationIds(deterministic.ids);
  const recoveryEntropy = deterministic.recoveryEntropy
    ? Uint8Array.from(deterministic.recoveryEntropy)
    : crypto.getRandomValues(new Uint8Array(16));
  const recoveryPhrase = encodeRecoveryPhrase(recoveryEntropy);
  const recovery = await deriveRecoveryCredential(recoveryEntropy);
  const client = await createClientCredentialKeys({
    ...(deterministic.clientSigningSeed === undefined
      ? {}
      : { signingSeed: deterministic.clientSigningSeed }),
    ...(deterministic.clientWrappingPrivateKey === undefined
      ? {}
      : { wrappingPrivateKey: deterministic.clientWrappingPrivateKey }),
  });
  const keyEpoch = epochForCreation(ids.vaultId, deterministic.keyEpochKey);
  const certificate = clientCertificate(ids, client);
  const recoveryDescriptor = recoveryCredential(ids, recovery);

  const recoveryKeyEnvelope = await sealKeyEnvelope({
    vaultId: ids.vaultId,
    keyEpochId: keyEpoch.id,
    keyEpochKey: keyEpoch.key,
    targetKind: 1,
    targetCredentialId: ids.recoveryCredentialId,
    targetRevision: 0,
    recipientWrappingPublicKey: recovery.wrappingPublicKey,
    ...(deterministic.recoveryEnvelopePadding === undefined
      ? {}
      : { outerPadding: deterministic.recoveryEnvelopePadding }),
  });
  const clientKeyEnvelope = await sealKeyEnvelope({
    vaultId: ids.vaultId,
    keyEpochId: keyEpoch.id,
    keyEpochKey: keyEpoch.key,
    targetKind: 2,
    targetCredentialId: ids.clientCredentialId,
    targetRevision: null,
    recipientWrappingPublicKey: client.wrappingPublicKey,
    ...(deterministic.clientEnvelopePadding === undefined
      ? {}
      : { outerPadding: deterministic.clientEnvelopePadding }),
  });

  assertOpenedEnvelope(
    await openKeyEnvelope({
      targetKind: 1,
      recipientWrappingPrivateKey: recovery.wrappingPrivateKey,
      envelopeBytes: recoveryKeyEnvelope.envelope.bytes,
    }),
    recoveryKeyEnvelope,
  );
  assertOpenedEnvelope(
    await openKeyEnvelope({
      targetKind: 2,
      recipientWrappingPrivateKey: client.wrappingPrivateKey,
      envelopeBytes: clientKeyEnvelope.envelope.bytes,
    }),
    clientKeyEnvelope,
  );

  const recoverySlot = indexedMap(
    keyEpoch.id,
    1,
    ids.recoveryCredentialId,
    0,
    recoveryKeyEnvelope.id,
  );
  const clientSlot = indexedMap(keyEpoch.id, 2, ids.clientCredentialId, null, clientKeyEnvelope.id);
  const labelCauses = input.label === null ? [] : canonicalSet([ids.labelCauseId]);
  const contentCheckpoint = indexedMap(
    1,
    indexedMap(input.label, labelCauses),
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
  );
  const authorityCheckpoint = indexedMap(
    1,
    canonicalSet([ids.firstMemberId]),
    canonicalSet([ids.firstMemberId]),
    canonicalSet([certificate]),
    canonicalSet([recoveryDescriptor]),
    [],
    canonicalSet([indexedMap(keyEpoch.id, 0, true)]),
    canonicalSet([recoverySlot, clientSlot]),
    [],
    [],
  );
  const baseline = encodeVaultBaseline({
    vaultId: ids.vaultId,
    generationId: ids.generationId,
    dependencies: [
      { type: DEPENDENCY_TYPES.KeyEnvelope, id: recoveryKeyEnvelope.id },
      { type: DEPENDENCY_TYPES.KeyEnvelope, id: clientKeyEnvelope.id },
    ],
    requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
    extensions: advisoryExtensions([]),
    body: indexedMap(1, 1, contentCheckpoint, authorityCheckpoint, indexedMap(1), null),
  });

  const proofTranscript = transcript("awsm:genesis-possession-proof:v1", [
    ids.vaultId,
    ids.generationId,
    baseline.recordId,
    ids.firstMemberId,
    encodeCanonicalValue(certificate),
    encodeCanonicalValue(recoveryDescriptor),
    keyEpoch.id,
    EMPTY_REQUIRED_FEATURE_SET_ID,
  ]);
  const library = await readySodium();
  const creationProof = indexedMap(
    await possessionSignature(library, proofTranscript, client.signingSecretKey),
    await possessionSignature(library, proofTranscript, recovery.signingSecretKey),
  );
  const genesis = await signVaultEvent(
    {
      vaultId: ids.vaultId,
      generationId: ids.generationId,
      parentRecordIds: [],
      authorityParentRecordIds: [],
      dependencies: [{ type: DEPENDENCY_TYPES.VaultBaseline, id: baseline.recordId }],
      requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
      extensions: advisoryExtensions([]),
      family: 1,
      type: 1,
      signerCredentialId: ids.clientCredentialId,
      assertedAt: input.assertedAt,
      body: indexedMap(
        baseline.recordId,
        ids.firstMemberId,
        certificate,
        recoveryDescriptor,
        keyEpoch.id,
        EMPTY_REQUIRED_FEATURE_SET_ID,
        creationProof,
      ),
    },
    client.signingSecretKey,
  );

  if (
    !library.crypto_sign_verify_detached(
      creationProof.get(0) as Uint8Array,
      proofTranscript,
      client.signingPublicKey,
    ) ||
    !library.crypto_sign_verify_detached(
      creationProof.get(1) as Uint8Array,
      proofTranscript,
      recovery.signingPublicKey,
    ) ||
    !(await verifyVaultEventSignature(genesis, client.signingPublicKey))
  ) {
    throw new TypeError("Genesis creation signatures failed local verification");
  }

  const baselineEnvelope = await sealCompactItem({
    vaultId: ids.vaultId,
    keyEpochId: keyEpoch.id,
    keyEpochKey: keyEpoch.key,
    payloadType: 1,
    payloadBytes: baseline.bytes,
    ...(deterministic.baselineProtectionParameters === undefined
      ? {}
      : { protectionParameters: deterministic.baselineProtectionParameters }),
  });
  const genesisEnvelope = await sealCompactItem({
    vaultId: ids.vaultId,
    keyEpochId: keyEpoch.id,
    keyEpochKey: keyEpoch.key,
    payloadType: 1,
    payloadBytes: genesis.bytes,
    ...(deterministic.genesisProtectionParameters === undefined
      ? {}
      : { protectionParameters: deterministic.genesisProtectionParameters }),
  });
  const openedBaseline = await openCompactItem({
    vaultId: ids.vaultId,
    keyEpochId: keyEpoch.id,
    keyEpochKey: keyEpoch.key,
    envelopeBytes: baselineEnvelope.bytes,
  });
  const openedGenesis = await openCompactItem({
    vaultId: ids.vaultId,
    keyEpochId: keyEpoch.id,
    keyEpochKey: keyEpoch.key,
    envelopeBytes: genesisEnvelope.bytes,
  });
  if (
    !bytesEqual(decodeVaultBaseline(openedBaseline.payloadBytes).recordId, baseline.recordId) ||
    !bytesEqual(decodeVaultEvent(openedGenesis.payloadBytes).recordId, genesis.recordId)
  ) {
    throw new TypeError("Initial compact Record verification changed a logical identity");
  }

  return {
    recoveryPhrase,
    ids,
    secrets: { client, recovery, keyEpoch },
    clientCertificate: certificate,
    recoveryCredential: recoveryDescriptor,
    clientKeyEnvelope,
    recoveryKeyEnvelope,
    baseline,
    genesis,
    baselineEnvelope,
    genesisEnvelope,
  };
}
