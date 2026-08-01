import { readySodium } from "../../crypto/sodium";
import { DEPENDENCY_TYPES, dependencySet } from "../../domain/canonical/dependencies";
import type { AuthenticatedVaultEvent, VaultBaseline } from "../../domain/canonical/record";
import { verifyVaultEventSignature } from "../../domain/canonical/record";
import {
  byteString,
  exactCode,
  exactMap,
  identifierValue,
  mapValue,
  nullable,
  oneOfCodes,
  textValue,
} from "../../domain/canonical/schema";
import { transcript } from "../../domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import type {
  CanonicalReplicaState,
  ClientSecretState,
  EpochSecretState,
} from "./canonical-local-state";

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function sameCanonical(left: CanonicalValue, right: CanonicalValue, field: string): void {
  if (!bytesEqual(encodeCanonicalValue(left), encodeCanonicalValue(right))) {
    throw new TypeError(`${field} does not match`);
  }
}

export function initialBaselineVaultLabel(baseline: VaultBaseline): string | null {
  const body = exactMap(baseline.body, [0, 1, 2, 3, 4, 5], "Initial Baseline body");
  const content = exactMap(mapValue(body, 2), [...Array(10).keys()], "Initial content checkpoint");
  const label = exactMap(mapValue(content, 1), [0, 1], "Initial Vault label");
  return nullable(mapValue(label, 0), (value) =>
    textValue(value, "Initial Vault label", { maxUtf8Bytes: 1024 }),
  );
}

export async function validateInitialVaultAuthority(input: {
  readonly baseline: VaultBaseline;
  readonly genesis: AuthenticatedVaultEvent;
  readonly replicaState: CanonicalReplicaState;
  readonly clientSecret: ClientSecretState;
  readonly epochSecret: EpochSecretState;
  readonly requireInitialReplicaState?: boolean;
}): Promise<void> {
  const { baseline, genesis, replicaState, clientSecret, epochSecret } = input;
  if (genesis.family !== 1 || genesis.type !== 1) {
    throw new TypeError("Initial authority root is not Genesis");
  }
  if (genesis.parentRecordIds.length !== 0 || genesis.authorityParentRecordIds.length !== 0) {
    throw new TypeError("Genesis must be parentless");
  }
  for (const [field, left, right] of [
    ["Baseline Vault ID", baseline.vaultId, replicaState.vaultId],
    ["Genesis Vault ID", genesis.vaultId, replicaState.vaultId],
    ["Baseline Generation ID", baseline.generationId, replicaState.generationId],
    ["Genesis Generation ID", genesis.generationId, replicaState.generationId],
    ["Active Baseline ID", baseline.recordId, replicaState.baselineId],
    ["Client Secret Vault ID", clientSecret.vaultId, replicaState.vaultId],
    ["Epoch Secret Vault ID", epochSecret.vaultId, replicaState.vaultId],
    ["Current Key Epoch ID", epochSecret.keyEpochId, replicaState.currentKeyEpochId],
  ] as const) {
    same(left, right, field);
  }
  if (input.requireInitialReplicaState ?? true) {
    if (
      replicaState.causalFrontier.length !== 1 ||
      replicaState.authorityFrontier.length !== 1 ||
      replicaState.continuityRecordIds.length !== 1
    ) {
      throw new TypeError("Initial Replica State must recognize exactly Genesis");
    }
    same(replicaState.causalFrontier[0] ?? new Uint8Array(), genesis.recordId, "Causal Frontier");
    same(
      replicaState.authorityFrontier[0] ?? new Uint8Array(),
      genesis.recordId,
      "Authority Frontier",
    );
  }
  if (
    !replicaState.continuityRecordIds.some((recordId) => bytesEqual(recordId, genesis.recordId))
  ) {
    throw new TypeError("The Continuity Proof does not retain Genesis");
  }
  same(genesis.requiredFeatureSetId, baseline.requiredFeatureSetId, "Genesis Required Feature Set");
  same(
    genesis.requiredFeatureSetId,
    replicaState.requiredFeatureSetId,
    "Replica Required Feature Set",
  );

  const genesisBody = exactMap(genesis.body, [0, 1, 2, 3, 4, 5, 6], "Genesis body");
  same(
    identifierValue(mapValue(genesisBody, 0), "VaultRecord", "Genesis Baseline ID"),
    baseline.recordId,
    "Genesis Baseline ID",
  );
  const firstMemberId = identifierValue(
    mapValue(genesisBody, 1),
    "Member",
    "Genesis first Member ID",
  );
  const clientCertificate = exactMap(
    mapValue(genesisBody, 2),
    [0, 1, 2, 3],
    "Genesis Client Certificate",
  );
  const recoveryCredential = exactMap(
    mapValue(genesisBody, 3),
    [0, 1, 2, 3, 4],
    "Genesis Recovery Credential",
  );
  const clientCredentialId = identifierValue(
    mapValue(clientCertificate, 0),
    "ClientCredential",
    "Genesis Client Credential ID",
  );
  same(clientCredentialId, genesis.signerCredentialId, "Genesis signer Credential");
  same(clientCredentialId, clientSecret.clientCredentialId, "Stored Client Credential");
  same(clientCredentialId, replicaState.authoringClientCredentialId, "Authoring Credential");
  same(firstMemberId, clientSecret.memberId, "Stored Client member");
  same(firstMemberId, replicaState.memberId, "Replica member");
  same(
    identifierValue(mapValue(clientCertificate, 1), "Member", "Certificate Member ID"),
    firstMemberId,
    "Certificate Member ID",
  );
  same(
    identifierValue(mapValue(recoveryCredential, 1), "Member", "Recovery Member ID"),
    firstMemberId,
    "Recovery Member ID",
  );
  exactCode(mapValue(recoveryCredential, 2), 0, "Initial Recovery Credential revision");
  same(
    byteString(mapValue(clientCertificate, 2), 32, "Client signing public key"),
    clientSecret.signingPublicKey,
    "Client signing public key",
  );
  same(
    byteString(mapValue(clientCertificate, 3), 32, "Client wrapping public key"),
    clientSecret.wrappingPublicKey,
    "Client wrapping public key",
  );
  const recoverySigningPublicKey = byteString(
    mapValue(recoveryCredential, 3),
    32,
    "Recovery signing public key",
  );
  const recoveryCredentialId = identifierValue(
    mapValue(recoveryCredential, 0),
    "RecoveryCredential",
    "Genesis Recovery Credential ID",
  );
  const initialEpochId = identifierValue(
    mapValue(genesisBody, 4),
    "KeyEpoch",
    "Genesis Key Epoch ID",
  );
  same(initialEpochId, epochSecret.keyEpochId, "Genesis Key Epoch ID");
  same(
    identifierValue(mapValue(genesisBody, 5), "RequiredFeatureSet", "Genesis Feature Set ID"),
    genesis.requiredFeatureSetId,
    "Genesis Feature Set ID",
  );

  const proof = exactMap(mapValue(genesisBody, 6), [0, 1], "Genesis creation proof");
  const proofTranscript = transcript("awsm:genesis-possession-proof:v1", [
    genesis.vaultId,
    genesis.generationId,
    baseline.recordId,
    firstMemberId,
    encodeCanonicalValue(clientCertificate),
    encodeCanonicalValue(recoveryCredential),
    initialEpochId,
    genesis.requiredFeatureSetId,
  ]);
  const sodium = await readySodium();
  if (
    !sodium.crypto_sign_verify_detached(
      byteString(mapValue(proof, 0), 64, "Genesis Client proof"),
      proofTranscript,
      clientSecret.signingPublicKey,
    ) ||
    !sodium.crypto_sign_verify_detached(
      byteString(mapValue(proof, 1), 64, "Genesis Recovery proof"),
      proofTranscript,
      recoverySigningPublicKey,
    ) ||
    !(await verifyVaultEventSignature(genesis, clientSecret.signingPublicKey))
  ) {
    throw new TypeError("Genesis signatures are invalid");
  }

  const baselineBody = exactMap(baseline.body, [0, 1, 2, 3, 4, 5], "Initial Baseline body");
  exactCode(mapValue(baselineBody, 0), 1, "Baseline body format");
  exactCode(mapValue(baselineBody, 1), 1, "Initial Baseline kind");
  const authority = exactMap(
    mapValue(baselineBody, 3),
    [...Array(10).keys()],
    "Initial authority checkpoint",
  );
  sameCanonical(mapValue(authority, 1), canonicalSet([firstMemberId]), "Initial members");
  sameCanonical(mapValue(authority, 2), canonicalSet([firstMemberId]), "Initial Administrators");
  sameCanonical(
    mapValue(authority, 3),
    canonicalSet([clientCertificate]),
    "Initial Client Certificates",
  );
  sameCanonical(
    mapValue(authority, 4),
    canonicalSet([recoveryCredential]),
    "Initial Recovery Credentials",
  );
  const epochs = mapValue(authority, 6);
  sameCanonical(epochs, canonicalSet([canonicalMapForEpoch(initialEpochId)]), "Initial Key Epoch");
  const slotValues = mapValue(authority, 7);
  if (!Array.isArray(slotValues) || slotValues.length !== 2) {
    throw new TypeError("Initial authority must contain exactly two Key Envelope slots");
  }
  const envelopeIds: Uint8Array[] = [];
  let sawClient = false;
  let sawRecovery = false;
  for (const [index, slotValue] of slotValues.entries()) {
    const slot = exactMap(slotValue, [0, 1, 2, 3, 4], `Initial Key Envelope slot ${index}`);
    same(
      identifierValue(mapValue(slot, 0), "KeyEpoch", "Slot Key Epoch ID"),
      initialEpochId,
      "Slot Key Epoch ID",
    );
    const targetKind = oneOfCodes(mapValue(slot, 1), [1, 2] as const, "Slot target kind");
    const targetRevision = nullable(mapValue(slot, 3), (value) =>
      exactCode(value, 0, "Initial Recovery revision"),
    );
    if (targetKind === 1) {
      if (sawRecovery || targetRevision !== 0) {
        throw new TypeError("Initial Recovery Key Envelope slot is duplicated or malformed");
      }
      same(
        identifierValue(mapValue(slot, 2), "RecoveryCredential", "Slot Recovery Credential ID"),
        recoveryCredentialId,
        "Slot Recovery Credential ID",
      );
      sawRecovery = true;
    } else {
      if (sawClient || targetRevision !== null) {
        throw new TypeError("Initial Client Key Envelope slot is duplicated or malformed");
      }
      same(
        identifierValue(mapValue(slot, 2), "ClientCredential", "Slot Client Credential ID"),
        clientCredentialId,
        "Slot Client Credential ID",
      );
      sawClient = true;
    }
    envelopeIds.push(identifierValue(mapValue(slot, 4), "KeyEnvelope", "Slot Key Envelope ID"));
  }
  if (!sawClient || !sawRecovery) {
    throw new TypeError("Initial authority is missing a required Key Envelope slot");
  }
  sameCanonical(
    dependencySet(baseline.dependencies),
    dependencySet(envelopeIds.map((id) => ({ type: DEPENDENCY_TYPES.KeyEnvelope, id }))),
    "Initial Baseline dependency closure",
  );
}

function canonicalMapForEpoch(keyEpochId: Uint8Array): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap([
    [0, keyEpochId],
    [1, 0],
    [2, true],
  ]);
}
