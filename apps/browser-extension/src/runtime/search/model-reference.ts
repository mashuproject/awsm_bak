import { encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";

const SEARCH_MODEL_REFERENCE_CONTEXT = "search-model-reference:v1";

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createSearchModelReferenceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
}

export async function deriveSearchModelVaultReference(
  key: CryptoKey,
  vaultId: string,
): Promise<string> {
  if (
    key.extractable ||
    key.algorithm.name !== "HMAC" ||
    (key.algorithm as HmacKeyAlgorithm).hash.name !== "SHA-256" ||
    !key.usages.includes("sign")
  )
    throw new DomainValidationError(
      "searchModelReference.key",
      "must be a non-exportable HMAC-SHA-256 signing key",
    );
  if (vaultId.length === 0)
    throw new DomainValidationError("searchModelReference.vaultId", "must not be empty");
  return hex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        Uint8Array.from(encodeCanonicalCbor([SEARCH_MODEL_REFERENCE_CONTEXT, vaultId])),
      ),
    ),
  );
}
