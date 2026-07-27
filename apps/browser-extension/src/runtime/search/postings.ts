import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import { encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import { sha256 } from "../../domain/hash";
import { uuid } from "../../domain/validation";
import type { VaultKeyring } from "../vault/keyring";
import type { KeywordRow } from "./keyword";

export type SearchPostingNamespace = "term" | "title-exact" | "url-exact";

const POSTING_NAMESPACES: readonly SearchPostingNamespace[] = ["term", "title-exact", "url-exact"];
const OPAQUE_MAC_PATTERN = /^[0-9a-f]{64}$/u;

export interface SearchKeywordPostingEntry {
  readonly namespace: SearchPostingNamespace;
  readonly value: string;
  readonly opaqueMac: string;
}

export interface SearchKeywordPostingPlaintext {
  readonly namespace: SearchPostingNamespace;
  readonly opaqueMac: string;
  readonly Active: readonly string[];
  readonly Deleted: readonly string[];
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactValue(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("und");
}

function sortedUniqueBundleIds(value: readonly string[], field: string): readonly string[] {
  const decoded = value.map((bundleId, index) => uuid(bundleId, `${field}[${index}]`));
  if (decoded.some((bundleId, index) => index > 0 && bundleId <= (decoded[index - 1] ?? bundleId)))
    throw new DomainValidationError(field, "must be lexically sorted and unique");
  return decoded;
}

export function validateSearchKeywordPosting(
  value: SearchKeywordPostingPlaintext,
): SearchKeywordPostingPlaintext {
  if (!POSTING_NAMESPACES.includes(value.namespace))
    throw new DomainValidationError("searchPosting.namespace", "is unsupported");
  if (!OPAQUE_MAC_PATTERN.test(value.opaqueMac))
    throw new DomainValidationError("searchPosting.opaqueMac", "must be a lowercase HMAC digest");
  const Active = sortedUniqueBundleIds(value.Active, "searchPosting.Active");
  const Deleted = sortedUniqueBundleIds(value.Deleted, "searchPosting.Deleted");
  if (Active.some((bundleId) => Deleted.includes(bundleId)))
    throw new DomainValidationError("searchPosting", "must not contain a Capture in both scopes");
  return { namespace: value.namespace, opaqueMac: value.opaqueMac, Active, Deleted };
}

export async function deriveSearchKeywordLookupKey(
  keyring: VaultKeyring,
  vaultIdValue: string,
): Promise<CryptoKey> {
  const vaultId = uuid(vaultIdValue, "searchKeywordLookup.vaultId");
  const epoch = keyring.active();
  const keyBytes = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:projection:v1",
    contextId: `SearchKeywordLookup-v1:${vaultId}`,
    keyVersion: 1,
  });
  try {
    return await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(keyBytes),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } finally {
    await wipe(keyBytes);
  }
}

export async function searchKeywordPostingKey(
  lookupKey: CryptoKey,
  namespaceValue: SearchPostingNamespace,
  normalizedValue: string,
): Promise<string> {
  if (!POSTING_NAMESPACES.includes(namespaceValue))
    throw new DomainValidationError("searchPosting.namespace", "is unsupported");
  if (normalizedValue.length === 0)
    throw new DomainValidationError("searchPosting.value", "must not be empty");
  if (normalizedValue.normalize("NFC") !== normalizedValue)
    throw new DomainValidationError("searchPosting.value", "must use NFC normalization");
  if (
    lookupKey.type !== "secret" ||
    lookupKey.extractable ||
    lookupKey.algorithm.name !== "HMAC" ||
    !lookupKey.usages.includes("sign")
  )
    throw new DomainValidationError("searchPosting.lookupKey", "is invalid");

  const message = new TextEncoder().encode(`${namespaceValue}\0${normalizedValue}`);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", lookupKey, Uint8Array.from(message)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function keywordPostingEntries(
  lookupKey: CryptoKey,
  row: KeywordRow,
): Promise<readonly SearchKeywordPostingEntry[]> {
  const values = new Map<string, { namespace: SearchPostingNamespace; value: string }>();
  const add = (namespace: SearchPostingNamespace, value: string): void => {
    if (value.length > 0) values.set(`${namespace}\0${value}`, { namespace, value });
  };
  for (const field of row.fields) {
    for (const token of field.tokens) add("term", token);
  }
  add("title-exact", exactValue(row.document.title));
  add("url-exact", exactValue(row.document.canonicalUrl));
  for (const knownUrl of row.document.knownUrls) add("url-exact", exactValue(knownUrl));

  return (
    await Promise.all(
      Array.from(values.values(), async ({ namespace, value }) => ({
        namespace,
        value,
        opaqueMac: await searchKeywordPostingKey(lookupKey, namespace, value),
      })),
    )
  ).sort(
    (left, right) =>
      left.opaqueMac.localeCompare(right.opaqueMac) ||
      left.namespace.localeCompare(right.namespace) ||
      left.value.localeCompare(right.value),
  );
}

export async function searchKeywordPostingRevision(
  value: SearchKeywordPostingPlaintext,
): Promise<string> {
  const validated = validateSearchKeywordPosting(value);
  return hex(
    await sha256(
      encodeCanonicalCbor({
        ...validated,
        activeDocumentFrequency: validated.Active.length,
        deletedDocumentFrequency: validated.Deleted.length,
      }),
    ),
  );
}
