import type { CanonicalPrimaryCaptureInput } from "../runtime/capture/canonical-prepare";
import type { CanonicalClientRuntime } from "../runtime/client/canonical-runtime";

export type CanonicalApplicationRequest =
  | { readonly type: "GetState" }
  | {
      readonly type: "BeginVaultCreation";
      readonly expectedVaultId: string | null;
      readonly label: string | null;
    }
  | {
      readonly type: "ConfirmVaultCreation";
      readonly setupId: string;
      readonly recoveryPhrase: string;
    }
  | { readonly type: "CancelVaultCreation"; readonly setupId: string }
  | {
      readonly type: "SelectVault";
      readonly expectedVaultId: string | null;
      readonly vaultId: string;
    }
  | {
      readonly type: "CaptureActivePage";
      readonly expectedVaultId: string;
      readonly tabId?: number;
    }
  | { readonly type: "BeginVaultFork"; readonly expectedVaultId: string }
  | {
      readonly type: "ConfirmVaultFork";
      readonly setupId: string;
      readonly recoveryPhrase: string;
    }
  | { readonly type: "CancelVaultFork"; readonly setupId: string }
  | {
      readonly type: "RecoverMember";
      readonly expectedVaultId: string;
      readonly recoveryPhrase: string;
    }
  | {
      readonly type: "RecoverHostedMember";
      readonly endpoint: string;
      readonly username: string;
      readonly password: string;
      readonly recoveryPhrase: string;
    }
  | { readonly type: "BeginRecoveryPhraseReplacement"; readonly expectedVaultId: string }
  | {
      readonly type: "ConfirmRecoveryPhraseReplacement";
      readonly setupId: string;
      readonly recoveryPhrase: string;
    }
  | { readonly type: "CancelRecoveryPhraseReplacement"; readonly setupId: string }
  | { readonly type: "CloseVault"; readonly expectedVaultId: string }
  | { readonly type: "VacuumVault"; readonly expectedVaultId: string }
  | { readonly type: "ListLibrary"; readonly expectedVaultId: string }
  | { readonly type: "ListRemotes"; readonly expectedVaultId: string }
  | {
      readonly type: "RenameRemote";
      readonly expectedVaultId: string;
      readonly remoteId: string;
      readonly name: string;
    }
  | {
      readonly type: "SetRemoteEnabled";
      readonly expectedVaultId: string;
      readonly remoteId: string;
      readonly enabled: boolean;
    }
  | {
      readonly type: "RetireRemote";
      readonly expectedVaultId: string;
      readonly remoteId: string;
    }
  | {
      readonly type: "CreateHostedReplica";
      readonly expectedVaultId: string;
      readonly endpoint: string;
      readonly name: string;
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly type: "BeginHostedReplicaAttachment";
      readonly expectedVaultId: string;
      readonly endpoint: string;
      readonly name: string;
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly type: "ConfirmHostedReplicaAttachment";
      readonly expectedVaultId: string;
      readonly setupId: string;
      readonly replicaHandle: string;
    }
  | { readonly type: "CancelHostedReplicaAttachment"; readonly setupId: string }
  | {
      readonly type: "MaterializeHostedReplica";
      readonly expectedVaultId: string;
      readonly remoteId: string;
    }
  | { readonly type: "PullHostedReplicas"; readonly expectedVaultId: string }
  | {
      readonly type: "HydrateArtifact";
      readonly expectedVaultId: string;
      readonly artifactId: string;
    }
  | CanonicalContentApplicationRequest;

type CanonicalContentApplicationRequest =
  | {
      readonly type: "Search";
      readonly expectedVaultId: string;
      readonly query: string;
      readonly scope: "Active" | "Deleted";
      readonly hosts: readonly string[];
      readonly collectionIds: readonly string[];
      readonly tagIds: readonly string[];
      readonly capturedFrom?: number;
      readonly capturedBefore?: number;
    }
  | { readonly type: "SearchCoverage"; readonly expectedVaultId: string }
  | { readonly type: "ListCollections"; readonly expectedVaultId: string }
  | { readonly type: "ListFolders"; readonly expectedVaultId: string }
  | { readonly type: "ListTags"; readonly expectedVaultId: string }
  | { readonly type: "ListTagAssignments"; readonly expectedVaultId: string }
  | { readonly type: "ListNotes"; readonly expectedVaultId: string }
  | { readonly type: "ListLibraryConflicts"; readonly expectedVaultId: string }
  | {
      readonly type: "CreateFolder";
      readonly expectedVaultId: string;
      readonly name: string;
      readonly parentFolderId: string | null;
    }
  | {
      readonly type: "RenameFolder";
      readonly expectedVaultId: string;
      readonly folderId: string;
      readonly name: string;
    }
  | {
      readonly type: "PlaceFolder";
      readonly expectedVaultId: string;
      readonly folderId: string;
      readonly parentFolderId: string | null;
    }
  | { readonly type: "DeleteFolder"; readonly expectedVaultId: string; readonly folderId: string }
  | { readonly type: "RestoreFolder"; readonly expectedVaultId: string; readonly folderId: string }
  | {
      readonly type: "PlaceCollectionInFolder";
      readonly expectedVaultId: string;
      readonly collectionId: string;
      readonly folderId: string | null;
    }
  | {
      readonly type: "ResolveFolderConflict";
      readonly expectedVaultId: string;
      readonly subjectFolderIds: readonly string[];
      readonly conflictingCauseIds: readonly string[];
      readonly placements: readonly {
        readonly folderId: string;
        readonly parentFolderId: string | null;
      }[];
    }
  | {
      readonly type: "SetCollectionTitle";
      readonly expectedVaultId: string;
      readonly collectionId: string;
      readonly title: string | null;
    }
  | {
      readonly type: "MergeCollections";
      readonly expectedVaultId: string;
      readonly sourceCollectionIds: readonly string[];
      readonly destinationCollectionId: string;
    }
  | {
      readonly type: "RevertCollectionMerge";
      readonly expectedVaultId: string;
      readonly redirectCauseId: string;
    }
  | {
      readonly type: "ResolveCollectionMergeConflict";
      readonly expectedVaultId: string;
      readonly subjectCollectionIds: readonly string[];
      readonly conflictingCauseIds: readonly string[];
      readonly redirects: readonly {
        readonly sourceCollectionId: string;
        readonly destinationCollectionId: string;
      }[];
    }
  | {
      readonly type: "MoveCaptures";
      readonly expectedVaultId: string;
      readonly bundleIds: readonly string[];
      readonly destinationCollectionId: string;
    }
  | {
      readonly type: "DeleteCaptures";
      readonly expectedVaultId: string;
      readonly bundleIds: readonly string[];
    }
  | {
      readonly type: "RestoreCaptures";
      readonly expectedVaultId: string;
      readonly bundleIds: readonly string[];
    }
  | { readonly type: "CreateTag"; readonly expectedVaultId: string; readonly name: string }
  | {
      readonly type: "RenameTag";
      readonly expectedVaultId: string;
      readonly tagId: string;
      readonly name: string;
    }
  | {
      readonly type: "AssignTag";
      readonly expectedVaultId: string;
      readonly tagId: string;
      readonly targetKind: "Collection" | "Capture";
      readonly targetId: string;
    }
  | {
      readonly type: "RemoveTagAssignments";
      readonly expectedVaultId: string;
      readonly tagId: string;
      readonly targetKind: "Collection" | "Capture";
      readonly targetId: string;
    }
  | { readonly type: "DeleteTag"; readonly expectedVaultId: string; readonly tagId: string }
  | { readonly type: "RestoreTag"; readonly expectedVaultId: string; readonly tagId: string }
  | {
      readonly type: "MergeTags";
      readonly expectedVaultId: string;
      readonly sourceTagIds: readonly string[];
      readonly destinationTagId: string;
    }
  | {
      readonly type: "RevertTagMerge";
      readonly expectedVaultId: string;
      readonly redirectCauseId: string;
    }
  | {
      readonly type: "ResolveTagMergeConflict";
      readonly expectedVaultId: string;
      readonly subjectTagIds: readonly string[];
      readonly conflictingCauseIds: readonly string[];
      readonly redirects: readonly {
        readonly sourceTagId: string;
        readonly destinationTagId: string;
      }[];
    }
  | {
      readonly type: "CreateNote";
      readonly expectedVaultId: string;
      readonly targetKind: "Collection" | "Capture";
      readonly targetId: string;
      readonly title: string | null;
      readonly body: string;
    }
  | {
      readonly type: "ReviseNote";
      readonly expectedVaultId: string;
      readonly noteId: string;
      readonly title: string | null;
      readonly body: string;
    }
  | { readonly type: "DeleteNote"; readonly expectedVaultId: string; readonly noteId: string }
  | { readonly type: "RestoreNote"; readonly expectedVaultId: string; readonly noteId: string }
  | {
      readonly type: "ResolveNoteConflict";
      readonly expectedVaultId: string;
      readonly noteId: string;
      readonly conflictingCauseIds: readonly string[];
      readonly retainedOriginal: { readonly title: string | null; readonly body: string } | null;
      readonly splitNotes: readonly { readonly title: string | null; readonly body: string }[];
    };

type CanonicalApplicationRuntime = Pick<
  CanonicalClientRuntime,
  | "state"
  | "beginVaultCreation"
  | "confirmVaultCreation"
  | "cancelVaultCreation"
  | "selectVault"
  | "capture"
  | "beginVaultFork"
  | "confirmVaultFork"
  | "cancelVaultFork"
  | "recoverMember"
  | "recoverHostedMember"
  | "beginRecoveryPhraseReplacement"
  | "confirmRecoveryPhraseReplacement"
  | "cancelRecoveryPhraseReplacement"
  | "closeVault"
  | "vacuumVault"
  | "listLibrary"
  | "listRemotes"
  | "renameRemote"
  | "setRemoteEnabled"
  | "retireRemote"
  | "createHostedReplica"
  | "beginHostedReplicaAttachment"
  | "confirmHostedReplicaAttachment"
  | "cancelHostedReplicaAttachment"
  | "materializeHostedReplica"
  | "pullHostedReplicas"
  | "hydrateArtifact"
> &
  Partial<
    Pick<
      CanonicalClientRuntime,
      | "search"
      | "searchCoverage"
      | "listCollections"
      | "listFolders"
      | "listTags"
      | "listTagAssignments"
      | "listNotes"
      | "listLibraryConflicts"
      | "createFolder"
      | "renameFolder"
      | "placeFolder"
      | "deleteFolder"
      | "restoreFolder"
      | "placeCollectionInFolder"
      | "resolveFolderConflict"
      | "setCollectionTitle"
      | "mergeCollections"
      | "revertCollectionMerge"
      | "resolveCollectionMergeConflict"
      | "moveCaptures"
      | "deleteCaptures"
      | "restoreCaptures"
      | "createTag"
      | "renameTag"
      | "assignTag"
      | "removeTagAssignments"
      | "deleteTag"
      | "restoreTag"
      | "createNote"
      | "reviseNote"
      | "deleteNote"
      | "restoreNote"
      | "resolveNoteConflict"
    >
  >;

const contentRuntimeMethods = {
  Search: "search",
  SearchCoverage: "searchCoverage",
  ListCollections: "listCollections",
  ListFolders: "listFolders",
  ListTags: "listTags",
  ListTagAssignments: "listTagAssignments",
  ListNotes: "listNotes",
  ListLibraryConflicts: "listLibraryConflicts",
  CreateFolder: "createFolder",
  RenameFolder: "renameFolder",
  PlaceFolder: "placeFolder",
  DeleteFolder: "deleteFolder",
  RestoreFolder: "restoreFolder",
  PlaceCollectionInFolder: "placeCollectionInFolder",
  SetCollectionTitle: "setCollectionTitle",
  MergeCollections: "mergeCollections",
  RevertCollectionMerge: "revertCollectionMerge",
  MoveCaptures: "moveCaptures",
  DeleteCaptures: "deleteCaptures",
  RestoreCaptures: "restoreCaptures",
  CreateTag: "createTag",
  RenameTag: "renameTag",
  AssignTag: "assignTag",
  RemoveTagAssignments: "removeTagAssignments",
  DeleteTag: "deleteTag",
  RestoreTag: "restoreTag",
  MergeTags: "mergeTags",
  RevertTagMerge: "revertTagMerge",
  CreateNote: "createNote",
  ReviseNote: "reviseNote",
  DeleteNote: "deleteNote",
  RestoreNote: "restoreNote",
  ResolveFolderConflict: "resolveFolderConflict",
  ResolveCollectionMergeConflict: "resolveCollectionMergeConflict",
  ResolveTagMergeConflict: "resolveTagMergeConflict",
  ResolveNoteConflict: "resolveNoteConflict",
} as const;

const contentReadRuntimeMethods = new Set<keyof typeof contentRuntimeMethods>([
  "SearchCoverage",
  "ListCollections",
  "ListFolders",
  "ListTags",
  "ListTagAssignments",
  "ListNotes",
  "ListLibraryConflicts",
]);

function typeToRuntimeMethod(type: keyof typeof contentRuntimeMethods): string {
  return contentRuntimeMethods[type];
}

interface CanonicalApplicationPageCapture {
  captureActivePage(tabId?: number): Promise<{
    readonly originalUrl: string;
    readonly finalUrl: string;
    readonly title: string;
    readonly capturedAt: number;
    readonly primary: CanonicalPrimaryCaptureInput;
  }>;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function text(value: unknown): value is string {
  return typeof value === "string";
}

function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}

function tabId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function targetKind(value: unknown): value is "Collection" | "Capture" {
  return value === "Collection" || value === "Capture";
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function contentRecordArray(
  value: unknown,
  keys: readonly string[],
  validate: (entry: Readonly<Record<string, unknown>>) => boolean,
): value is readonly Readonly<Record<string, unknown>>[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => plainRecord(entry) && exactKeys(entry, keys) && validate(entry))
  );
}

export function decodeCanonicalApplicationRequest(value: unknown): CanonicalApplicationRequest {
  if (!plainRecord(value) || !text(value.type)) {
    throw new TypeError("Unsupported application Command");
  }
  switch (value.type) {
    case "GetState":
      if (exactKeys(value, ["type"])) return { type: value.type };
      break;
    case "BeginVaultCreation":
      if (
        exactKeys(value, ["type", "expectedVaultId", "label"]) &&
        nullableText(value.expectedVaultId) &&
        nullableText(value.label)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          label: value.label,
        };
      }
      break;
    case "ConfirmVaultCreation":
      if (
        exactKeys(value, ["type", "setupId", "recoveryPhrase"]) &&
        text(value.setupId) &&
        text(value.recoveryPhrase)
      ) {
        return { type: value.type, setupId: value.setupId, recoveryPhrase: value.recoveryPhrase };
      }
      break;
    case "CancelVaultCreation":
      if (exactKeys(value, ["type", "setupId"]) && text(value.setupId)) {
        return { type: value.type, setupId: value.setupId };
      }
      break;
    case "SelectVault":
      if (
        exactKeys(value, ["type", "expectedVaultId", "vaultId"]) &&
        nullableText(value.expectedVaultId) &&
        text(value.vaultId)
      ) {
        return { type: value.type, expectedVaultId: value.expectedVaultId, vaultId: value.vaultId };
      }
      break;
    case "CaptureActivePage":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
        };
      }
      if (
        exactKeys(value, ["type", "expectedVaultId", "tabId"]) &&
        text(value.expectedVaultId) &&
        tabId(value.tabId)
      ) {
        return { type: value.type, expectedVaultId: value.expectedVaultId, tabId: value.tabId };
      }
      break;
    case "BeginVaultFork":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "ConfirmVaultFork":
      if (
        exactKeys(value, ["type", "setupId", "recoveryPhrase"]) &&
        text(value.setupId) &&
        text(value.recoveryPhrase)
      ) {
        return { type: value.type, setupId: value.setupId, recoveryPhrase: value.recoveryPhrase };
      }
      break;
    case "CancelVaultFork":
      if (exactKeys(value, ["type", "setupId"]) && text(value.setupId)) {
        return { type: value.type, setupId: value.setupId };
      }
      break;
    case "RecoverMember":
      if (
        exactKeys(value, ["type", "expectedVaultId", "recoveryPhrase"]) &&
        text(value.expectedVaultId) &&
        text(value.recoveryPhrase)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          recoveryPhrase: value.recoveryPhrase,
        };
      }
      break;
    case "RecoverHostedMember":
      if (
        exactKeys(value, ["type", "endpoint", "username", "password", "recoveryPhrase"]) &&
        text(value.endpoint) &&
        text(value.username) &&
        text(value.password) &&
        text(value.recoveryPhrase)
      ) {
        return {
          type: value.type,
          endpoint: value.endpoint,
          username: value.username,
          password: value.password,
          recoveryPhrase: value.recoveryPhrase,
        };
      }
      break;
    case "BeginRecoveryPhraseReplacement":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "ConfirmRecoveryPhraseReplacement":
      if (
        exactKeys(value, ["type", "setupId", "recoveryPhrase"]) &&
        text(value.setupId) &&
        text(value.recoveryPhrase)
      ) {
        return { type: value.type, setupId: value.setupId, recoveryPhrase: value.recoveryPhrase };
      }
      break;
    case "CancelRecoveryPhraseReplacement":
      if (exactKeys(value, ["type", "setupId"]) && text(value.setupId)) {
        return { type: value.type, setupId: value.setupId };
      }
      break;
    case "CloseVault":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "VacuumVault":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "ListLibrary":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "ListRemotes":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "RenameRemote":
      if (
        exactKeys(value, ["type", "expectedVaultId", "remoteId", "name"]) &&
        text(value.expectedVaultId) &&
        text(value.remoteId) &&
        text(value.name)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          remoteId: value.remoteId,
          name: value.name,
        };
      }
      break;
    case "SetRemoteEnabled":
      if (
        exactKeys(value, ["type", "expectedVaultId", "remoteId", "enabled"]) &&
        text(value.expectedVaultId) &&
        text(value.remoteId) &&
        typeof value.enabled === "boolean"
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          remoteId: value.remoteId,
          enabled: value.enabled,
        };
      }
      break;
    case "RetireRemote":
      if (
        exactKeys(value, ["type", "expectedVaultId", "remoteId"]) &&
        text(value.expectedVaultId) &&
        text(value.remoteId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          remoteId: value.remoteId,
        };
      }
      break;
    case "CreateHostedReplica":
      if (
        exactKeys(value, ["type", "expectedVaultId", "endpoint", "name", "username", "password"]) &&
        text(value.expectedVaultId) &&
        text(value.endpoint) &&
        text(value.name) &&
        text(value.username) &&
        text(value.password)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          endpoint: value.endpoint,
          name: value.name,
          username: value.username,
          password: value.password,
        };
      }
      break;
    case "BeginHostedReplicaAttachment":
      if (
        exactKeys(value, ["type", "expectedVaultId", "endpoint", "name", "username", "password"]) &&
        text(value.expectedVaultId) &&
        text(value.endpoint) &&
        text(value.name) &&
        text(value.username) &&
        text(value.password)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          endpoint: value.endpoint,
          name: value.name,
          username: value.username,
          password: value.password,
        };
      }
      break;
    case "ConfirmHostedReplicaAttachment":
      if (
        exactKeys(value, ["type", "expectedVaultId", "setupId", "replicaHandle"]) &&
        text(value.expectedVaultId) &&
        text(value.setupId) &&
        text(value.replicaHandle)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          setupId: value.setupId,
          replicaHandle: value.replicaHandle,
        };
      }
      break;
    case "CancelHostedReplicaAttachment":
      if (exactKeys(value, ["type", "setupId"]) && text(value.setupId)) {
        return { type: value.type, setupId: value.setupId };
      }
      break;
    case "MaterializeHostedReplica":
      if (
        exactKeys(value, ["type", "expectedVaultId", "remoteId"]) &&
        text(value.expectedVaultId) &&
        text(value.remoteId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          remoteId: value.remoteId,
        };
      }
      break;
    case "PullHostedReplicas":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "HydrateArtifact":
      if (
        exactKeys(value, ["type", "expectedVaultId", "artifactId"]) &&
        text(value.expectedVaultId) &&
        text(value.artifactId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          artifactId: value.artifactId,
        };
      }
      break;
    case "Search": {
      const optionalKeys = [
        ...(Object.hasOwn(value, "capturedFrom") ? ["capturedFrom"] : []),
        ...(Object.hasOwn(value, "capturedBefore") ? ["capturedBefore"] : []),
      ];
      if (
        exactKeys(value, [
          "type",
          "expectedVaultId",
          "query",
          "scope",
          "hosts",
          "collectionIds",
          "tagIds",
          ...optionalKeys,
        ]) &&
        text(value.expectedVaultId) &&
        text(value.query) &&
        (value.scope === "Active" || value.scope === "Deleted") &&
        stringArray(value.hosts) &&
        stringArray(value.collectionIds) &&
        stringArray(value.tagIds) &&
        (!Object.hasOwn(value, "capturedFrom") || nonnegativeNumber(value.capturedFrom)) &&
        (!Object.hasOwn(value, "capturedBefore") || nonnegativeNumber(value.capturedBefore))
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          query: value.query,
          scope: value.scope,
          hosts: value.hosts,
          collectionIds: value.collectionIds,
          tagIds: value.tagIds,
          ...(Object.hasOwn(value, "capturedFrom")
            ? { capturedFrom: value.capturedFrom as number }
            : {}),
          ...(Object.hasOwn(value, "capturedBefore")
            ? { capturedBefore: value.capturedBefore as number }
            : {}),
        };
      }
      break;
    }
    case "SearchCoverage":
    case "ListCollections":
    case "ListFolders":
    case "ListTags":
    case "ListTagAssignments":
    case "ListNotes":
    case "ListLibraryConflicts":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "CreateFolder":
      if (
        exactKeys(value, ["type", "expectedVaultId", "name", "parentFolderId"]) &&
        text(value.expectedVaultId) &&
        text(value.name) &&
        nullableText(value.parentFolderId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          name: value.name,
          parentFolderId: value.parentFolderId,
        };
      }
      break;
    case "RenameFolder":
      if (
        exactKeys(value, ["type", "expectedVaultId", "folderId", "name"]) &&
        text(value.expectedVaultId) &&
        text(value.folderId) &&
        text(value.name)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          folderId: value.folderId,
          name: value.name,
        };
      }
      break;
    case "PlaceFolder":
      if (
        exactKeys(value, ["type", "expectedVaultId", "folderId", "parentFolderId"]) &&
        text(value.expectedVaultId) &&
        text(value.folderId) &&
        nullableText(value.parentFolderId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          folderId: value.folderId,
          parentFolderId: value.parentFolderId,
        };
      }
      break;
    case "DeleteFolder":
    case "RestoreFolder":
      if (
        exactKeys(value, ["type", "expectedVaultId", "folderId"]) &&
        text(value.expectedVaultId) &&
        text(value.folderId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          folderId: value.folderId,
        };
      }
      break;
    case "PlaceCollectionInFolder":
      if (
        exactKeys(value, ["type", "expectedVaultId", "collectionId", "folderId"]) &&
        text(value.expectedVaultId) &&
        text(value.collectionId) &&
        nullableText(value.folderId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          collectionId: value.collectionId,
          folderId: value.folderId,
        };
      }
      break;
    case "SetCollectionTitle":
      if (
        exactKeys(value, ["type", "expectedVaultId", "collectionId", "title"]) &&
        text(value.expectedVaultId) &&
        text(value.collectionId) &&
        nullableText(value.title)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          collectionId: value.collectionId,
          title: value.title,
        };
      }
      break;
    case "MergeCollections":
      if (
        exactKeys(value, [
          "type",
          "expectedVaultId",
          "sourceCollectionIds",
          "destinationCollectionId",
        ]) &&
        text(value.expectedVaultId) &&
        stringArray(value.sourceCollectionIds) &&
        text(value.destinationCollectionId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          sourceCollectionIds: value.sourceCollectionIds,
          destinationCollectionId: value.destinationCollectionId,
        };
      }
      break;
    case "RevertCollectionMerge":
      if (
        exactKeys(value, ["type", "expectedVaultId", "redirectCauseId"]) &&
        text(value.expectedVaultId) &&
        text(value.redirectCauseId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          redirectCauseId: value.redirectCauseId,
        };
      }
      break;
    case "MoveCaptures":
      if (
        exactKeys(value, ["type", "expectedVaultId", "bundleIds", "destinationCollectionId"]) &&
        text(value.expectedVaultId) &&
        stringArray(value.bundleIds) &&
        text(value.destinationCollectionId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          bundleIds: value.bundleIds,
          destinationCollectionId: value.destinationCollectionId,
        };
      }
      break;
    case "DeleteCaptures":
    case "RestoreCaptures":
      if (
        exactKeys(value, ["type", "expectedVaultId", "bundleIds"]) &&
        text(value.expectedVaultId) &&
        stringArray(value.bundleIds)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          bundleIds: value.bundleIds,
        };
      }
      break;
    case "ResolveCollectionMergeConflict":
      if (
        exactKeys(value, [
          "type",
          "expectedVaultId",
          "subjectCollectionIds",
          "conflictingCauseIds",
          "redirects",
        ]) &&
        text(value.expectedVaultId) &&
        stringArray(value.subjectCollectionIds) &&
        stringArray(value.conflictingCauseIds) &&
        contentRecordArray(
          value.redirects,
          ["sourceCollectionId", "destinationCollectionId"],
          (entry) => text(entry.sourceCollectionId) && text(entry.destinationCollectionId),
        )
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          subjectCollectionIds: value.subjectCollectionIds,
          conflictingCauseIds: value.conflictingCauseIds,
          redirects: value.redirects as readonly {
            readonly sourceCollectionId: string;
            readonly destinationCollectionId: string;
          }[],
        };
      }
      break;
    case "ResolveFolderConflict":
      if (
        exactKeys(value, [
          "type",
          "expectedVaultId",
          "subjectFolderIds",
          "conflictingCauseIds",
          "placements",
        ]) &&
        text(value.expectedVaultId) &&
        stringArray(value.subjectFolderIds) &&
        stringArray(value.conflictingCauseIds) &&
        contentRecordArray(
          value.placements,
          ["folderId", "parentFolderId"],
          (entry) => text(entry.folderId) && nullableText(entry.parentFolderId),
        )
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          subjectFolderIds: value.subjectFolderIds,
          conflictingCauseIds: value.conflictingCauseIds,
          placements: value.placements as readonly {
            readonly folderId: string;
            readonly parentFolderId: string | null;
          }[],
        };
      }
      break;
    case "CreateTag":
      if (
        exactKeys(value, ["type", "expectedVaultId", "name"]) &&
        text(value.expectedVaultId) &&
        text(value.name)
      ) {
        return { type: value.type, expectedVaultId: value.expectedVaultId, name: value.name };
      }
      break;
    case "RenameTag":
      if (
        exactKeys(value, ["type", "expectedVaultId", "tagId", "name"]) &&
        text(value.expectedVaultId) &&
        text(value.tagId) &&
        text(value.name)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          tagId: value.tagId,
          name: value.name,
        };
      }
      break;
    case "AssignTag":
    case "RemoveTagAssignments":
      if (
        exactKeys(value, ["type", "expectedVaultId", "tagId", "targetKind", "targetId"]) &&
        text(value.expectedVaultId) &&
        text(value.tagId) &&
        targetKind(value.targetKind) &&
        text(value.targetId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          tagId: value.tagId,
          targetKind: value.targetKind,
          targetId: value.targetId,
        };
      }
      break;
    case "DeleteTag":
    case "RestoreTag":
      if (
        exactKeys(value, ["type", "expectedVaultId", "tagId"]) &&
        text(value.expectedVaultId) &&
        text(value.tagId)
      ) {
        return { type: value.type, expectedVaultId: value.expectedVaultId, tagId: value.tagId };
      }
      break;
    case "MergeTags":
      if (
        exactKeys(value, ["type", "expectedVaultId", "sourceTagIds", "destinationTagId"]) &&
        text(value.expectedVaultId) &&
        stringArray(value.sourceTagIds) &&
        text(value.destinationTagId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          sourceTagIds: value.sourceTagIds,
          destinationTagId: value.destinationTagId,
        };
      }
      break;
    case "RevertTagMerge":
      if (
        exactKeys(value, ["type", "expectedVaultId", "redirectCauseId"]) &&
        text(value.expectedVaultId) &&
        text(value.redirectCauseId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          redirectCauseId: value.redirectCauseId,
        };
      }
      break;
    case "ResolveTagMergeConflict":
      if (
        exactKeys(value, [
          "type",
          "expectedVaultId",
          "subjectTagIds",
          "conflictingCauseIds",
          "redirects",
        ]) &&
        text(value.expectedVaultId) &&
        stringArray(value.subjectTagIds) &&
        stringArray(value.conflictingCauseIds) &&
        contentRecordArray(
          value.redirects,
          ["sourceTagId", "destinationTagId"],
          (entry) => text(entry.sourceTagId) && text(entry.destinationTagId),
        )
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          subjectTagIds: value.subjectTagIds,
          conflictingCauseIds: value.conflictingCauseIds,
          redirects: value.redirects as readonly {
            readonly sourceTagId: string;
            readonly destinationTagId: string;
          }[],
        };
      }
      break;
    case "CreateNote":
      if (
        exactKeys(value, ["type", "expectedVaultId", "targetKind", "targetId", "title", "body"]) &&
        text(value.expectedVaultId) &&
        targetKind(value.targetKind) &&
        text(value.targetId) &&
        nullableText(value.title) &&
        text(value.body)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          targetKind: value.targetKind,
          targetId: value.targetId,
          title: value.title,
          body: value.body,
        };
      }
      break;
    case "ReviseNote":
      if (
        exactKeys(value, ["type", "expectedVaultId", "noteId", "title", "body"]) &&
        text(value.expectedVaultId) &&
        text(value.noteId) &&
        nullableText(value.title) &&
        text(value.body)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          noteId: value.noteId,
          title: value.title,
          body: value.body,
        };
      }
      break;
    case "DeleteNote":
    case "RestoreNote":
      if (
        exactKeys(value, ["type", "expectedVaultId", "noteId"]) &&
        text(value.expectedVaultId) &&
        text(value.noteId)
      ) {
        return { type: value.type, expectedVaultId: value.expectedVaultId, noteId: value.noteId };
      }
      break;
    case "ResolveNoteConflict":
      if (
        exactKeys(value, [
          "type",
          "expectedVaultId",
          "noteId",
          "conflictingCauseIds",
          "retainedOriginal",
          "splitNotes",
        ]) &&
        text(value.expectedVaultId) &&
        text(value.noteId) &&
        stringArray(value.conflictingCauseIds) &&
        (value.retainedOriginal === null ||
          (plainRecord(value.retainedOriginal) &&
            exactKeys(value.retainedOriginal, ["title", "body"]) &&
            nullableText(value.retainedOriginal.title) &&
            text(value.retainedOriginal.body))) &&
        contentRecordArray(
          value.splitNotes,
          ["title", "body"],
          (entry) => nullableText(entry.title) && text(entry.body),
        )
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          noteId: value.noteId,
          conflictingCauseIds: value.conflictingCauseIds,
          retainedOriginal: value.retainedOriginal as {
            readonly title: string | null;
            readonly body: string;
          } | null,
          splitNotes: value.splitNotes as readonly {
            readonly title: string | null;
            readonly body: string;
          }[],
        };
      }
      break;
  }
  throw new TypeError("Unsupported application Command");
}

export class CanonicalApplication {
  constructor(
    private readonly runtime: CanonicalApplicationRuntime,
    private readonly now: () => number = Date.now,
    private readonly pageCapture?: CanonicalApplicationPageCapture,
    private readonly createCaptureCommandId: () => string = () => crypto.randomUUID(),
    private readonly notifyStateChanged: () => void | Promise<void> = () => undefined,
  ) {}

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = await operation();
    await this.notifyStateChanged();
    return result;
  }

  private invokeContentCommand(
    type: keyof typeof contentRuntimeMethods,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const method = typeToRuntimeMethod(type) as keyof CanonicalApplicationRuntime;
    const operation = this.runtime[method];
    if (typeof operation !== "function") {
      throw Object.assign(new Error("This Client does not implement that Content Command."), {
        id: "CONTENT_COMMAND_UNAVAILABLE",
      });
    }
    const value = contentReadRuntimeMethods.has(type) ? input.expectedVaultId : input;
    return (operation as (value: unknown) => Promise<unknown>).call(this.runtime, value);
  }

  async handle(value: unknown): Promise<unknown> {
    const request = decodeCanonicalApplicationRequest(value);
    switch (request.type) {
      case "GetState":
        return this.runtime.state();
      case "BeginVaultCreation":
        return this.mutate(() =>
          this.runtime.beginVaultCreation({
            expectedVaultId: request.expectedVaultId,
            label: request.label,
            assertedAt: this.now(),
          }),
        );
      case "ConfirmVaultCreation":
        return this.mutate(() =>
          this.runtime.confirmVaultCreation({
            setupId: request.setupId,
            recoveryPhrase: request.recoveryPhrase,
          }),
        );
      case "CancelVaultCreation":
        return this.mutate(() => this.runtime.cancelVaultCreation(request.setupId));
      case "SelectVault":
        return this.mutate(() =>
          this.runtime.selectVault({
            expectedVaultId: request.expectedVaultId,
            vaultId: request.vaultId,
          }),
        );
      case "CaptureActivePage": {
        if (this.pageCapture === undefined) {
          throw Object.assign(new Error("Browser page capture is unavailable."), {
            id: "CAPTURE_UNAVAILABLE",
          });
        }
        const captured = await this.pageCapture.captureActivePage(request.tabId);
        return this.mutate(() =>
          this.runtime.capture({
            expectedVaultId: request.expectedVaultId,
            commandId: this.createCaptureCommandId(),
            ...captured,
          }),
        );
      }
      case "BeginVaultFork":
        return this.mutate(() =>
          this.runtime.beginVaultFork({
            expectedVaultId: request.expectedVaultId,
            assertedAt: this.now(),
          }),
        );
      case "ConfirmVaultFork":
        return this.mutate(() =>
          this.runtime.confirmVaultFork({
            setupId: request.setupId,
            recoveryPhrase: request.recoveryPhrase,
          }),
        );
      case "CancelVaultFork":
        return this.mutate(() => this.runtime.cancelVaultFork(request.setupId));
      case "RecoverMember":
        return this.mutate(() =>
          this.runtime.recoverMember({
            expectedVaultId: request.expectedVaultId,
            recoveryPhrase: request.recoveryPhrase,
            commandId: this.createCaptureCommandId(),
            assertedAt: this.now(),
          }),
        );
      case "RecoverHostedMember":
        return this.mutate(() =>
          this.runtime.recoverHostedMember({
            endpoint: request.endpoint,
            username: request.username,
            password: request.password,
            recoveryPhrase: request.recoveryPhrase,
            assertedAt: this.now(),
          }),
        );
      case "BeginRecoveryPhraseReplacement":
        return this.mutate(() =>
          this.runtime.beginRecoveryPhraseReplacement({
            expectedVaultId: request.expectedVaultId,
            assertedAt: this.now(),
          }),
        );
      case "ConfirmRecoveryPhraseReplacement":
        return this.mutate(() =>
          this.runtime.confirmRecoveryPhraseReplacement({
            setupId: request.setupId,
            recoveryPhrase: request.recoveryPhrase,
          }),
        );
      case "CancelRecoveryPhraseReplacement":
        return this.mutate(() => this.runtime.cancelRecoveryPhraseReplacement(request.setupId));
      case "CloseVault":
        return this.mutate(() =>
          this.runtime.closeVault({
            expectedVaultId: request.expectedVaultId,
            commandId: this.createCaptureCommandId(),
            assertedAt: this.now(),
          }),
        );
      case "VacuumVault":
        return this.mutate(() =>
          this.runtime.vacuumVault({
            expectedVaultId: request.expectedVaultId,
            commandId: this.createCaptureCommandId(),
            assertedAt: this.now(),
          }),
        );
      case "ListLibrary":
        return this.runtime.listLibrary(request.expectedVaultId);
      case "ListRemotes":
        return this.runtime.listRemotes(request.expectedVaultId);
      case "RenameRemote": {
        const { type: _type, ...input } = request;
        return this.mutate(() => this.runtime.renameRemote(input));
      }
      case "SetRemoteEnabled": {
        const { type: _type, ...input } = request;
        return this.mutate(() => this.runtime.setRemoteEnabled(input));
      }
      case "RetireRemote": {
        const { type: _type, ...input } = request;
        return this.mutate(() => this.runtime.retireRemote(input));
      }
      case "CreateHostedReplica": {
        const { type: _type, ...input } = request;
        return this.mutate(() => this.runtime.createHostedReplica(input));
      }
      case "BeginHostedReplicaAttachment": {
        const { type: _type, ...input } = request;
        return this.mutate(() => this.runtime.beginHostedReplicaAttachment(input));
      }
      case "ConfirmHostedReplicaAttachment": {
        const { type: _type, ...input } = request;
        return this.mutate(() => this.runtime.confirmHostedReplicaAttachment(input));
      }
      case "CancelHostedReplicaAttachment":
        return this.mutate(() => this.runtime.cancelHostedReplicaAttachment(request.setupId));
      case "MaterializeHostedReplica": {
        const { type: _type, ...input } = request;
        return this.mutate(() => this.runtime.materializeHostedReplica(input));
      }
      case "PullHostedReplicas":
        return this.mutate(() => this.runtime.pullHostedReplicas(request.expectedVaultId));
      case "HydrateArtifact": {
        const { type: _type, ...input } = request;
        return this.mutate(() => this.runtime.hydrateArtifact(input));
      }
      case "Search": {
        const { type: _type, ...input } = request;
        return this.invokeContentCommand("Search", input);
      }
      case "SearchCoverage":
        return this.invokeContentCommand("SearchCoverage", {
          expectedVaultId: request.expectedVaultId,
        });
      case "ListCollections":
        return this.invokeContentCommand("ListCollections", {
          expectedVaultId: request.expectedVaultId,
        });
      case "ListFolders":
        return this.invokeContentCommand("ListFolders", {
          expectedVaultId: request.expectedVaultId,
        });
      case "ListTags":
        return this.invokeContentCommand("ListTags", { expectedVaultId: request.expectedVaultId });
      case "ListTagAssignments":
        return this.invokeContentCommand("ListTagAssignments", {
          expectedVaultId: request.expectedVaultId,
        });
      case "ListNotes":
        return this.invokeContentCommand("ListNotes", { expectedVaultId: request.expectedVaultId });
      case "ListLibraryConflicts":
        return this.invokeContentCommand("ListLibraryConflicts", {
          expectedVaultId: request.expectedVaultId,
        });
      case "CreateFolder": {
        const { type: _type, ...input } = request;
        return this.mutate(() =>
          this.invokeContentCommand("CreateFolder", {
            ...input,
            commandId: this.createCaptureCommandId(),
            assertedAt: this.now(),
          }),
        );
      }
      case "RenameFolder":
      case "PlaceFolder":
      case "DeleteFolder":
      case "RestoreFolder":
      case "PlaceCollectionInFolder":
      case "SetCollectionTitle":
      case "MergeCollections":
      case "RevertCollectionMerge":
      case "MoveCaptures":
      case "DeleteCaptures":
      case "RestoreCaptures":
      case "CreateTag":
      case "RenameTag":
      case "AssignTag":
      case "RemoveTagAssignments":
      case "DeleteTag":
      case "RestoreTag":
      case "MergeTags":
      case "RevertTagMerge":
      case "CreateNote":
      case "ReviseNote":
      case "DeleteNote":
      case "RestoreNote": {
        const { type, ...input } = request;
        return this.mutate(() =>
          this.invokeContentCommand(type, {
            ...input,
            commandId: this.createCaptureCommandId(),
            assertedAt: this.now(),
          }),
        );
      }
      case "ResolveFolderConflict":
      case "ResolveCollectionMergeConflict":
      case "ResolveTagMergeConflict":
      case "ResolveNoteConflict": {
        const { type, ...input } = request;
        return this.mutate(() =>
          this.invokeContentCommand(type, {
            ...input,
            commandId: this.createCaptureCommandId(),
            assertedAt: this.now(),
          }),
        );
      }
    }
  }
}
