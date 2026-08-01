import { type EncryptedArtifactFrame, openArtifactFrames } from "../../crypto/artifact-stream";
import type { Identifier } from "../../domain/canonical/identifiers";
import {
  ARTIFACT_OBJECT,
  artifactId,
  BUNDLE_DESCRIPTOR_OBJECT,
  encodeVaultObject,
  type VaultObject,
} from "../../domain/canonical/object";
import {
  exactMap,
  identifierValue,
  mapValue,
  nonnegativeInteger,
} from "../../domain/canonical/schema";
import { concatBytes } from "../../domain/canonical/transcript";
import { type CanonicalValue, canonicalMap, canonicalSet } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import {
  createStorageItemIdHasher,
  decodeOpaqueEnvelopePrefix,
  STREAMABLE_STORAGE_CLASS,
} from "../../storage/opaque-envelope";
import type {
  CanonicalArtifactStore,
  PreparedArtifactRepresentation,
} from "../artifact/canonical-store";
import {
  type BuiltVacuumContentCheckpoint,
  buildVacuumContentCheckpoint,
  type CanonicalCheckpointTail,
  type CanonicalVacuumConflictState,
  type CanonicalVacuumContentState,
} from "./canonical-vacuum-content-checkpoint";

export type ForkIdentifierKind =
  | "Bundle"
  | "Collection"
  | "Folder"
  | "Tag"
  | "TagAssignment"
  | "Note"
  | "VaultObject"
  | "BaselineCause";

export interface BuiltForkContentCheckpoint {
  readonly state: CanonicalVacuumContentState;
  readonly content: BuiltVacuumContentCheckpoint;
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

class StreamBytes {
  private readonly queued: Uint8Array[] = [];
  private queuedLength = 0;
  private done = false;

  constructor(readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async exact(length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError("Stream read length must be a nonnegative safe integer");
    }
    while (this.queuedLength < length && !this.done) {
      const next = await this.reader.read();
      if (next.done) {
        this.done = true;
        break;
      }
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
        throw new TypeError("Artifact wrapper stream chunks must be nonempty bytes");
      }
      this.queued.push(next.value);
      this.queuedLength += next.value.byteLength;
    }
    if (this.queuedLength < length) throw new TypeError("Artifact wrapper stream is truncated");
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const first = this.queued[0] as Uint8Array;
      const take = Math.min(first.byteLength, length - written);
      result.set(first.subarray(0, take), written);
      written += take;
      this.queuedLength -= take;
      if (take === first.byteLength) this.queued.shift();
      else this.queued[0] = first.subarray(take);
    }
    return result;
  }

  async requireEnd(): Promise<void> {
    if (this.queuedLength !== 0) throw new TypeError("Artifact wrapper has trailing bytes");
    if (!this.done) {
      const next = await this.reader.read();
      if (!next.done) throw new TypeError("Artifact wrapper has trailing bytes");
      this.done = true;
    }
  }
}

async function readStreamableArtifactEnvelope(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const bytes = new StreamBytes(reader);
  try {
    const fixedPrefix = await bytes.exact(12);
    const headerLength = new DataView(fixedPrefix.buffer, fixedPrefix.byteOffset + 8, 4).getUint32(
      0,
      false,
    );
    if (headerLength < 1 || headerLength > 4096) {
      throw new TypeError("Artifact wrapper header length is invalid");
    }
    const prefix = decodeOpaqueEnvelopePrefix(
      concatBytes([fixedPrefix, await bytes.exact(headerLength)]),
    );
    if (prefix.storageClass !== STREAMABLE_STORAGE_CLASS) {
      throw new TypeError("Artifact wrapper must use the Streamable storage class");
    }
    return { reader, bytes, prefix };
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
}

function artifactContract(object: VaultObject) {
  if (object.objectType !== ARTIFACT_OBJECT) {
    throw new TypeError("Fork Artifact preparation requires an Artifact Object");
  }
  const body = exactMap(object.body, [...Array(8).keys()], "Fork Artifact Object body");
  return {
    plaintextLength: nonnegativeInteger(mapValue(body, 4), "Fork Artifact plaintext length"),
    plaintextDigest: identifierValue(
      mapValue(body, 5),
      "Artifact",
      "Fork Artifact plaintext digest",
    ),
  };
}

async function* readableChunks(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function prepareForkArtifactRepresentation(input: {
  readonly sourceStore: CanonicalArtifactStore;
  readonly destinationStore: CanonicalArtifactStore;
  readonly sourceStorageItemId: Identifier<"StorageItem">;
  readonly sourceObject: VaultObject;
  readonly sourceKeyEpochId: Identifier<"KeyEpoch">;
  readonly sourceKeyEpochKey: Uint8Array;
  readonly destinationObject: VaultObject;
  readonly destinationKeyEpochId: Identifier<"KeyEpoch">;
  readonly destinationKeyEpochKey: Uint8Array;
  readonly protectionParameters?: Uint8Array;
}): Promise<PreparedArtifactRepresentation> {
  const sourceContract = artifactContract(input.sourceObject);
  const destinationContract = artifactContract(input.destinationObject);
  if (
    sourceContract.plaintextLength !== destinationContract.plaintextLength ||
    !bytesEqual(sourceContract.plaintextDigest, destinationContract.plaintextDigest)
  ) {
    throw new TypeError("Fork destination Artifact changed its logical payload contract");
  }
  const sourceEnvelope = await readStreamableArtifactEnvelope(
    await input.sourceStore.open(input.sourceStorageItemId),
  );
  const itemHasher = createStorageItemIdHasher(
    sourceEnvelope.prefix.prefixBytes.byteLength + sourceEnvelope.prefix.ciphertextLength,
  );
  itemHasher.update(sourceEnvelope.prefix.prefixBytes);
  const frames = (async function* (): AsyncIterable<EncryptedArtifactFrame> {
    let remaining = sourceEnvelope.prefix.ciphertextLength;
    try {
      while (remaining > 0) {
        if (remaining < 9) throw new TypeError("Artifact wrapper frame prefix is truncated");
        const framePrefix = await sourceEnvelope.bytes.exact(9);
        const view = new DataView(framePrefix.buffer, framePrefix.byteOffset, 9);
        const index = view.getUint32(0, false);
        const flags = view.getUint8(4);
        const ciphertextLength = view.getUint32(5, false);
        if ((flags & 0xfe) !== 0 || ciphertextLength > remaining - 9) {
          throw new TypeError("Artifact wrapper frame metadata is invalid");
        }
        const ciphertext = await sourceEnvelope.bytes.exact(ciphertextLength);
        itemHasher.update(framePrefix);
        itemHasher.update(ciphertext);
        remaining -= 9 + ciphertextLength;
        yield { index, final: (flags & 1) === 1, ciphertext };
      }
      await sourceEnvelope.bytes.requireEnd();
      if (!bytesEqual(itemHasher.digest(), input.sourceStorageItemId)) {
        throw new TypeError("Fork source Artifact Storage Item identity is invalid");
      }
    } finally {
      sourceEnvelope.reader.releaseLock();
    }
  })();
  const plaintext = new TransformStream<Uint8Array, Uint8Array>();
  const writer = plaintext.writable.getWriter();
  const decryption = openArtifactFrames({
    vaultId: input.sourceObject.vaultId,
    keyEpochId: input.sourceKeyEpochId,
    keyEpochKey: input.sourceKeyEpochKey,
    artifactId: artifactId(input.sourceObject),
    contract: sourceContract,
    protectionParameters: sourceEnvelope.prefix.protectionParameters,
    ciphertextLength: sourceEnvelope.prefix.ciphertextLength,
    ciphertextDigest: sourceEnvelope.prefix.ciphertextDigest,
    frames,
    writePlaintext: async (chunk) => writer.write(chunk),
  }).then(
    async () => writer.close(),
    async (error) => {
      await writer.abort(error).catch(() => undefined);
      throw error;
    },
  );
  const preparation = input.destinationStore.prepare({
    vaultId: input.destinationObject.vaultId,
    keyEpochId: input.destinationKeyEpochId,
    keyEpochKey: input.destinationKeyEpochKey,
    artifactId: artifactId(input.destinationObject),
    contract: destinationContract,
    source: readableChunks(plaintext.readable),
    ...(input.protectionParameters === undefined
      ? {}
      : { protectionParameters: input.protectionParameters }),
  });
  try {
    const [prepared] = await Promise.all([preparation, decryption]);
    return prepared;
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    await sourceEnvelope.reader.cancel(error).catch(() => undefined);
    await decryption.catch(() => undefined);
    throw error;
  }
}

export function rebuildForkVaultObject(input: {
  readonly source: VaultObject;
  readonly destinationVaultId: Identifier<"Vault">;
  readonly requiredFeatureSetId: Identifier<"RequiredFeatureSet">;
  readonly mapIdentifier: <Kind extends "Bundle" | "VaultObject">(
    kind: Kind,
    source: Identifier<Kind>,
  ) => Identifier<Kind>;
}): VaultObject {
  let body = input.source.body;
  if (input.source.objectType === BUNDLE_DESCRIPTOR_OBJECT) {
    const sourceBody = exactMap(
      input.source.body,
      [...Array(12).keys()],
      "Fork source Bundle Descriptor body",
    );
    const sourceReferences = mapValue(sourceBody, 9);
    if (!Array.isArray(sourceReferences)) {
      throw new TypeError("Fork source Bundle Descriptor references must be a set");
    }
    body = indexedMap(
      mapValue(sourceBody, 0),
      input.mapIdentifier(
        "Bundle",
        identifierValue(mapValue(sourceBody, 1), "Bundle", "Fork source Bundle ID"),
      ),
      mapValue(sourceBody, 2),
      mapValue(sourceBody, 3),
      mapValue(sourceBody, 4),
      mapValue(sourceBody, 5),
      mapValue(sourceBody, 6),
      mapValue(sourceBody, 7),
      mapValue(sourceBody, 8),
      canonicalSet(
        sourceReferences.map((value, index) => {
          const reference = exactMap(value, [0, 1], `Fork Artifact reference ${index}`);
          return indexedMap(
            input.mapIdentifier(
              "VaultObject",
              identifierValue(
                mapValue(reference, 0),
                "VaultObject",
                `Fork Artifact reference ${index} Object ID`,
              ),
            ),
            mapValue(reference, 1),
          );
        }),
      ),
      mapValue(sourceBody, 10),
      mapValue(sourceBody, 11),
    );
  }
  const rebuilt = encodeVaultObject({
    vaultId: input.destinationVaultId,
    objectType: input.source.objectType,
    requiredFeatureSetId: input.requiredFeatureSetId,
    extensions: input.source.extensions,
    body,
  });
  if (bytesEqual(rebuilt.objectId, input.source.objectId)) {
    throw new TypeError("Fork Vault Object identity must be fresh");
  }
  return rebuilt;
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildForkContentCheckpoint(
  input: CanonicalVacuumContentState,
  options: {
    readonly mapIdentifier: <Kind extends ForkIdentifierKind>(
      kind: Kind,
      source: Uint8Array,
    ) => Identifier<Kind>;
  },
): BuiltForkContentCheckpoint {
  const bySource = new Map<string, Identifier<ForkIdentifierKind>>();
  const sourceByDestination = new Map<string, string>();
  const mapped = <Kind extends ForkIdentifierKind>(
    kind: Kind,
    source: Uint8Array,
  ): Identifier<Kind> => {
    const sourceKey = `${kind}:${key(source)}`;
    const existing = bySource.get(sourceKey);
    if (existing !== undefined) return existing as Identifier<Kind>;
    const destination = options.mapIdentifier(kind, source);
    if (bytesEqual(destination, source)) {
      throw new TypeError(`Fork ${kind} identity must be fresh`);
    }
    const destinationKey = `${kind}:${key(destination)}`;
    const otherSource = sourceByDestination.get(destinationKey);
    if (otherSource !== undefined && otherSource !== sourceKey) {
      throw new TypeError(`Fork ${kind} identities must map one-to-one`);
    }
    bySource.set(sourceKey, destination);
    sourceByDestination.set(destinationKey, sourceKey);
    return destination;
  };
  const tail = (value: CanonicalCheckpointTail | null): CanonicalCheckpointTail | null =>
    value === null
      ? null
      : {
          bundleId: mapped("Bundle", value.bundleId),
          registrationCauseId: value.registrationCauseId,
        };
  const conflict = (value: CanonicalVacuumConflictState): CanonicalVacuumConflictState => {
    switch (value.kind) {
      case 1:
        return {
          ...value,
          subjectIds: value.subjectIds.map((id) => mapped("Collection", id)),
          candidates: value.candidates.map((candidate) => ({
            ...candidate,
            redirects: candidate.redirects.map((redirect) => ({
              sourceId: mapped("Collection", redirect.sourceId),
              destinationId: mapped("Collection", redirect.destinationId),
            })),
          })),
        };
      case 2:
        return {
          ...value,
          subjectIds: value.subjectIds.map((id) => mapped("Folder", id)),
          candidates: value.candidates.map((candidate) => ({
            ...candidate,
            placements: candidate.placements.map((placement) => ({
              folderId: mapped("Folder", placement.folderId),
              parentFolderId:
                placement.parentFolderId === null
                  ? null
                  : mapped("Folder", placement.parentFolderId),
            })),
          })),
        };
      case 3:
        return {
          ...value,
          subjectIds: value.subjectIds.map((id) => mapped("Tag", id)),
          candidates: value.candidates.map((candidate) => ({
            ...candidate,
            redirects: candidate.redirects.map((redirect) => ({
              sourceId: mapped("Tag", redirect.sourceId),
              destinationId: mapped("Tag", redirect.destinationId),
            })),
          })),
        };
      case 4:
        return {
          ...value,
          subjectIds: value.subjectIds.map((id) => mapped("Note", id)),
          candidates: value.candidates.map((candidate) => ({
            ...candidate,
            noteId: mapped("Note", candidate.noteId),
            contentObjectId:
              candidate.contentObjectId === null
                ? null
                : mapped("VaultObject", candidate.contentObjectId),
          })),
        };
    }
  };
  const target = (
    kind: 1 | 2,
    value: Identifier<"Collection"> | Identifier<"Bundle">,
  ): Identifier<"Collection"> | Identifier<"Bundle"> =>
    kind === 1 ? mapped("Collection", value) : mapped("Bundle", value);
  const state: CanonicalVacuumContentState = {
    vaultLabel: input.vaultLabel,
    credentialLabels: [],
    captures: input.captures.map((capture) => ({
      ...capture,
      bundleId: mapped("Bundle", capture.bundleId),
      descriptorObjectId: mapped("VaultObject", capture.descriptorObjectId),
      assignedCollectionId: mapped("Collection", capture.assignedCollectionId),
    })),
    collections: input.collections.map((collection) => ({
      ...collection,
      collectionId: mapped("Collection", collection.collectionId),
      folderId: collection.folderId === null ? null : mapped("Folder", collection.folderId),
      activeRedirect:
        collection.activeRedirect === null
          ? null
          : {
              ...collection.activeRedirect,
              destinationCollectionId: mapped(
                "Collection",
                collection.activeRedirect.destinationCollectionId,
              ),
            },
      intrinsicTail: tail(collection.intrinsicTail),
      effectiveTail: tail(collection.effectiveTail),
    })),
    folders: input.folders.map((folder) => ({
      ...folder,
      folderId: mapped("Folder", folder.folderId),
      parentFolderId:
        folder.parentFolderId === null ? null : mapped("Folder", folder.parentFolderId),
    })),
    tags: input.tags.map((tag) => ({
      ...tag,
      tagId: mapped("Tag", tag.tagId),
      activeRedirect:
        tag.activeRedirect === null
          ? null
          : {
              ...tag.activeRedirect,
              destinationTagId: mapped("Tag", tag.activeRedirect.destinationTagId),
            },
    })),
    tagAssignments: input.tagAssignments.map((assignment) => ({
      ...assignment,
      assignmentId: mapped("TagAssignment", assignment.assignmentId),
      tagId: mapped("Tag", assignment.tagId),
      targetId: target(assignment.targetKind, assignment.targetId),
    })),
    notes: input.notes.map((note) => ({
      ...note,
      noteId: mapped("Note", note.noteId),
      targetId: target(note.targetKind, note.targetId),
      versions: note.versions.map((version) => ({
        ...version,
        contentObjectId:
          version.contentObjectId === null ? null : mapped("VaultObject", version.contentObjectId),
        restoreContentObjectId:
          version.restoreContentObjectId === null
            ? null
            : mapped("VaultObject", version.restoreContentObjectId),
      })),
    })),
    activeConflicts: input.activeConflicts.map(conflict),
  };
  return {
    state,
    content: buildVacuumContentCheckpoint(state, {
      createCause: (sourceCauseId) => mapped("BaselineCause", sourceCauseId),
      retainDeletedCaptures: true,
    }),
  };
}
