import { sha256 } from "@noble/hashes/sha2.js";
import { DomainValidationError } from "../../domain/errors";

const encoder = new TextEncoder();

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeRemoteSearchEndpoint(value: string): string {
  if (value.length === 0 || value.length > 2_048)
    throw new DomainValidationError("remoteSearch.endpoint", "is out of range");
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new DomainValidationError("remoteSearch.endpoint", "must be an absolute URL");
  }
  const localHttp =
    endpoint.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== "https:" && !localHttp) ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0
  )
    throw new DomainValidationError("remoteSearch.endpoint", "is not permitted");
  return endpoint.href;
}

export function remoteSearchPermissionPattern(endpoint: string): string {
  const url = new URL(normalizeRemoteSearchEndpoint(endpoint));
  return `${url.protocol}//${url.hostname}/*`;
}

export function remoteSearchEndpointPathHash(endpoint: string): string {
  const url = new URL(normalizeRemoteSearchEndpoint(endpoint));
  return hex(sha256(encoder.encode(`${url.pathname}${url.search}`)));
}

export async function remoteSearchEndpointIdentity(endpoint: string): Promise<{
  readonly endpoint: string;
  readonly origin: string;
  readonly pathHash: string;
}> {
  const normalized = normalizeRemoteSearchEndpoint(endpoint);
  const url = new URL(normalized);
  return {
    endpoint: normalized,
    origin: url.origin,
    pathHash: remoteSearchEndpointPathHash(normalized),
  };
}
