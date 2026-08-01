import { sha256 } from "@noble/hashes/sha2.js";

import { transcript, uint32be } from "./transcript";

export type IdentifierKind =
  | "Artifact"
  | "BaselineCause"
  | "Bundle"
  | "ClientCredential"
  | "Collection"
  | "FeatureManifest"
  | "Folder"
  | "Generation"
  | "Invitation"
  | "KeyEnvelope"
  | "KeyEpoch"
  | "Member"
  | "Note"
  | "RecoveryCredential"
  | "RequiredFeatureSet"
  | "StorageItem"
  | "Tag"
  | "TagAssignment"
  | "Vault"
  | "VaultObject"
  | "VaultRecord";

const NONZERO_IDENTIFIER_KINDS: ReadonlySet<IdentifierKind> = new Set([
  "BaselineCause",
  "Bundle",
  "ClientCredential",
  "Collection",
  "Folder",
  "Generation",
  "Invitation",
  "Member",
  "Note",
  "RecoveryCredential",
  "Tag",
  "TagAssignment",
  "Vault",
]);

declare const identifierBrand: unique symbol;
export type Identifier<Kind extends IdentifierKind> = Uint8Array & {
  readonly [identifierBrand]: Kind;
};

export function identifierBytes(field: string, bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength !== 32) throw new TypeError(`${field} must contain exactly 32 bytes`);
  return Uint8Array.from(bytes);
}

export function identifier<Kind extends IdentifierKind>(
  kind: Kind,
  bytes: Uint8Array,
): Identifier<Kind> {
  const copy = identifierBytes(`${kind} ID`, bytes);
  if (NONZERO_IDENTIFIER_KINDS.has(kind) && copy.every((byte) => byte === 0)) {
    throw new TypeError(`${kind} ID must not be all zero`);
  }
  return copy as Identifier<Kind>;
}

export function randomIdentifier<Kind extends IdentifierKind>(kind: Kind): Identifier<Kind> {
  return identifier(kind, crypto.getRandomValues(new Uint8Array(32)));
}

export function digestIdentifier<Kind extends IdentifierKind>(
  kind: Kind,
  bytes: Uint8Array,
): Identifier<Kind> {
  return identifier(kind, sha256(bytes));
}

export function vaultRecordId(bytes: Uint8Array): Identifier<"VaultRecord"> {
  return digestIdentifier("VaultRecord", transcript("awsm:vault-record-id:v1", [bytes]));
}

export function vaultObjectId(
  vaultId: Identifier<"Vault">,
  objectType: number,
  bytes: Uint8Array,
): Identifier<"VaultObject"> {
  return digestIdentifier(
    "VaultObject",
    transcript("awsm:vault-object-id:v1", [vaultId, uint32be(objectType), bytes]),
  );
}

export function keyEpochId(vaultId: Identifier<"Vault">, key: Uint8Array): Identifier<"KeyEpoch"> {
  if (key.byteLength !== 32) throw new TypeError("Key Epoch Key must contain exactly 32 bytes");
  const prefix = new TextEncoder().encode("awsm:key-epoch:v1\u0000");
  const input = new Uint8Array(prefix.byteLength + vaultId.byteLength + key.byteLength);
  input.set(prefix, 0);
  input.set(vaultId, prefix.byteLength);
  input.set(key, prefix.byteLength + vaultId.byteLength);
  return digestIdentifier("KeyEpoch", input);
}

export function keyEnvelopeId(bytes: Uint8Array): Identifier<"KeyEnvelope"> {
  return digestIdentifier("KeyEnvelope", transcript("awsm:key-envelope-id:v1", [bytes]));
}
