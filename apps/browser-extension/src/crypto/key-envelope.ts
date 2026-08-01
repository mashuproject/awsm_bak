import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";

import {
  keyEpochId as deriveKeyEpochId,
  type Identifier,
  identifier,
  keyEnvelopeId,
} from "../domain/canonical/identifiers";
import {
  byteString,
  exactCode,
  exactMap,
  identifierValue,
  mapValue,
  nonnegativeInteger,
  nullable,
  oneOfCodes,
} from "../domain/canonical/schema";
import { concatBytes, transcript } from "../domain/canonical/transcript";
import {
  canonicalMap,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../domain/canonical/value";
import { bytesEqual } from "../domain/hash";
import {
  COMPACT_STORAGE_CLASS,
  decodeOpaqueEnvelope,
  encodeOpaqueEnvelope,
  type OpaqueEnvelope,
} from "../storage/opaque-envelope";
import { CryptoOperationError } from "./errors";

export const KEY_ENVELOPE_FORMAT = 1 as const;
export type KeyEnvelopeTargetKind = 1 | 2;

export interface KeyEnvelopePlaintext {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEpochKey: Uint8Array;
  readonly targetKind: KeyEnvelopeTargetKind;
  readonly targetCredentialId: Identifier<"RecoveryCredential" | "ClientCredential">;
  readonly targetRevision: number | null;
  readonly bytes: Uint8Array;
  readonly id: Identifier<"KeyEnvelope">;
}

export interface SealedKeyEnvelope extends KeyEnvelopePlaintext {
  readonly envelope: OpaqueEnvelope;
}

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});

function hpkeInfo(targetKind: KeyEnvelopeTargetKind, padding: Uint8Array): Uint8Array {
  return transcript(
    targetKind === 1 ? "awsm:recovery-key-envelope-hpke:v1" : "awsm:client-key-envelope-hpke:v1",
    [padding],
  );
}

function validateTarget(targetKind: KeyEnvelopeTargetKind, targetRevision: number | null): void {
  if ((targetKind === 1) !== (targetRevision !== null)) {
    throw new TypeError("Key Envelope revision must exist only for a Recovery Credential");
  }
}

function encodePlaintext(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEpochKey: Uint8Array;
  readonly targetKind: KeyEnvelopeTargetKind;
  readonly targetCredentialId: Identifier<"RecoveryCredential" | "ClientCredential">;
  readonly targetRevision: number | null;
}): Uint8Array {
  validateTarget(input.targetKind, input.targetRevision);
  if (!bytesEqual(deriveKeyEpochId(input.vaultId, input.keyEpochKey), input.keyEpochId)) {
    throw new TypeError("Key Envelope Key Epoch ID does not match its key and Vault");
  }
  const expectedKind = input.targetKind === 1 ? "RecoveryCredential" : "ClientCredential";
  identifier(expectedKind, input.targetCredentialId);
  if (
    input.targetRevision !== null &&
    (!Number.isSafeInteger(input.targetRevision) || input.targetRevision < 0)
  ) {
    throw new TypeError("Recovery Credential revision must be nonnegative");
  }
  return encodeCanonicalValue(
    canonicalMap([
      [0, KEY_ENVELOPE_FORMAT],
      [1, input.vaultId],
      [2, input.keyEpochId],
      [3, input.keyEpochKey],
      [4, input.targetKind],
      [5, input.targetCredentialId],
      [6, input.targetRevision],
    ]),
  );
}

function decodePlaintext(bytes: Uint8Array): KeyEnvelopePlaintext {
  const map = exactMap(
    decodeCanonicalValue(bytes),
    [0, 1, 2, 3, 4, 5, 6],
    "Key Envelope plaintext",
  );
  exactCode(mapValue(map, 0), KEY_ENVELOPE_FORMAT, "Key Envelope format");
  const vaultId = identifierValue(mapValue(map, 1), "Vault", "Key Envelope Vault ID");
  const epochId = identifierValue(mapValue(map, 2), "KeyEpoch", "Key Envelope Epoch ID");
  const epochKey = byteString(mapValue(map, 3), 32, "Key Envelope Epoch Key");
  if (!bytesEqual(deriveKeyEpochId(vaultId, epochKey), epochId)) {
    throw new TypeError("Opened Key Envelope has an invalid Key Epoch binding");
  }
  const targetKind = oneOfCodes(mapValue(map, 4), [1, 2] as const, "Key Envelope target kind");
  const targetCredentialId = identifierValue(
    mapValue(map, 5),
    targetKind === 1 ? "RecoveryCredential" : "ClientCredential",
    "Key Envelope target Credential ID",
  );
  const targetRevision = nullable(mapValue(map, 6), (revision) =>
    nonnegativeInteger(revision, "Key Envelope target revision"),
  );
  validateTarget(targetKind, targetRevision);
  const canonicalBytes = Uint8Array.from(bytes);
  return {
    vaultId,
    keyEpochId: epochId,
    keyEpochKey: epochKey,
    targetKind,
    targetCredentialId,
    targetRevision,
    bytes: canonicalBytes,
    id: keyEnvelopeId(canonicalBytes),
  };
}

export async function sealKeyEnvelope(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEpochKey: Uint8Array;
  readonly targetKind: KeyEnvelopeTargetKind;
  readonly targetCredentialId: Identifier<"RecoveryCredential" | "ClientCredential">;
  readonly targetRevision: number | null;
  readonly recipientWrappingPublicKey: Uint8Array;
  readonly outerPadding?: Uint8Array;
}): Promise<SealedKeyEnvelope> {
  const plaintextBytes = encodePlaintext(input);
  const plaintext = decodePlaintext(plaintextBytes);
  const padding = input.outerPadding
    ? byteString(input.outerPadding, 32, "Key Envelope outer padding")
    : crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await suite.kem.deserializePublicKey(
    byteString(input.recipientWrappingPublicKey, 32, "Recipient wrapping public key"),
  );
  let sealed: { readonly enc: ArrayBuffer; readonly ct: ArrayBuffer };
  try {
    sealed = await suite.seal(
      { recipientPublicKey: publicKey, info: hpkeInfo(input.targetKind, padding) },
      plaintextBytes,
      new Uint8Array(),
    );
  } catch {
    throw new CryptoOperationError();
  }
  const encapsulatedKey = new Uint8Array(sealed.enc);
  if (encapsulatedKey.byteLength !== 32) throw new CryptoOperationError();
  const envelope = encodeOpaqueEnvelope({
    storageClass: COMPACT_STORAGE_CLASS,
    protectionParameters: concatBytes([encapsulatedKey, padding]),
    payload: new Uint8Array(sealed.ct),
  });
  return { ...plaintext, envelope };
}

export async function openKeyEnvelope(input: {
  readonly targetKind: KeyEnvelopeTargetKind;
  readonly recipientWrappingPrivateKey: Uint8Array;
  readonly envelopeBytes: Uint8Array;
}): Promise<KeyEnvelopePlaintext & { readonly envelope: OpaqueEnvelope }> {
  const envelope = decodeOpaqueEnvelope(input.envelopeBytes);
  if (envelope.storageClass !== COMPACT_STORAGE_CLASS) {
    throw new TypeError("Key Envelope must use Compact storage");
  }
  const encapsulatedKey = envelope.protectionParameters.slice(0, 32);
  const padding = envelope.protectionParameters.slice(32);
  const privateKey = await suite.kem.deserializePrivateKey(
    byteString(input.recipientWrappingPrivateKey, 32, "Recipient wrapping private key"),
  );
  let plaintextBytes: Uint8Array;
  try {
    plaintextBytes = new Uint8Array(
      await suite.open(
        {
          recipientKey: privateKey,
          enc: encapsulatedKey,
          info: hpkeInfo(input.targetKind, padding),
        },
        envelope.payload,
        new Uint8Array(),
      ),
    );
  } catch {
    throw new CryptoOperationError();
  }
  const plaintext = decodePlaintext(plaintextBytes);
  if (plaintext.targetKind !== input.targetKind) throw new CryptoOperationError();
  return { ...plaintext, envelope };
}
