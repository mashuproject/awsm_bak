import { bytesEqual } from "../hash";
import {
  validateClientCredentialCertificate,
  validateInvitationCapabilities,
  validateKeyEnvelopeSlots,
  validateRecoveryCredentialDescriptor,
} from "./authority-bodies";
import { DEPENDENCY_TYPES, type TypedDependency } from "./dependencies";
import type { Identifier } from "./identifiers";
import {
  booleanValue,
  canonicalSetValue,
  exactCode,
  exactMap,
  identifierValue,
  idSetValue,
  mapValue,
  nonnegativeInteger,
  nullable,
  oneOfCodes,
  signedInteger,
  textValue,
} from "./schema";
import { type CanonicalValue, canonicalSet } from "./value";

export interface BaselineBodyContext {
  readonly vaultId: Identifier<"Vault">;
  readonly dependencies: readonly TypedDependency[];
}

interface BaselineDependencyRequirement {
  readonly type: TypedDependency["type"];
  readonly id: Uint8Array;
}

const LABEL_OPTIONS = { maxUtf8Bytes: 1_024 } as const;

function cause(value: CanonicalValue, field: string): Uint8Array {
  return identifierValue(value, "VaultRecord", field);
}

function causeSet(value: CanonicalValue, field: string, nonempty = true): void {
  idSetValue(value, "VaultRecord", field, { nonempty });
}

function label(value: CanonicalValue, field: string): void {
  nullable(value, (entry) => textValue(entry, field, LABEL_OPTIONS));
}

function target(value: CanonicalValue, field: string): void {
  const map = exactMap(value, [0, 1], field);
  const kind = oneOfCodes(mapValue(map, 0), [1, 2] as const, `${field} kind`);
  identifierValue(mapValue(map, 1), kind === 1 ? "Collection" : "Bundle", `${field} ID`);
}

function attribution(value: CanonicalValue, field: string): void {
  const map = exactMap(value, [0, 1, 2, 3], field);
  identifierValue(mapValue(map, 0), "Vault", `${field} origin Vault ID`);
  identifierValue(mapValue(map, 1), "Member", `${field} Member ID`);
  identifierValue(mapValue(map, 2), "ClientCredential", `${field} Client Credential ID`);
  signedInteger(mapValue(map, 3), `${field} assertedAt`);
}

function redirect(value: CanonicalValue, kind: "Collection" | "Tag", field: string): void {
  nullable(value, (entry) => {
    const map = exactMap(entry, [0, 1], field);
    identifierValue(mapValue(map, 0), kind, `${field} destination ID`);
    cause(mapValue(map, 1), `${field} controlling Cause ID`);
  });
}

function tail(value: CanonicalValue, field: string): void {
  nullable(value, (entry) => {
    const map = exactMap(entry, [0, 1], field);
    identifierValue(mapValue(map, 0), "Bundle", `${field} Bundle ID`);
    cause(mapValue(map, 1), `${field} registration Cause ID`);
  });
}

function validateContentCheckpoint(
  value: CanonicalValue,
): readonly BaselineDependencyRequirement[] {
  const checkpoint = exactMap(value, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "Content checkpoint");
  exactCode(mapValue(checkpoint, 0), 1, "Content checkpoint format");
  const requirements: BaselineDependencyRequirement[] = [];

  const vaultLabel = exactMap(mapValue(checkpoint, 1), [0, 1], "Checkpointed Vault label");
  label(mapValue(vaultLabel, 0), "Checkpointed Vault label");
  causeSet(mapValue(vaultLabel, 1), "Vault label head Cause IDs", false);

  canonicalSetValue(mapValue(checkpoint, 2), "Credential labels", (entry, index) => {
    const item = exactMap(entry, [0, 1, 2], `Credential label ${index}`);
    identifierValue(mapValue(item, 0), "ClientCredential", "Labeled Client Credential ID");
    label(mapValue(item, 1), "Client Credential label");
    causeSet(mapValue(item, 2), "Client Credential label head Cause IDs");
    return entry;
  });

  canonicalSetValue(mapValue(checkpoint, 3), "Checkpointed Captures", (entry, index) => {
    const item = exactMap(entry, [0, 1, 2, 3, 4, 5, 6, 7], `Capture ${index}`);
    identifierValue(mapValue(item, 0), "Bundle", "Capture Bundle ID");
    const descriptorId = identifierValue(
      mapValue(item, 1),
      "VaultObject",
      "Bundle Descriptor Object ID",
    );
    requirements.push({ type: DEPENDENCY_TYPES.BundleDescriptorObject, id: descriptorId });
    identifierValue(mapValue(item, 2), "Collection", "Assigned Collection ID");
    causeSet(mapValue(item, 3), "Capture assignment head Cause IDs");
    oneOfCodes(mapValue(item, 4), [1, 2] as const, "Capture lifecycle state");
    causeSet(mapValue(item, 5), "Capture lifecycle head Cause IDs");
    cause(mapValue(item, 6), "Capture registration Cause ID");
    attribution(mapValue(item, 7), "Capture registration attribution");
    return entry;
  });

  canonicalSetValue(mapValue(checkpoint, 4), "Checkpointed Collections", (entry, index) => {
    const item = exactMap(entry, [0, 1, 2, 3, 4, 5, 6, 7], `Collection ${index}`);
    identifierValue(mapValue(item, 0), "Collection", "Collection ID");
    label(mapValue(item, 1), "Collection title");
    causeSet(mapValue(item, 2), "Collection title head Cause IDs", false);
    nullable(mapValue(item, 3), (folderId) =>
      identifierValue(folderId, "Folder", "Collection Folder ID"),
    );
    causeSet(mapValue(item, 4), "Collection Folder head Cause IDs", false);
    redirect(mapValue(item, 5), "Collection", "Collection redirect");
    tail(mapValue(item, 6), "Intrinsic Collection Tail");
    tail(mapValue(item, 7), "Effective Collection Tail");
    return entry;
  });

  canonicalSetValue(mapValue(checkpoint, 5), "Checkpointed Folders", (entry, index) => {
    const item = exactMap(entry, [0, 1, 2, 3, 4, 5, 6], `Folder ${index}`);
    identifierValue(mapValue(item, 0), "Folder", "Folder ID");
    textValue(mapValue(item, 1), "Folder name", LABEL_OPTIONS);
    causeSet(mapValue(item, 2), "Folder name head Cause IDs");
    nullable(mapValue(item, 3), (parentId) =>
      identifierValue(parentId, "Folder", "Parent Folder ID"),
    );
    causeSet(mapValue(item, 4), "Folder parent head Cause IDs", false);
    oneOfCodes(mapValue(item, 5), [1, 2] as const, "Folder lifecycle state");
    causeSet(mapValue(item, 6), "Folder lifecycle head Cause IDs");
    return entry;
  });

  canonicalSetValue(mapValue(checkpoint, 6), "Checkpointed Tags", (entry, index) => {
    const item = exactMap(entry, [0, 1, 2, 3, 4, 5], `Tag ${index}`);
    identifierValue(mapValue(item, 0), "Tag", "Tag ID");
    textValue(mapValue(item, 1), "Tag name", LABEL_OPTIONS);
    causeSet(mapValue(item, 2), "Tag name head Cause IDs");
    redirect(mapValue(item, 3), "Tag", "Tag redirect");
    oneOfCodes(mapValue(item, 4), [1, 2] as const, "Tag lifecycle state");
    causeSet(mapValue(item, 5), "Tag lifecycle head Cause IDs");
    return entry;
  });

  canonicalSetValue(mapValue(checkpoint, 7), "Checkpointed Tag assignments", (entry, index) => {
    const item = exactMap(entry, [0, 1, 2, 3], `Tag assignment ${index}`);
    identifierValue(mapValue(item, 0), "TagAssignment", "Tag Assignment ID");
    cause(mapValue(item, 1), "Tag Assigned Cause ID");
    identifierValue(mapValue(item, 2), "Tag", "Assigned Tag ID");
    target(mapValue(item, 3), "Tag assignment target");
    return entry;
  });

  canonicalSetValue(mapValue(checkpoint, 8), "Checkpointed Notes", (entry, index) => {
    const item = exactMap(entry, [0, 1, 2, 3], `Note ${index}`);
    identifierValue(mapValue(item, 0), "Note", "Note ID");
    target(mapValue(item, 1), "Note target");
    const state = oneOfCodes(mapValue(item, 2), [1, 2, 3] as const, "Note state");
    const versions = canonicalSetValue(
      mapValue(item, 3),
      "Note versions",
      (version, versionIndex) => {
        const versionMap = exactMap(version, [0, 1, 2, 3], `Note version ${versionIndex}`);
        cause(mapValue(versionMap, 0), "Note head Cause ID");
        const contentId = nullable(mapValue(versionMap, 1), (content) =>
          identifierValue(content, "VaultObject", "Note Content Object ID"),
        );
        const restoreContentId = nullable(mapValue(versionMap, 2), (content) =>
          identifierValue(content, "VaultObject", "Note restore Content Object ID"),
        );
        if ((contentId === null) === (restoreContentId === null)) {
          throw new TypeError(
            "Checkpointed Note version must retain exactly one current or restore Content Object",
          );
        }
        const requiredContentId = contentId ?? restoreContentId;
        if (requiredContentId === null) throw new TypeError("Checkpointed Note Content is absent");
        requirements.push({ type: DEPENDENCY_TYPES.NoteContentObject, id: requiredContentId });
        attribution(mapValue(versionMap, 3), "Note author attribution");
        return version;
      },
      { nonempty: true },
    );
    const nonnull = versions.filter((version) => {
      const versionMap = version as ReadonlyMap<number, CanonicalValue>;
      return mapValue(versionMap, 1) !== null;
    }).length;
    if (
      (state === 1 && (versions.length !== 1 || nonnull !== 1)) ||
      (state === 2 && nonnull !== 0)
    ) {
      throw new TypeError("Checkpointed Note versions do not match its state");
    }
    if (state === 3 && versions.length < 2) {
      throw new TypeError("Checkpointed Note Conflict must retain at least two heads");
    }
    return entry;
  });

  canonicalSetValue(mapValue(checkpoint, 9), "Active Content Conflicts", (entry, index) => {
    validateContentConflict(entry, index);
    return entry;
  });

  return requirements;
}

function validateContentConflict(value: CanonicalValue, index: number): void {
  const conflict = exactMap(value, [0, 1, 2], `Content Conflict ${index}`);
  const kind = oneOfCodes(mapValue(conflict, 0), [1, 2, 3, 4] as const, "Content Conflict kind");
  const subjectKind =
    kind === 1 ? "Collection" : kind === 2 ? "Folder" : kind === 3 ? "Tag" : "Note";
  idSetValue(mapValue(conflict, 1), subjectKind, "Content Conflict subject IDs", {
    nonempty: true,
  });
  canonicalSetValue(
    mapValue(conflict, 2),
    "Content Conflict candidates",
    (entry, candidateIndex) => {
      const candidate = exactMap(entry, [0, 1], `Content Conflict candidate ${candidateIndex}`);
      cause(mapValue(candidate, 0), "Content Conflict candidate Cause ID");
      const state = exactMap(
        mapValue(candidate, 1),
        kind === 4 ? [0, 1] : [0],
        "Conflict candidate state",
      );
      if (kind === 1 || kind === 3) {
        canonicalSetValue(mapValue(state, 0), "Conflict redirects", (redirectValue) => {
          const edge = exactMap(redirectValue, [0, 1], "Conflict redirect");
          const idKind = kind === 1 ? "Collection" : "Tag";
          identifierValue(mapValue(edge, 0), idKind, "Conflict redirect source ID");
          identifierValue(mapValue(edge, 1), idKind, "Conflict redirect destination ID");
          return redirectValue;
        });
      } else if (kind === 2) {
        canonicalSetValue(mapValue(state, 0), "Conflict Folder placements", (placement) => {
          const item = exactMap(placement, [0, 1], "Conflict Folder placement");
          identifierValue(mapValue(item, 0), "Folder", "Conflict Folder ID");
          nullable(mapValue(item, 1), (parent) =>
            identifierValue(parent, "Folder", "Conflict parent Folder ID"),
          );
          return placement;
        });
      } else {
        identifierValue(mapValue(state, 0), "Note", "Conflict Note ID");
        nullable(mapValue(state, 1), (content) =>
          identifierValue(content, "VaultObject", "Conflict Note Content Object ID"),
        );
      }
      return entry;
    },
    { nonempty: true },
  );
}

function validateAuthorityCheckpoint(
  value: CanonicalValue,
): readonly BaselineDependencyRequirement[] {
  const checkpoint = exactMap(value, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "Authority checkpoint");
  exactCode(mapValue(checkpoint, 0), 1, "Authority checkpoint format");
  const members = idSetValue(mapValue(checkpoint, 1), "Member", "Active Member IDs", {
    nonempty: true,
  });
  const administrators = idSetValue(mapValue(checkpoint, 2), "Member", "Administrator Member IDs", {
    nonempty: true,
  });
  const memberKeys = new Set(members.map(hex));
  if (administrators.some((member) => !memberKeys.has(hex(member)))) {
    throw new TypeError("Every Administrator must be an Active Member");
  }
  canonicalSetValue(
    mapValue(checkpoint, 3),
    "Client Certificates",
    (entry, index) => {
      validateClientCredentialCertificate(entry, `Client Certificate ${index}`);
      return entry;
    },
    { nonempty: true },
  );
  canonicalSetValue(
    mapValue(checkpoint, 4),
    "Recovery Credentials",
    (entry, index) => {
      validateRecoveryCredentialDescriptor(entry, `Recovery Credential ${index}`);
      return entry;
    },
    { nonempty: true },
  );
  canonicalSetValue(mapValue(checkpoint, 5), "Active Invitations", (entry, index) => {
    const invitation = exactMap(entry, [0, 1, 2, 3, 4, 5, 6], `Active Invitation ${index}`);
    identifierValue(mapValue(invitation, 0), "Invitation", "Active Invitation ID");
    publicKey(mapValue(invitation, 1), "Invitation Redemption verifier");
    publicKey(mapValue(invitation, 2), "Invitation Cancellation verifier");
    validateInvitationCapabilities(mapValue(invitation, 3));
    cause(mapValue(invitation, 4), "Invitation creation Record ID");
    fixedBytes(mapValue(invitation, 5), 32, "Invitation Redemption Authority ID");
    publicKey(mapValue(invitation, 6), "Invitation receipt verification key");
    return entry;
  });
  canonicalSetValue(
    mapValue(checkpoint, 6),
    "Key Epoch summaries",
    (entry, index) => {
      const epoch = exactMap(entry, [0, 1, 2], `Key Epoch summary ${index}`);
      identifierValue(mapValue(epoch, 0), "KeyEpoch", "Key Epoch ID");
      nonnegativeInteger(mapValue(epoch, 1), "Key Epoch display number");
      booleanValue(mapValue(epoch, 2), "Key Epoch current marker");
      return entry;
    },
    { nonempty: true },
  );
  const keyEnvelopeIds = validateKeyEnvelopeSlots(
    mapValue(checkpoint, 7),
    "Checkpoint Key Envelope slots",
    true,
  );
  canonicalSetValue(mapValue(checkpoint, 8), "Active Authority Conflicts", (entry, index) => {
    validateAuthorityConflict(entry, index);
    return entry;
  });
  canonicalSetValue(mapValue(checkpoint, 9), "Active Authority fences", (entry, index) => {
    const fence = exactMap(entry, [0, 1, 2], `Authority fence ${index}`);
    nonnegativeInteger(mapValue(fence, 0), "Authority fence kind");
    fixedBytes(mapValue(fence, 1), 32, "Authority fence subject ID");
    causeSet(mapValue(fence, 2), "Authority fence Cause Record IDs");
    return entry;
  });
  return keyEnvelopeIds.map((id) => ({ type: DEPENDENCY_TYPES.KeyEnvelope, id }));
}

function validateAuthorityConflict(value: CanonicalValue, index: number): void {
  const conflict = exactMap(value, [0, 1, 2], `Authority Conflict ${index}`);
  const kind = oneOfCodes(mapValue(conflict, 0), [1, 2, 3, 4] as const, "Authority Conflict kind");
  if (kind === 1) identifierValue(mapValue(conflict, 1), "Invitation", "Conflict Invitation ID");
  else if (kind === 3) identifierValue(mapValue(conflict, 1), "Vault", "Conflict Vault ID");
  else identifierValue(mapValue(conflict, 1), "Member", "Conflict Member ID");
  canonicalSetValue(
    mapValue(conflict, 2),
    "Authority Conflict candidates",
    (entry, candidateIndex) => {
      const keys = kind === 1 ? [0, 1, 2, 3, 4] : [0, 1];
      const candidate = exactMap(entry, keys, `Authority Conflict candidate ${candidateIndex}`);
      cause(mapValue(candidate, 0), "Authority Conflict head Record ID");
      if (kind === 1) {
        const outcome = oneOfCodes(mapValue(candidate, 1), [1, 2] as const, "Invitation outcome");
        fixedBytes(mapValue(candidate, 2), 32, "Invitation Authority Receipt ID");
        nullable(mapValue(candidate, 3), (request) => fixedBytes(request, 32, "Join Request ID"));
        nullable(mapValue(candidate, 4), (member) =>
          identifierValue(member, "Member", "Candidate Member ID"),
        );
        if (
          (outcome === 1) !==
          (mapValue(candidate, 3) !== null && mapValue(candidate, 4) !== null)
        ) {
          throw new TypeError("Invitation Conflict candidate fields do not match its outcome");
        }
      } else if (kind === 2) {
        identifierValue(mapValue(candidate, 1), "RecoveryCredential", "Recovery candidate ID");
      } else if (kind === 3) {
        identifierValue(mapValue(candidate, 1), "KeyEpoch", "Key Epoch candidate ID");
      } else {
        booleanValue(mapValue(candidate, 1), "Administrator candidate state");
      }
      return entry;
    },
    { nonempty: true },
  );
}

function fixedBytes(value: CanonicalValue, length: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new TypeError(`${field} must contain exactly ${length} bytes`);
  }
  return value;
}

function publicKey(value: CanonicalValue, field: string): void {
  fixedBytes(value, 32, field);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertRequirements(
  requirements: readonly BaselineDependencyRequirement[],
  dependencies: readonly TypedDependency[],
): void {
  for (const requirement of requirements) {
    if (
      !dependencies.some(
        (candidate) =>
          candidate.type === requirement.type && bytesEqual(candidate.id, requirement.id),
      )
    ) {
      throw new TypeError("Baseline dependencies omit a checkpointed authoritative item");
    }
  }
}

export function validateVaultBaselineBody(
  value: CanonicalValue,
  context: BaselineBodyContext,
): void {
  assertRequirements(vaultBaselineDependencyRequirements(value), context.dependencies);
}

export function vaultBaselineDependencyRequirements(
  value: CanonicalValue,
): readonly BaselineDependencyRequirement[] {
  const body = exactMap(value, [0, 1, 2, 3, 4, 5], "Vault Baseline body");
  exactCode(mapValue(body, 0), 1, "Vault Baseline body format");
  const kind = oneOfCodes(mapValue(body, 1), [1, 2] as const, "Vault Baseline kind");
  const contentRequirements = validateContentCheckpoint(mapValue(body, 2));
  const authorityRequirements = validateAuthorityCheckpoint(mapValue(body, 3));
  const lifecycle = exactMap(mapValue(body, 4), [0], "Lifecycle checkpoint");
  exactCode(mapValue(lifecycle, 0), 1, "Lifecycle checkpoint state");
  const commitment = nullable(mapValue(body, 5), (entry) => {
    const predecessor = exactMap(entry, [0, 1, 2], "Predecessor commitment");
    identifierValue(mapValue(predecessor, 0), "Generation", "Predecessor Generation ID");
    idSetValue(mapValue(predecessor, 1), "VaultRecord", "Predecessor Frontier", {
      nonempty: true,
    });
    fixedBytes(mapValue(predecessor, 2), 32, "Predecessor state digest");
    return predecessor;
  });
  if ((kind === 1) !== (commitment === null)) {
    throw new TypeError("Baseline kind and predecessor commitment do not match");
  }
  return [...contentRequirements, ...authorityRequirements];
}

export function contentCheckpointCauseIds(
  value: CanonicalValue,
): readonly Identifier<"VaultRecord">[] {
  const checkpoint = exactMap(value, [...Array(10).keys()], "Content checkpoint");
  exactCode(mapValue(checkpoint, 0), 1, "Content checkpoint format");
  const found = new Map<string, Identifier<"VaultRecord">>();
  const add = (causeId: Identifier<"VaultRecord">): void => {
    found.set(hex(causeId), causeId);
  };
  const addOne = (causeValue: CanonicalValue, field: string): void => {
    add(identifierValue(causeValue, "VaultRecord", field));
  };
  const addSet = (causeValue: CanonicalValue, field: string): void => {
    for (const causeId of idSetValue(causeValue, "VaultRecord", field)) add(causeId);
  };
  const addRedirect = (redirectValue: CanonicalValue, field: string): void => {
    nullable(redirectValue, (entry) => {
      const redirect = exactMap(entry, [0, 1], field);
      addOne(mapValue(redirect, 1), `${field} Cause ID`);
      return entry;
    });
  };
  const addTail = (tailValue: CanonicalValue, field: string): void => {
    nullable(tailValue, (entry) => {
      const tail = exactMap(entry, [0, 1], field);
      addOne(mapValue(tail, 1), `${field} Cause ID`);
      return entry;
    });
  };

  const vaultLabel = exactMap(mapValue(checkpoint, 1), [0, 1], "Checkpointed Vault label");
  addSet(mapValue(vaultLabel, 1), "Vault label Cause IDs");
  for (const entry of canonicalSetValue(
    mapValue(checkpoint, 2),
    "Credential labels",
    (item) => item,
  )) {
    const labelEntry = exactMap(entry, [0, 1, 2], "Credential label");
    addSet(mapValue(labelEntry, 2), "Credential label Cause IDs");
  }
  for (const entry of canonicalSetValue(mapValue(checkpoint, 3), "Captures", (item) => item)) {
    const capture = exactMap(entry, [...Array(8).keys()], "Checkpointed Capture");
    addSet(mapValue(capture, 3), "Capture assignment Cause IDs");
    addSet(mapValue(capture, 5), "Capture lifecycle Cause IDs");
    addOne(mapValue(capture, 6), "Capture registration Cause ID");
  }
  for (const entry of canonicalSetValue(mapValue(checkpoint, 4), "Collections", (item) => item)) {
    const collection = exactMap(entry, [...Array(8).keys()], "Checkpointed Collection");
    addSet(mapValue(collection, 2), "Collection title Cause IDs");
    addSet(mapValue(collection, 4), "Collection Folder Cause IDs");
    addRedirect(mapValue(collection, 5), "Collection redirect");
    addTail(mapValue(collection, 6), "Intrinsic Collection tail");
    addTail(mapValue(collection, 7), "Effective Collection tail");
  }
  for (const entry of canonicalSetValue(mapValue(checkpoint, 5), "Folders", (item) => item)) {
    const folder = exactMap(entry, [...Array(7).keys()], "Checkpointed Folder");
    addSet(mapValue(folder, 2), "Folder name Cause IDs");
    addSet(mapValue(folder, 4), "Folder parent Cause IDs");
    addSet(mapValue(folder, 6), "Folder lifecycle Cause IDs");
  }
  for (const entry of canonicalSetValue(mapValue(checkpoint, 6), "Tags", (item) => item)) {
    const tag = exactMap(entry, [...Array(6).keys()], "Checkpointed Tag");
    addSet(mapValue(tag, 2), "Tag name Cause IDs");
    addRedirect(mapValue(tag, 3), "Tag redirect");
    addSet(mapValue(tag, 5), "Tag lifecycle Cause IDs");
  }
  for (const entry of canonicalSetValue(
    mapValue(checkpoint, 7),
    "Tag assignments",
    (item) => item,
  )) {
    const assignment = exactMap(entry, [0, 1, 2, 3], "Checkpointed Tag assignment");
    addOne(mapValue(assignment, 1), "Tag assignment Cause ID");
  }
  for (const entry of canonicalSetValue(mapValue(checkpoint, 8), "Notes", (item) => item)) {
    const note = exactMap(entry, [0, 1, 2, 3], "Checkpointed Note");
    for (const versionValue of canonicalSetValue(
      mapValue(note, 3),
      "Note versions",
      (item) => item,
    )) {
      const version = exactMap(versionValue, [0, 1, 2, 3], "Checkpointed Note version");
      addOne(mapValue(version, 0), "Note head Cause ID");
    }
  }
  for (const entry of canonicalSetValue(
    mapValue(checkpoint, 9),
    "Content Conflicts",
    (item) => item,
  )) {
    const conflict = exactMap(entry, [0, 1, 2], "Content Conflict");
    for (const candidateValue of canonicalSetValue(
      mapValue(conflict, 2),
      "Content Conflict candidates",
      (item) => item,
    )) {
      const candidate = exactMap(candidateValue, [0, 1], "Content Conflict candidate");
      addOne(mapValue(candidate, 0), "Content Conflict candidate Cause ID");
    }
  }
  return canonicalSet([...found.values()]);
}
