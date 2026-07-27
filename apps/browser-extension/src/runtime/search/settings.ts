import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import { bytesEqual, sha256 } from "../../domain/hash";
import { canonicalRecord, integer, literal, string } from "../../domain/validation";
import type { EmbeddingProviderIdentity } from "./contracts";
import { normalizeRemoteSearchEndpoint, remoteSearchEndpointPathHash } from "./remote-endpoint";
import { providerIdentityHash } from "./semantic";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type SearchSettings =
  | { readonly version: 1; readonly semantic: "Disabled" }
  | {
      readonly version: 1;
      readonly semantic: "Local";
      readonly provider: EmbeddingProviderIdentity;
      readonly disclosureVersion: 1;
    }
  | {
      readonly version: 1;
      readonly semantic: "Remote";
      readonly provider: EmbeddingProviderIdentity;
      readonly endpoint: string;
      readonly protectedCredentialId: string;
      readonly disclosureVersion: 1;
    };

function identity(value: unknown): EmbeddingProviderIdentity {
  const input = canonicalRecord(value, "searchSettings.provider", [
    "version",
    "kind",
    "endpointOrigin",
    "endpointPathHash",
    "model",
    "modelRevision",
    "dimensions",
    "pooling",
    "normalized",
  ]);
  if (input.kind !== "LocalMiniLm" && input.kind !== "RemoteOpenAiCompatible")
    throw new DomainValidationError("searchSettings.provider.kind", "is unsupported");
  const dimensions = integer(input.dimensions, "searchSettings.provider.dimensions");
  if (dimensions < 1 || dimensions > 4_096)
    throw new DomainValidationError("searchSettings.provider.dimensions", "is out of range");
  if (input.pooling !== "Mean" || input.normalized !== true)
    throw new DomainValidationError("searchSettings.provider", "uses unsupported vector semantics");
  const model = string(input.model, "searchSettings.provider.model");
  if (model.length === 0 || model.length > 512)
    throw new DomainValidationError("searchSettings.provider.model", "is out of range");
  if (input.kind === "LocalMiniLm") {
    if (
      input.endpointOrigin !== undefined ||
      input.endpointPathHash !== undefined ||
      typeof input.modelRevision !== "string" ||
      input.modelRevision.length === 0
    )
      throw new DomainValidationError(
        "searchSettings.provider",
        "has inconsistent local identity fields",
      );
    return {
      version: literal(input.version, 1, "searchSettings.provider.version"),
      kind: "LocalMiniLm",
      model,
      modelRevision: input.modelRevision,
      dimensions,
      pooling: "Mean",
      normalized: true,
    };
  }
  if (
    typeof input.endpointOrigin !== "string" ||
    new URL(input.endpointOrigin).origin !== input.endpointOrigin ||
    typeof input.endpointPathHash !== "string" ||
    !SHA256_PATTERN.test(input.endpointPathHash) ||
    input.modelRevision !== undefined
  )
    throw new DomainValidationError(
      "searchSettings.provider",
      "has inconsistent remote identity fields",
    );
  return {
    version: literal(input.version, 1, "searchSettings.provider.version"),
    kind: "RemoteOpenAiCompatible",
    endpointOrigin: input.endpointOrigin,
    endpointPathHash: input.endpointPathHash,
    model,
    dimensions,
    pooling: "Mean",
    normalized: true,
  };
}

function validate(value: unknown): SearchSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new DomainValidationError("searchSettings", "must be an object");
  const semantic = Reflect.get(value, "semantic");
  if (semantic === "Disabled") {
    const input = canonicalRecord(value, "searchSettings", ["version", "semantic"]);
    return {
      version: literal(input.version, 1, "searchSettings.version"),
      semantic: "Disabled",
    };
  }
  const keys =
    semantic === "Local"
      ? ["version", "semantic", "provider", "disclosureVersion"]
      : [
          "version",
          "semantic",
          "provider",
          "endpoint",
          "protectedCredentialId",
          "disclosureVersion",
        ];
  const input = canonicalRecord(value, "searchSettings", keys);
  const provider = identity(input.provider);
  const disclosureVersion = literal(input.disclosureVersion, 1, "searchSettings.disclosureVersion");
  if (semantic === "Local") {
    if (provider.kind !== "LocalMiniLm")
      throw new DomainValidationError("searchSettings.provider", "must be the local provider");
    return {
      version: literal(input.version, 1, "searchSettings.version"),
      semantic: "Local",
      provider,
      disclosureVersion,
    };
  }
  if (semantic !== "Remote" || provider.kind !== "RemoteOpenAiCompatible")
    throw new DomainValidationError("searchSettings.semantic", "is unsupported");
  const endpoint = string(input.endpoint, "searchSettings.endpoint");
  let normalizedEndpoint: string;
  try {
    normalizedEndpoint = normalizeRemoteSearchEndpoint(endpoint);
  } catch {
    throw new DomainValidationError("searchSettings.endpoint", "is not permitted");
  }
  const url = new URL(normalizedEndpoint);
  if (
    normalizedEndpoint !== endpoint ||
    url.origin !== provider.endpointOrigin ||
    remoteSearchEndpointPathHash(endpoint) !== provider.endpointPathHash
  )
    throw new DomainValidationError(
      "searchSettings.endpoint",
      "does not match the remote provider identity",
    );
  const protectedCredentialId = string(
    input.protectedCredentialId,
    "searchSettings.protectedCredentialId",
  );
  if (protectedCredentialId.length === 0 || protectedCredentialId.length > 256)
    throw new DomainValidationError("searchSettings.protectedCredentialId", "is out of range");
  return {
    version: literal(input.version, 1, "searchSettings.version"),
    semantic: "Remote",
    provider,
    endpoint,
    protectedCredentialId,
    disclosureVersion,
  };
}

export function encodeSearchSettings(value: SearchSettings): Uint8Array {
  return encodeCanonicalCbor(validate(value));
}

export function decodeSearchSettings(encoded: Uint8Array): SearchSettings {
  let decoded: unknown;
  try {
    decoded = decodeCanonicalCbor(encoded);
  } catch {
    throw new DomainValidationError("searchSettings", "is not valid CBOR");
  }
  if (!bytesEqual(encoded, encodeCanonicalCbor(decoded)))
    throw new DomainValidationError("searchSettings", "must use canonical CBOR");
  return validate(decoded);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function searchSettingsRevision(value: SearchSettings): Promise<string> {
  const valid = validate(value);
  return valid.semantic === "Disabled"
    ? hex(await sha256(encodeCanonicalCbor(valid)))
    : providerIdentityHash(valid.provider);
}
