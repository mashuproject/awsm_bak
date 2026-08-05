import { unwrapInstallationBytes, wrapInstallationBytes } from "../../crypto/installation-wrap";
import { exactMap, mapValue, textValue } from "../../domain/canonical/schema";
import { transcript } from "../../domain/canonical/transcript";
import {
  canonicalMap,
  canonicalSet,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import type {
  CanonicalIndexedDb,
  InstallationMutationCommit,
  NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES, type StorageRealm } from "../../drivers/indexeddb/canonical-schema";

const DESKTOP_RUNTIME_GRANT_DOMAIN = "awsm.local.desktop-runtime-grant";
const DESKTOP_RUNTIME_GRANT_CONTEXT = transcript("awsm:desktop-runtime-grant:v1", [
  encodeCanonicalValue(canonicalMap([[0, "installation"]])),
]);
const DESKTOP_RUNTIME_GRANT_FORMAT = 1 as const;

export const DESKTOP_RUNTIME_GRANT_ITEM = {
  namespace: NAMESPACES.desktopRuntimeGrant.key,
  scopeKey: "installation",
  itemKey: "current",
} as const;

export interface DesktopRuntimeGrantState {
  readonly endpoint: string;
  readonly grantId: string;
  readonly clientName: string;
  readonly scopes: readonly string[];
  readonly token: string;
}

interface DesktopRuntimeGrantStorage {
  getBytes(
    realm: StorageRealm,
    item: Omit<NamespaceBytes, "bytes">,
  ): Promise<Uint8Array | undefined>;
  putMutable(realm: StorageRealm, item: NamespaceBytes): Promise<void>;
  commitInstallationMutation(input: InstallationMutationCommit): Promise<void>;
}

export class CanonicalDesktopRuntimeGrantStore {
  constructor(
    private readonly storage: Pick<CanonicalIndexedDb, keyof DesktopRuntimeGrantStorage>,
    private readonly realm: StorageRealm,
    private readonly wrappingKey: CryptoKey,
  ) {}

  async load(): Promise<DesktopRuntimeGrantState | undefined> {
    const wrapped = await this.storage.getBytes(this.realm, DESKTOP_RUNTIME_GRANT_ITEM);
    if (wrapped === undefined) return undefined;
    const bytes = await unwrapInstallationBytes({
      wrappingKey: this.wrappingKey,
      domain: DESKTOP_RUNTIME_GRANT_DOMAIN,
      context: DESKTOP_RUNTIME_GRANT_CONTEXT,
      wrappedBytes: wrapped,
    });
    return decodeGrant(bytes);
  }

  async save(grant: DesktopRuntimeGrantState): Promise<void> {
    const wrapped = await wrapInstallationBytes({
      wrappingKey: this.wrappingKey,
      domain: DESKTOP_RUNTIME_GRANT_DOMAIN,
      context: DESKTOP_RUNTIME_GRANT_CONTEXT,
      bytes: encodeGrant(grant),
    });
    await this.storage.putMutable(this.realm, {
      ...DESKTOP_RUNTIME_GRANT_ITEM,
      bytes: wrapped,
    });
  }

  async clear(): Promise<void> {
    await this.storage.commitInstallationMutation({
      realm: this.realm,
      deletedItems: [DESKTOP_RUNTIME_GRANT_ITEM],
    });
  }
}

function encodeGrant(grant: DesktopRuntimeGrantState): Uint8Array {
  return encodeCanonicalValue(
    canonicalMap([
      [0, DESKTOP_RUNTIME_GRANT_FORMAT],
      [1, grant.endpoint],
      [2, grant.grantId],
      [3, grant.clientName],
      [4, canonicalSet([...grant.scopes])],
      [5, grant.token],
    ]),
  );
}

function decodeGrant(bytes: Uint8Array): DesktopRuntimeGrantState {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1, 2, 3, 4, 5], "Desktop Runtime grant");
  const format = mapValue(map, 0);
  if (format !== DESKTOP_RUNTIME_GRANT_FORMAT) {
    throw new TypeError("Desktop Runtime grant format is unsupported.");
  }
  const endpoint = textValue(mapValue(map, 1), "Desktop Runtime endpoint", { maxUtf8Bytes: 256 });
  const grantId = textValue(mapValue(map, 2), "Desktop Runtime grant ID", { maxUtf8Bytes: 256 });
  const clientName = textValue(mapValue(map, 3), "Desktop Runtime client name", {
    maxUtf8Bytes: 256,
  });
  const scopesValue = mapValue(map, 4);
  if (!Array.isArray(scopesValue) || scopesValue.length === 0) {
    throw new TypeError("Desktop Runtime grant scopes are invalid.");
  }
  const scopes = scopesValue.map((scope) =>
    textValue(scope, "Desktop Runtime scope", { maxUtf8Bytes: 128 }),
  );
  if (new Set(scopes).size !== scopes.length || scopes.some((scope) => scope !== "runtime.vault")) {
    throw new TypeError("Desktop Runtime grant scopes are invalid.");
  }
  const token = textValue(mapValue(map, 5), "Desktop Runtime grant token", { maxUtf8Bytes: 4096 });
  if (token.length === 0) throw new TypeError("Desktop Runtime grant token is empty.");
  return { endpoint, grantId, clientName, scopes, token };
}
