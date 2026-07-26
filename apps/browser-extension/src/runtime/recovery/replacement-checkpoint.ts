import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { bytes, canonicalRecord, literal, string, uuid } from "../../domain/validation";
import { type AuthenticatedSession, decodeAuthenticatedSession } from "../account/http";
import {
  type DeviceCertificateV1,
  type DeviceIdentity,
  type DeviceKeyEnvelopeV1,
  deviceCertificateFromWire,
  deviceCertificateToWire,
  deviceKeyEnvelopeFromWire,
  deviceKeyEnvelopeToWire,
} from "./device";
import { type RecoveryKitV1, recoveryKitFromWire, recoveryKitToWire } from "./kit";
import type { ReplacementIdentifierMapping } from "./replacement-rewrite";

export interface VaultReplacementSensitiveCheckpointV1 {
  readonly version: 1;
  readonly targetVaultId: string;
  readonly recoveryGenerationId: string;
  readonly accountSessionId: string;
  readonly deviceProofSignature: Uint8Array;
  readonly rootKey: Uint8Array;
  readonly identity: DeviceIdentity;
  readonly certificate: DeviceCertificateV1;
  readonly envelope: DeviceKeyEnvelopeV1;
  readonly recoveryKit: RecoveryKitV1;
  readonly identifierMappings: readonly ReplacementIdentifierMapping[];
  readonly session?: AuthenticatedSession;
}

const MAPPING_KINDS: readonly ReplacementIdentifierMapping["kind"][] = [
  "Artifact",
  "Bundle",
  "BundleDescriptor",
  "Collection",
  "Command",
  "Event",
  "Vault",
];

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export function encodeVaultReplacementSensitiveCheckpoint(
  checkpoint: VaultReplacementSensitiveCheckpointV1,
): Uint8Array {
  return encodeCanonicalCbor({
    version: checkpoint.version,
    targetVaultId: checkpoint.targetVaultId,
    recoveryGenerationId: checkpoint.recoveryGenerationId,
    accountSessionId: checkpoint.accountSessionId,
    deviceProofSignature: checkpoint.deviceProofSignature,
    rootKey: checkpoint.rootKey,
    identity: {
      deviceId: checkpoint.identity.deviceId,
      signingPublicKey: checkpoint.identity.signingPublicKey,
      signingSecretKey: checkpoint.identity.signingSecretKey,
      wrappingPublicKey: checkpoint.identity.wrappingPublicKey,
      wrappingSecretKey: checkpoint.identity.wrappingSecretKey,
    },
    certificate: deviceCertificateToWire(checkpoint.certificate),
    envelope: deviceKeyEnvelopeToWire(checkpoint.envelope),
    recoveryKit: recoveryKitToWire(checkpoint.recoveryKit),
    identifierMappings: checkpoint.identifierMappings,
    ...(checkpoint.session === undefined ? {} : { session: checkpoint.session }),
  });
}

export function decodeVaultReplacementSensitiveCheckpoint(
  encoded: Uint8Array,
): VaultReplacementSensitiveCheckpointV1 {
  const decoded = decodeCanonicalCbor(encoded);
  if (!sameBytes(encodeCanonicalCbor(decoded), encoded))
    throw new Error("Replacement checkpoint is not canonical.");
  const input = canonicalRecord(decoded, "vaultReplacementCheckpointPayload", [
    "version",
    "targetVaultId",
    "recoveryGenerationId",
    "accountSessionId",
    "deviceProofSignature",
    "rootKey",
    "identity",
    "certificate",
    "envelope",
    "recoveryKit",
    "identifierMappings",
    "session",
  ]);
  const targetVaultId = uuid(
    input.targetVaultId,
    "vaultReplacementCheckpointPayload.targetVaultId",
  );
  const recoveryGenerationId = uuid(
    input.recoveryGenerationId,
    "vaultReplacementCheckpointPayload.recoveryGenerationId",
  );
  const accountSessionId = uuid(
    input.accountSessionId,
    "vaultReplacementCheckpointPayload.accountSessionId",
  );
  const identityInput = canonicalRecord(
    input.identity,
    "vaultReplacementCheckpointPayload.identity",
    ["deviceId", "signingPublicKey", "signingSecretKey", "wrappingPublicKey", "wrappingSecretKey"],
  );
  const identity: DeviceIdentity = {
    deviceId: uuid(identityInput.deviceId, "vaultReplacementCheckpointPayload.identity.deviceId"),
    signingPublicKey: bytes(
      identityInput.signingPublicKey,
      32,
      "vaultReplacementCheckpointPayload.identity.signingPublicKey",
    ),
    signingSecretKey: bytes(
      identityInput.signingSecretKey,
      64,
      "vaultReplacementCheckpointPayload.identity.signingSecretKey",
    ),
    wrappingPublicKey: bytes(
      identityInput.wrappingPublicKey,
      32,
      "vaultReplacementCheckpointPayload.identity.wrappingPublicKey",
    ),
    wrappingSecretKey: bytes(
      identityInput.wrappingSecretKey,
      32,
      "vaultReplacementCheckpointPayload.identity.wrappingSecretKey",
    ),
  };
  const certificate = deviceCertificateFromWire(input.certificate);
  const envelope = deviceKeyEnvelopeFromWire(input.envelope);
  const recoveryKit = recoveryKitFromWire(input.recoveryKit);
  if (!Array.isArray(input.identifierMappings))
    throw new Error("Replacement checkpoint mappings are invalid.");
  const identifierMappings = input.identifierMappings.map(
    (candidate, index): ReplacementIdentifierMapping => {
      const mapping = canonicalRecord(
        candidate,
        `vaultReplacementCheckpointPayload.identifierMappings[${index}]`,
        ["kind", "sourceId", "targetId"],
      );
      const kind = string(
        mapping.kind,
        `vaultReplacementCheckpointPayload.identifierMappings[${index}].kind`,
      ) as ReplacementIdentifierMapping["kind"];
      if (!MAPPING_KINDS.includes(kind))
        throw new Error("Replacement checkpoint mapping kind is invalid.");
      return {
        kind,
        sourceId: uuid(
          mapping.sourceId,
          `vaultReplacementCheckpointPayload.identifierMappings[${index}].sourceId`,
        ),
        targetId: uuid(
          mapping.targetId,
          `vaultReplacementCheckpointPayload.identifierMappings[${index}].targetId`,
        ),
      };
    },
  );
  const mappingKeys = identifierMappings.map((mapping) => `${mapping.kind}\0${mapping.sourceId}`);
  const session =
    input.session === undefined ? undefined : decodeAuthenticatedSession(input.session);
  if (
    certificate.content.vaultId !== targetVaultId ||
    certificate.content.recoveryGenerationId !== recoveryGenerationId ||
    certificate.content.deviceId !== identity.deviceId ||
    envelope.metadata.vaultId !== targetVaultId ||
    envelope.metadata.recoveryGenerationId !== recoveryGenerationId ||
    envelope.metadata.deviceId !== identity.deviceId ||
    recoveryKit.metadata.vaultId !== targetVaultId ||
    recoveryKit.metadata.recoveryGenerationId !== recoveryGenerationId ||
    !sameBytes(certificate.content.signingPublicKey, identity.signingPublicKey) ||
    !sameBytes(certificate.content.wrappingPublicKey, identity.wrappingPublicKey) ||
    new Set(mappingKeys).size !== mappingKeys.length ||
    (session !== undefined &&
      (session.scope !== "VaultDevice" || session.account.accountId.length === 0))
  )
    throw new Error("Replacement checkpoint authority is inconsistent.");
  return {
    version: literal(input.version, 1, "vaultReplacementCheckpointPayload.version"),
    targetVaultId,
    recoveryGenerationId,
    accountSessionId,
    deviceProofSignature: bytes(
      input.deviceProofSignature,
      64,
      "vaultReplacementCheckpointPayload.deviceProofSignature",
    ),
    rootKey: bytes(input.rootKey, 32, "vaultReplacementCheckpointPayload.rootKey"),
    identity,
    certificate,
    envelope,
    recoveryKit,
    identifierMappings,
    ...(session === undefined ? {} : { session }),
  };
}
