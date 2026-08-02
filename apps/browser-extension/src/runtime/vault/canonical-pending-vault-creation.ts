import type { Identifier } from "../../domain/canonical/identifiers";
import {
  byteString,
  exactCode,
  exactMap,
  identifierValue,
  mapValue,
  nullable,
  signedInteger,
  textValue,
} from "../../domain/canonical/schema";
import {
  type CanonicalValue,
  canonicalMap,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import type { CanonicalVaultCreationIds } from "./canonical-create";

const PENDING_VAULT_CREATION_FORMAT = 1 as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;

export interface CanonicalPendingVaultCreation {
  readonly setupId: string;
  readonly expectedVaultId: Identifier<"Vault"> | null;
  readonly label: string | null;
  readonly assertedAt: number | bigint;
  readonly ids: CanonicalVaultCreationIds;
  readonly clientSigningSeed: Uint8Array;
  readonly clientWrappingPrivateKey: Uint8Array;
  readonly keyEpochKey: Uint8Array;
  readonly recoveryEnvelopeBytes: Uint8Array;
  readonly clientEnvelopeBytes: Uint8Array;
  readonly baselineProtectionParameters: Uint8Array;
  readonly genesisProtectionParameters: Uint8Array;
}

function uuid(value: CanonicalValue, field: string): string {
  const parsed = textValue(value, field, { maxUtf8Bytes: 64 });
  if (!UUID.test(parsed)) throw new TypeError(`${field} must be a lowercase UUID`);
  return parsed;
}

function variableBytes(value: CanonicalValue, field: string): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > MAX_ENVELOPE_BYTES
  ) {
    throw new TypeError(`${field} must be bounded nonempty bytes`);
  }
  return Uint8Array.from(value);
}

function idsValue(ids: CanonicalVaultCreationIds): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap([
    [0, ids.vaultId],
    [1, ids.generationId],
    [2, ids.firstMemberId],
    [3, ids.clientCredentialId],
    [4, ids.recoveryCredentialId],
    [5, ids.labelCauseId],
  ]);
}

function decodeIds(value: CanonicalValue): CanonicalVaultCreationIds {
  const map = exactMap(value, [0, 1, 2, 3, 4, 5], "Pending Vault creation IDs");
  return {
    vaultId: identifierValue(mapValue(map, 0), "Vault", "Pending Vault ID"),
    generationId: identifierValue(mapValue(map, 1), "Generation", "Pending Generation ID"),
    firstMemberId: identifierValue(mapValue(map, 2), "Member", "Pending first Member ID"),
    clientCredentialId: identifierValue(
      mapValue(map, 3),
      "ClientCredential",
      "Pending Client Credential ID",
    ),
    recoveryCredentialId: identifierValue(
      mapValue(map, 4),
      "RecoveryCredential",
      "Pending Recovery Credential ID",
    ),
    labelCauseId: identifierValue(mapValue(map, 5), "BaselineCause", "Pending label Cause ID"),
  };
}

export function encodeCanonicalPendingVaultCreation(
  value: CanonicalPendingVaultCreation,
): Uint8Array {
  if (!UUID.test(value.setupId)) throw new TypeError("Pending Vault creation setup ID is invalid");
  const bytes = encodeCanonicalValue(
    canonicalMap([
      [0, PENDING_VAULT_CREATION_FORMAT],
      [1, value.setupId],
      [2, value.expectedVaultId],
      [3, value.label],
      [4, value.assertedAt],
      [5, idsValue(value.ids)],
      [6, byteString(value.clientSigningSeed, 32, "Pending Client signing seed")],
      [7, byteString(value.clientWrappingPrivateKey, 32, "Pending Client wrapping private key")],
      [8, byteString(value.keyEpochKey, 32, "Pending Key Epoch Key")],
      [9, variableBytes(value.recoveryEnvelopeBytes, "Pending Recovery Envelope")],
      [10, variableBytes(value.clientEnvelopeBytes, "Pending Client Envelope")],
      [
        11,
        byteString(
          value.baselineProtectionParameters,
          64,
          "Pending Baseline protection parameters",
        ),
      ],
      [
        12,
        byteString(value.genesisProtectionParameters, 64, "Pending Genesis protection parameters"),
      ],
    ]),
  );
  decodeCanonicalPendingVaultCreation(bytes);
  return bytes;
}

export function decodeCanonicalPendingVaultCreation(
  bytes: Uint8Array,
): CanonicalPendingVaultCreation {
  const map = exactMap(
    decodeCanonicalValue(bytes),
    [...Array(13).keys()],
    "Pending Vault creation",
  );
  exactCode(mapValue(map, 0), PENDING_VAULT_CREATION_FORMAT, "Pending Vault creation format");
  const value: CanonicalPendingVaultCreation = {
    setupId: uuid(mapValue(map, 1), "Pending Vault creation setup ID"),
    expectedVaultId: nullable(mapValue(map, 2), (id) =>
      identifierValue(id, "Vault", "Pending expected Vault ID"),
    ),
    label: nullable(mapValue(map, 3), (label) =>
      textValue(label, "Pending Vault label", { maxUtf8Bytes: 1_024 }),
    ),
    assertedAt: signedInteger(mapValue(map, 4), "Pending Vault asserted time"),
    ids: decodeIds(mapValue(map, 5)),
    clientSigningSeed: byteString(mapValue(map, 6), 32, "Pending Client signing seed"),
    clientWrappingPrivateKey: byteString(
      mapValue(map, 7),
      32,
      "Pending Client wrapping private key",
    ),
    keyEpochKey: byteString(mapValue(map, 8), 32, "Pending Key Epoch Key"),
    recoveryEnvelopeBytes: variableBytes(mapValue(map, 9), "Pending Recovery Envelope"),
    clientEnvelopeBytes: variableBytes(mapValue(map, 10), "Pending Client Envelope"),
    baselineProtectionParameters: byteString(
      mapValue(map, 11),
      64,
      "Pending Baseline protection parameters",
    ),
    genesisProtectionParameters: byteString(
      mapValue(map, 12),
      64,
      "Pending Genesis protection parameters",
    ),
  };
  const canonical = encodeCanonicalValue(
    canonicalMap([
      [0, PENDING_VAULT_CREATION_FORMAT],
      [1, value.setupId],
      [2, value.expectedVaultId],
      [3, value.label],
      [4, value.assertedAt],
      [5, idsValue(value.ids)],
      [6, value.clientSigningSeed],
      [7, value.clientWrappingPrivateKey],
      [8, value.keyEpochKey],
      [9, value.recoveryEnvelopeBytes],
      [10, value.clientEnvelopeBytes],
      [11, value.baselineProtectionParameters],
      [12, value.genesisProtectionParameters],
    ]),
  );
  if (!bytesEqual(canonical, bytes))
    throw new TypeError("Pending Vault creation bytes are not canonical");
  return value;
}
