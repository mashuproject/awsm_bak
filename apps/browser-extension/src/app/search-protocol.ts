import { parseSearchQuery } from "../runtime/search/query";

export type SearchScope = "Active" | "Deleted";

export interface SearchFilters {
  readonly hosts: readonly string[];
  readonly collectionIds: readonly string[];
  readonly capturedFrom?: string;
  readonly capturedBefore?: string;
}

export type SearchRequest =
  | {
      readonly type: "GetSearchPassageFocus";
      readonly expectedVaultId: string;
      readonly bundleId: string;
      readonly passageId: string;
    }
  | {
      readonly type: "SearchLibrary";
      readonly expectedVaultId: string;
      readonly query: string;
      readonly clientInstanceId: string;
      readonly scope: SearchScope;
      readonly filters: SearchFilters;
      readonly pageSize: 50;
    }
  | {
      readonly type: "LoadMoreSearchResults";
      readonly expectedVaultId: string;
      readonly clientInstanceId: string;
      readonly cursor: string;
      readonly pageSize: 50;
    }
  | {
      readonly type:
        | "GetSearchState"
        | "StartSearchIndexing"
        | "PauseSearchIndexing"
        | "RebuildSearchIndex"
        | "DisableSemanticSearch"
        | "RemoveLocalSearchModel"
        | "CancelLocalSearchModelDownload";
      readonly expectedVaultId: string;
    }
  | {
      readonly type: "ConfigureLocalSearch";
      readonly expectedVaultId: string;
      readonly acceptedDisclosureVersion: 1;
    }
  | {
      readonly type: "CancelRemoteSearchProbe";
      readonly expectedVaultId: string;
    }
  | {
      readonly type: "ProbeRemoteSearchProvider";
      readonly expectedVaultId: string;
      readonly endpoint: string;
      readonly model: string;
      readonly dimensions?: number;
      readonly apiKey: string;
    }
  | {
      readonly type: "ConfigureRemoteSearch";
      readonly expectedVaultId: string;
      readonly probeId: string;
      readonly acceptedDisclosureVersion: 1;
    };

export interface SearchCoverageMessage {
  readonly eligibleCaptures: number;
  readonly keywordCaptures: number;
  readonly semanticCaptures: number;
  readonly pendingSemanticCaptures: number;
  readonly failedSemanticCaptures: number;
  readonly indexedAt?: string;
}

export interface SearchResultMessage {
  readonly bundleId: string;
  readonly collectionId: string;
  readonly collectionTitle: string;
  readonly title: string;
  readonly originalUrl: string;
  readonly host: string;
  readonly capturedAt: string;
  readonly status: SearchScope;
  readonly passageId: string;
  readonly snippet: string;
  readonly match:
    | "ExactTitle"
    | "ExactUrl"
    | "ExactPhrase"
    | "Keyword"
    | "Semantic"
    | "KeywordAndSemantic";
}

export type SearchPassageFocusMessage =
  | {
      readonly state: "Found";
      readonly text: string;
      readonly sourceRole: "CONTENT_STRUCTURED" | "TEXT_EXTRACTED" | "METADATA";
    }
  | { readonly state: "Stale" };

export interface SearchPageMessage {
  readonly results: readonly SearchResultMessage[];
  readonly nextCursor?: string;
  readonly resultCount: number;
  readonly resultCountIsComplete: boolean;
  readonly coverage: SearchCoverageMessage;
  readonly semantic:
    | { readonly state: "NotConfigured" }
    | { readonly state: "Ready"; readonly providerLabel: string }
    | { readonly state: "Partial"; readonly providerLabel: string }
    | { readonly state: "Unavailable"; readonly providerLabel: string };
}

export interface RemoteSearchProbeMessage {
  readonly probeId: string;
  readonly responseModel: string;
  readonly effectiveDimensions: number;
  readonly expiresAt: string;
}

export interface SearchStateMessage {
  readonly coverage: SearchCoverageMessage;
  readonly semantic:
    | { readonly state: "NotConfigured" }
    | {
        readonly state: "Configured";
        readonly kind: "Local" | "Remote";
        readonly providerLabel: string;
        readonly model: string;
        readonly dimensions: number;
      };
  readonly localModel:
    | { readonly state: "NotDownloaded" }
    | {
        readonly state: "Downloading";
        readonly completedBytes: number;
        readonly totalBytes: number;
      }
    | {
        readonly state: "Ready";
        readonly manifestId: string;
        readonly referenceCount: number;
      };
  readonly indexing: {
    readonly state:
      | "Idle"
      | "Running"
      | "Paused"
      | "WaitingForUnlock"
      | "WaitingForLibrary"
      | "WaitingForPermission"
      | "WaitingForNetwork"
      | "Failed";
    readonly completedCaptures: number;
    readonly totalCaptures: number;
    readonly errorId?: string;
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CLIENT_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{32}$/u;

function onlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function sortedUnique(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value)
  );
}

function canonicalHost(value: string): boolean {
  if (value !== value.toLocaleLowerCase("en-US") || value.includes(":")) return false;
  try {
    return new URL(`https://${value}/`).hostname === value;
  } catch {
    return false;
  }
}

function filters(value: unknown): value is SearchFilters {
  if (
    typeof value !== "object" ||
    value === null ||
    !onlyKeys(value, ["hosts", "collectionIds", "capturedFrom", "capturedBefore"]) ||
    !("hosts" in value) ||
    !Array.isArray(value.hosts) ||
    value.hosts.length > 100 ||
    !value.hosts.every((host) => typeof host === "string" && canonicalHost(host)) ||
    !sortedUnique(value.hosts) ||
    !("collectionIds" in value) ||
    !Array.isArray(value.collectionIds) ||
    value.collectionIds.length > 100 ||
    !value.collectionIds.every(uuid) ||
    !sortedUnique(value.collectionIds)
  )
    return false;
  if (
    "capturedFrom" in value &&
    value.capturedFrom !== undefined &&
    !canonicalTimestamp(value.capturedFrom)
  )
    return false;
  if (
    "capturedBefore" in value &&
    value.capturedBefore !== undefined &&
    !canonicalTimestamp(value.capturedBefore)
  )
    return false;
  return !(
    "capturedFrom" in value &&
    typeof value.capturedFrom === "string" &&
    "capturedBefore" in value &&
    typeof value.capturedBefore === "string" &&
    value.capturedBefore < value.capturedFrom
  );
}

function validEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  try {
    const endpoint = new URL(value);
    if (
      endpoint.href !== value ||
      endpoint.username.length > 0 ||
      endpoint.password.length > 0 ||
      endpoint.hash.length > 0
    )
      return false;
    if (endpoint.protocol === "https:") return true;
    return (
      endpoint.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    );
  } catch {
    return false;
  }
}

function scalarLength(value: string): number {
  return Array.from(value).length;
}

export function isSearchRequest(value: unknown): value is SearchRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string"
  )
    return false;
  const expectedVault =
    "expectedVaultId" in value && uuid((value as { expectedVaultId?: unknown }).expectedVaultId);
  if (!expectedVault) return false;

  switch (value.type) {
    case "GetSearchPassageFocus":
      return (
        onlyKeys(value, ["type", "expectedVaultId", "bundleId", "passageId"]) &&
        "bundleId" in value &&
        uuid(value.bundleId) &&
        "passageId" in value &&
        typeof value.passageId === "string" &&
        /^[0-9a-f]{64}$/u.test(value.passageId)
      );
    case "SearchLibrary":
      if (
        !onlyKeys(value, [
          "type",
          "expectedVaultId",
          "query",
          "clientInstanceId",
          "scope",
          "filters",
          "pageSize",
        ]) ||
        !("query" in value) ||
        typeof value.query !== "string" ||
        !("clientInstanceId" in value) ||
        typeof value.clientInstanceId !== "string" ||
        !CLIENT_PATTERN.test(value.clientInstanceId) ||
        !("scope" in value) ||
        (value.scope !== "Active" && value.scope !== "Deleted") ||
        !("filters" in value) ||
        !filters(value.filters) ||
        !("pageSize" in value) ||
        value.pageSize !== 50
      )
        return false;
      try {
        parseSearchQuery(value.query);
        return true;
      } catch {
        return false;
      }
    case "LoadMoreSearchResults":
      return (
        onlyKeys(value, ["type", "expectedVaultId", "clientInstanceId", "cursor", "pageSize"]) &&
        "clientInstanceId" in value &&
        typeof value.clientInstanceId === "string" &&
        CLIENT_PATTERN.test(value.clientInstanceId) &&
        "cursor" in value &&
        typeof value.cursor === "string" &&
        CURSOR_PATTERN.test(value.cursor) &&
        "pageSize" in value &&
        value.pageSize === 50
      );
    case "GetSearchState":
    case "StartSearchIndexing":
    case "PauseSearchIndexing":
    case "RebuildSearchIndex":
    case "DisableSemanticSearch":
    case "RemoveLocalSearchModel":
    case "CancelLocalSearchModelDownload":
      return onlyKeys(value, ["type", "expectedVaultId"]);
    case "ConfigureLocalSearch":
      return (
        onlyKeys(value, ["type", "expectedVaultId", "acceptedDisclosureVersion"]) &&
        "acceptedDisclosureVersion" in value &&
        value.acceptedDisclosureVersion === 1
      );
    case "CancelRemoteSearchProbe":
      return onlyKeys(value, ["type", "expectedVaultId"]);
    case "ProbeRemoteSearchProvider":
      return (
        onlyKeys(value, ["type", "expectedVaultId", "endpoint", "model", "dimensions", "apiKey"]) &&
        "endpoint" in value &&
        validEndpoint(value.endpoint) &&
        "model" in value &&
        typeof value.model === "string" &&
        scalarLength(value.model) >= 1 &&
        scalarLength(value.model) <= 256 &&
        (!("dimensions" in value) ||
          value.dimensions === undefined ||
          (typeof value.dimensions === "number" &&
            Number.isSafeInteger(value.dimensions) &&
            value.dimensions >= 1 &&
            value.dimensions <= 4_096)) &&
        "apiKey" in value &&
        typeof value.apiKey === "string" &&
        value.apiKey.length >= 1 &&
        value.apiKey.length <= 8_192
      );
    case "ConfigureRemoteSearch":
      return (
        onlyKeys(value, ["type", "expectedVaultId", "probeId", "acceptedDisclosureVersion"]) &&
        "probeId" in value &&
        typeof value.probeId === "string" &&
        CLIENT_PATTERN.test(value.probeId) &&
        "acceptedDisclosureVersion" in value &&
        value.acceptedDisclosureVersion === 1
      );
    default:
      return false;
  }
}
