import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import { bytes, canonicalRecord, literal, string } from "../../domain/validation";
import type { EmbeddingProviderIdentity } from "./contracts";

const REMOTE_CREDENTIAL_CONTEXT = "search-remote-api-key:v1";

export interface StoredRemoteSearchCredentialV1 {
  readonly version: 1;
  readonly credentialId: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export function decodeStoredRemoteSearchCredential(value: unknown): StoredRemoteSearchCredentialV1 {
  const input = canonicalRecord(value, "remoteSearchCredential", [
    "version",
    "credentialId",
    "nonce",
    "ciphertext",
  ]);
  const credentialId = string(input.credentialId, "remoteSearchCredential.credentialId");
  if (credentialId.length === 0 || credentialId.length > 256)
    throw new DomainValidationError("remoteSearchCredential.credentialId", "is out of range");
  const ciphertext = bytes(input.ciphertext, undefined, "remoteSearchCredential.ciphertext");
  if (ciphertext.byteLength < 16)
    throw new DomainValidationError(
      "remoteSearchCredential.ciphertext",
      "must contain an authentication tag",
    );
  return {
    version: literal(input.version, 1, "remoteSearchCredential.version"),
    credentialId,
    nonce: bytes(input.nonce, 12, "remoteSearchCredential.nonce"),
    ciphertext,
  };
}

function remoteIdentity(identity: EmbeddingProviderIdentity): EmbeddingProviderIdentity & {
  readonly kind: "RemoteOpenAiCompatible";
  readonly endpointOrigin: string;
  readonly endpointPathHash: string;
} {
  if (
    identity.kind !== "RemoteOpenAiCompatible" ||
    identity.endpointOrigin === undefined ||
    identity.endpointPathHash === undefined ||
    identity.modelRevision !== undefined
  )
    throw new DomainValidationError(
      "remoteSearchCredential.provider",
      "must be a remote provider identity",
    );
  return {
    ...identity,
    kind: "RemoteOpenAiCompatible",
    endpointOrigin: identity.endpointOrigin,
    endpointPathHash: identity.endpointPathHash,
  };
}

function aad(
  vaultId: string,
  credentialId: string,
  identity: EmbeddingProviderIdentity,
): Uint8Array {
  const remote = remoteIdentity(identity);
  return encodeCanonicalCbor([
    REMOTE_CREDENTIAL_CONTEXT,
    vaultId,
    credentialId,
    remote.endpointOrigin,
    remote.endpointPathHash,
    remote.model,
    remote.dimensions,
  ]);
}

export function createRemoteSearchCredentialKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealRemoteSearchCredential(input: {
  readonly key: CryptoKey;
  readonly vaultId: string;
  readonly credentialId: string;
  readonly provider: EmbeddingProviderIdentity;
  readonly apiKey: Uint8Array;
}): Promise<StoredRemoteSearchCredentialV1> {
  if (
    input.key.extractable ||
    input.key.algorithm.name !== "AES-GCM" ||
    !input.key.usages.includes("encrypt")
  )
    throw new DomainValidationError(
      "remoteSearchCredential.key",
      "must be a non-exportable AES-GCM encryption key",
    );
  if (input.apiKey.byteLength === 0 || input.apiKey.byteLength > 8_192)
    throw new DomainValidationError("remoteSearchCredential.apiKey", "is out of range");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  return {
    version: 1,
    credentialId: input.credentialId,
    nonce,
    ciphertext: new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: Uint8Array.from(aad(input.vaultId, input.credentialId, input.provider)),
          tagLength: 128,
        },
        input.key,
        Uint8Array.from(encodeCanonicalCbor(input.apiKey)),
      ),
    ),
  };
}

export async function openRemoteSearchCredential(input: {
  readonly key: CryptoKey;
  readonly vaultId: string;
  readonly credentialId: string;
  readonly provider: EmbeddingProviderIdentity;
  readonly stored: StoredRemoteSearchCredentialV1;
}): Promise<Uint8Array> {
  if (
    input.key.extractable ||
    input.key.algorithm.name !== "AES-GCM" ||
    !input.key.usages.includes("decrypt")
  )
    throw new DomainValidationError(
      "remoteSearchCredential.key",
      "must be a non-exportable AES-GCM decryption key",
    );
  if (
    input.stored.version !== 1 ||
    input.stored.credentialId !== input.credentialId ||
    input.stored.nonce.byteLength !== 12 ||
    input.stored.ciphertext.byteLength < 16
  )
    throw new DomainValidationError("remoteSearchCredential", "is invalid");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(input.stored.nonce),
        additionalData: Uint8Array.from(aad(input.vaultId, input.credentialId, input.provider)),
        tagLength: 128,
      },
      input.key,
      Uint8Array.from(input.stored.ciphertext),
    );
  } catch {
    throw new DomainValidationError("remoteSearchCredential", "failed authentication");
  }
  const decoded: unknown = decodeCanonicalCbor(new Uint8Array(plaintext));
  if (!(decoded instanceof Uint8Array) || decoded.byteLength === 0 || decoded.byteLength > 8_192)
    throw new DomainValidationError("remoteSearchCredential.apiKey", "is invalid");
  return decoded;
}
