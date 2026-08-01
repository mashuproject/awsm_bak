import { bytesEqual } from "../hash";
import { advisoryExtensions } from "./features";
import { type Identifier, identifier, vaultObjectId } from "./identifiers";
import {
  canonicalSetValue,
  exactCode,
  exactMap,
  identifierValue,
  integer,
  mapValue,
  nonnegativeInteger,
  nullable,
  signedInteger,
  textValue,
} from "./schema";
import {
  assertCanonicalScopedKey,
  type CanonicalValue,
  canonicalMap,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "./value";

export const VAULT_OBJECT_FORMAT = 1 as const;
export const BUNDLE_DESCRIPTOR_OBJECT = 1 as const;
export const ARTIFACT_OBJECT = 2 as const;
export const NOTE_CONTENT_OBJECT = 3 as const;
export type VaultObjectType = 1 | 2 | 3;

export interface VaultObjectInput {
  readonly vaultId: Identifier<"Vault">;
  readonly objectType: VaultObjectType;
  readonly requiredFeatureSetId: Identifier<"RequiredFeatureSet">;
  readonly body: CanonicalValue;
  readonly extensions: ReadonlyMap<string, CanonicalValue>;
}

export interface VaultObject extends VaultObjectInput {
  readonly bytes: Uint8Array;
  readonly objectId: Identifier<"VaultObject">;
  readonly referencedObjectIds: readonly Identifier<"VaultObject">[];
}

function extensionMap(value: CanonicalValue): ReadonlyMap<string, CanonicalValue> {
  if (!(value instanceof Map)) throw new TypeError("Object Advisory Extensions must be a map");
  const entries: (readonly [string, Uint8Array])[] = [];
  for (const [key, extension] of value) {
    if (typeof key !== "string" || !(extension instanceof Uint8Array)) {
      throw new TypeError("Object Advisory Extensions must map scoped keys to bytes");
    }
    entries.push([key, extension]);
  }
  return advisoryExtensions(entries);
}

function assertExtensions(value: ReadonlyMap<string, CanonicalValue>): void {
  extensionMap(value);
}

function arbitraryBytes(value: CanonicalValue, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} must be bytes`);
  return Uint8Array.from(value);
}

function scopedKey(value: CanonicalValue, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return assertCanonicalScopedKey(value);
}

function canonicalUrl(value: CanonicalValue, field: string): string {
  const text = textValue(value, field, { allowEmpty: false });
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError(`${field} must be an absolute URL`);
  }
  if (parsed.hash !== "") throw new TypeError(`${field} must not contain a fragment`);
  if (parsed.toString() !== text) throw new TypeError(`${field} is not in canonical URL form`);
  return text;
}

function artifactReference(value: CanonicalValue, field: string): Identifier<"VaultObject"> {
  const reference = exactMap(value, [0, 1], field);
  const artifactId = identifierValue(mapValue(reference, 0), "VaultObject", `${field} Artifact ID`);
  scopedKey(mapValue(reference, 1), `${field} role`);
  return artifactId;
}

const BASE_ARTIFACT_ROLES = new Set([
  "awsm.artifact.primary",
  "awsm.artifact.screenshot-full",
  "awsm.artifact.thumbnail",
  "awsm.artifact.text-extracted",
  "awsm.artifact.content-structured",
]);

function validateFormatOnlyBytes(bytes: Uint8Array, field: string): void {
  const map = exactMap(decodeCanonicalValue(bytes), [0], field);
  exactCode(mapValue(map, 0), 1, `${field} format`);
}

function validateBundleDescriptor(value: CanonicalValue): readonly Identifier<"VaultObject">[] {
  const body = exactMap(value, [...Array(12).keys()], "Bundle Descriptor body");
  exactCode(mapValue(body, 0), 1, "Bundle Descriptor format");
  identifierValue(mapValue(body, 1), "Bundle", "Bundle ID");
  signedInteger(mapValue(body, 2), "Capture asserted timestamp");
  canonicalUrl(mapValue(body, 3), "Capture original URL");
  canonicalUrl(mapValue(body, 4), "Capture final URL");
  const profile = scopedKey(mapValue(body, 5), "Capture Profile key");
  const adapter = scopedKey(mapValue(body, 6), "Capture adapter key");
  const adapterRevision = nonnegativeInteger(mapValue(body, 7), "Capture adapter revision");
  nullable(mapValue(body, 8), (title) =>
    textValue(title, "Captured title", { maxUtf8Bytes: 1_024 }),
  );
  const roles = new Set<string>();
  const references = canonicalSetValue(
    mapValue(body, 9),
    "Artifact references",
    (entry, index) => {
      const reference = exactMap(entry, [0, 1], `Artifact reference ${index}`);
      const role = scopedKey(mapValue(reference, 1), `Artifact reference ${index} role`);
      if (roles.has(role)) throw new TypeError("Bundle Descriptor repeats an Artifact role");
      if (profile === "awsm.capture.web-page-snapshot" && !BASE_ARTIFACT_ROLES.has(role)) {
        throw new TypeError("Base web Capture contains an unknown Artifact role");
      }
      roles.add(role);
      artifactReference(entry, `Artifact reference ${index}`);
      return entry;
    },
    { nonempty: true },
  ).map((entry, index) => artifactReference(entry, `Artifact reference ${index}`));
  if (profile === "awsm.capture.web-page-snapshot" && !roles.has("awsm.artifact.primary")) {
    throw new TypeError("Base web Capture is missing its primary Artifact");
  }
  canonicalSetValue(mapValue(body, 10), "Capture warnings", (entry, index) => {
    const warning = exactMap(entry, [0, 1], `Capture warning ${index}`);
    scopedKey(mapValue(warning, 0), `Capture warning ${index} key`);
    arbitraryBytes(mapValue(warning, 1), `Capture warning ${index} detail`);
    return entry;
  });
  const provenance = exactMap(
    mapValue(body, 11),
    mapValue(body, 11) instanceof Map &&
      (mapValue(body, 11) as ReadonlyMap<number, CanonicalValue>).get(0) === 2
      ? [0, 1, 2, 3, 4, 5, 6]
      : [0, 1],
    "Bundle provenance",
  );
  const provenanceKind = integer(mapValue(provenance, 0), "Bundle provenance kind");
  if (provenanceKind === 1) {
    const profileProvenance = arbitraryBytes(
      mapValue(provenance, 1),
      "Direct Capture profile provenance",
    );
    if (profile === "awsm.capture.web-page-snapshot") {
      if (adapter !== "awsm.adapter.browser-web-page" || adapterRevision !== 1) {
        throw new TypeError("Base web Capture adapter identity is unsupported");
      }
      validateFormatOnlyBytes(profileProvenance, "Page Snapshot provenance");
    }
  } else if (provenanceKind === 2) {
    identifierValue(mapValue(provenance, 1), "Vault", "Source Vault ID");
    identifierValue(mapValue(provenance, 2), "Generation", "Source Generation ID");
    identifierValue(mapValue(provenance, 3), "VaultRecord", "Source Record ID");
    identifierValue(mapValue(provenance, 4), "Bundle", "Source Bundle ID");
    identifierValue(mapValue(provenance, 5), "VaultObject", "Source Descriptor ID");
    const profileProvenance = arbitraryBytes(
      mapValue(provenance, 6),
      "Re-authored profile provenance",
    );
    if (profile === "awsm.capture.web-page-snapshot") {
      validateFormatOnlyBytes(profileProvenance, "Page Snapshot provenance");
    }
  } else {
    throw new TypeError("Unknown Bundle provenance kind");
  }
  return references;
}

function lowerCaseMediaType(value: CanonicalValue): string {
  const mediaType = textValue(value, "Artifact media type");
  if (
    mediaType !== mediaType.toLowerCase() ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[a-z0-9!#$&^_.+*-]+=[a-z0-9!#$&^_.+*-]+)*$/u.test(
      mediaType,
    )
  ) {
    throw new TypeError("Artifact media type must use canonical lower-case syntax");
  }
  return mediaType;
}

function validateArtifactObject(value: CanonicalValue): void {
  const body = exactMap(value, [...Array(8).keys()], "Artifact Object body");
  exactCode(mapValue(body, 0), 1, "Artifact Object format");
  const kind = scopedKey(mapValue(body, 1), "Artifact kind");
  const mediaType = lowerCaseMediaType(mapValue(body, 2));
  const representation = scopedKey(mapValue(body, 3), "Artifact representation key");
  const plaintextLength = nonnegativeInteger(mapValue(body, 4), "Artifact plaintext length");
  const plaintextDigest = identifierValue(
    mapValue(body, 5),
    "Artifact",
    "Artifact plaintext digest",
  );
  const contract = exactMap(mapValue(body, 6), [0, 1, 2, 3, 4], "Artifact wrapper contract");
  exactCode(mapValue(contract, 0), 1, "Artifact wrapper contract format");
  exactCode(mapValue(contract, 1), 1_048_576, "Artifact frame plaintext limit");
  exactCode(mapValue(contract, 2), 16, "Artifact frame tag length");
  if (nonnegativeInteger(mapValue(contract, 3), "Wrapper plaintext length") !== plaintextLength) {
    throw new TypeError("Artifact wrapper length does not match the Artifact body");
  }
  const contractDigest = identifierValue(
    mapValue(contract, 4),
    "Artifact",
    "Wrapper plaintext digest",
  );
  if (!bytesEqual(plaintextDigest, contractDigest)) {
    throw new TypeError("Artifact wrapper digest does not match the Artifact body");
  }
  const metadataBytes = arbitraryBytes(mapValue(body, 7), "Artifact intrinsic metadata");
  validateBaseArtifactMetadata({ kind, mediaType, representation, metadataBytes });
}

function validateBaseArtifactMetadata(input: {
  readonly kind: string;
  readonly mediaType: string;
  readonly representation: string;
  readonly metadataBytes: Uint8Array;
}): void {
  switch (input.representation) {
    case "awsm.representation.web-page-zip":
      if (
        input.kind !== "awsm.artifact.capture" ||
        input.mediaType !== "application/vnd.awsm.web-page+zip"
      ) {
        throw new TypeError("Page Snapshot Artifact kind or media type is invalid");
      }
      validateFormatOnlyBytes(input.metadataBytes, "Page Snapshot intrinsic metadata");
      return;
    case "awsm.representation.webp.full":
    case "awsm.representation.webp.thumbnail": {
      if (input.kind !== "awsm.artifact.image" || input.mediaType !== "image/webp") {
        throw new TypeError("WebP Artifact kind or media type is invalid");
      }
      const metadata = exactMap(
        decodeCanonicalValue(input.metadataBytes),
        [0, 1, 2],
        "WebP intrinsic metadata",
      );
      exactCode(mapValue(metadata, 0), 1, "WebP metadata format");
      const width = nonnegativeInteger(mapValue(metadata, 1), "WebP width");
      const height = nonnegativeInteger(mapValue(metadata, 2), "WebP height");
      if (width < 1 || height < 1) throw new TypeError("WebP dimensions must be positive");
      if (
        input.representation === "awsm.representation.webp.thumbnail" &&
        (width !== 640 || height !== 360)
      ) {
        throw new TypeError("Base thumbnail dimensions must be 640 by 360");
      }
      return;
    }
    case "awsm.representation.text.utf-8":
      if (input.kind !== "awsm.artifact.text" || input.mediaType !== "text/plain;charset=utf-8") {
        throw new TypeError("Extracted text Artifact kind or media type is invalid");
      }
      validateFormatOnlyBytes(input.metadataBytes, "Extracted text intrinsic metadata");
      return;
    case "awsm.representation.structured.cbor-seq":
      if (input.kind !== "awsm.artifact.structured" || input.mediaType !== "application/cbor-seq") {
        throw new TypeError("Structured Artifact kind or media type is invalid");
      }
      validateFormatOnlyBytes(input.metadataBytes, "Structured Content intrinsic metadata");
      return;
    default:
      throw new TypeError("Unknown base Artifact representation key");
  }
}

function validateNoteContent(value: CanonicalValue): void {
  const body = exactMap(value, [0, 1, 2, 3], "Note Content Object body");
  exactCode(mapValue(body, 0), 1, "Note Content format");
  nullable(mapValue(body, 1), (title) => textValue(title, "Note title", { maxUtf8Bytes: 1_024 }));
  textValue(mapValue(body, 2), "Note body", { allowLineFeed: true, allowEmpty: true });
  const dialect = mapValue(body, 3);
  if (dialect !== "awsm.note.commonmark") {
    throw new TypeError("Unknown base Note body dialect");
  }
  const noteBody = mapValue(body, 2) as string;
  if (/\r|<\/?[a-z][^>]*>|data:/iu.test(noteBody)) {
    throw new TypeError("Base Note source contains prohibited HTML, CR, or data URLs");
  }
}

function validateBody(
  type: VaultObjectType,
  body: CanonicalValue,
): readonly Identifier<"VaultObject">[] {
  switch (type) {
    case BUNDLE_DESCRIPTOR_OBJECT:
      return validateBundleDescriptor(body);
    case ARTIFACT_OBJECT:
      validateArtifactObject(body);
      return [];
    case NOTE_CONTENT_OBJECT:
      validateNoteContent(body);
      return [];
  }
}

function assertInput(input: VaultObjectInput): readonly Identifier<"VaultObject">[] {
  if (![1, 2, 3].includes(input.objectType)) throw new TypeError("Unknown base Vault Object type");
  assertExtensions(input.extensions);
  return validateBody(input.objectType, input.body);
}

export function encodeVaultObject(input: VaultObjectInput): VaultObject {
  assertInput(input);
  const bytes = encodeCanonicalValue(
    canonicalMap([
      [0, VAULT_OBJECT_FORMAT],
      [1, input.vaultId],
      [2, input.objectType],
      [3, input.requiredFeatureSetId],
      [4, input.body],
      [5, input.extensions],
    ]),
  );
  return decodeVaultObject(bytes);
}

export function decodeVaultObject(bytes: Uint8Array): VaultObject {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1, 2, 3, 4, 5], "Vault Object");
  exactCode(mapValue(map, 0), VAULT_OBJECT_FORMAT, "Vault Object format");
  const objectType = integer(mapValue(map, 2), "Vault Object type") as VaultObjectType;
  const input: VaultObjectInput = {
    vaultId: identifierValue(mapValue(map, 1), "Vault", "Vault Object Vault ID"),
    objectType,
    requiredFeatureSetId: identifierValue(
      mapValue(map, 3),
      "RequiredFeatureSet",
      "Vault Object Required Feature Set ID",
    ),
    body: mapValue(map, 4),
    extensions: extensionMap(mapValue(map, 5)),
  };
  const referencedObjectIds = assertInput(input);
  const canonicalBytes = Uint8Array.from(bytes);
  return {
    ...input,
    bytes: canonicalBytes,
    objectId: vaultObjectId(input.vaultId, input.objectType, canonicalBytes),
    referencedObjectIds,
  };
}

export function artifactId(object: VaultObject): Identifier<"Artifact"> {
  if (object.objectType !== ARTIFACT_OBJECT) throw new TypeError("Vault Object is not an Artifact");
  return identifier("Artifact", object.objectId);
}
