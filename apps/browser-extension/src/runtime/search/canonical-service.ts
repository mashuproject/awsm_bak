import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import { identifierStorageKey } from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import type { CanonicalLibraryProjectionService } from "../library/canonical-projection";
import {
  canonicalLocalStorageContext,
  openWrappedLocalState,
  prepareWrappedLocalStateItem,
} from "../vault/canonical-local-state";
import type {
  CanonicalVaultService,
  PersistedOpenedCanonicalVault,
} from "../vault/canonical-service";
import {
  buildCanonicalSearchMaterialization,
  type CanonicalSearchMaterialization,
  type CanonicalSearchQuery,
  type CanonicalSearchResult,
  canonicalSearchMaterializationId,
  decodeCanonicalSearchMaterialization,
  encodeCanonicalSearchMaterialization,
  queryCanonicalSearch,
} from "./canonical-materialization";

export type { CanonicalSearchCoverage } from "./canonical-materialization";

const SEARCH_STORAGE_DOMAIN = "awsm.local.search-materialization";

function sameIdSet(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  return (
    left.length === right.length &&
    left.every((id) => right.some((candidate) => bytesEqual(candidate, id)))
  );
}

function sameContext(
  value: CanonicalSearchMaterialization,
  vault: PersistedOpenedCanonicalVault,
): boolean {
  return (
    bytesEqual(value.vaultId, vault.replicaState.vaultId) &&
    bytesEqual(value.generationId, vault.replicaState.generationId) &&
    sameIdSet(value.frontier, vault.replicaState.causalFrontier)
  );
}

export class CanonicalSearchService {
  constructor(
    readonly vaults: CanonicalVaultService,
    readonly library: Pick<CanonicalLibraryProjectionService, "load">,
  ) {}

  async load(vaultId: Identifier<"Vault">): Promise<CanonicalSearchMaterialization> {
    const projection = await this.library.load(vaultId);
    const vault = await this.vaults.openVault(vaultId);
    if (
      !bytesEqual(projection.vaultId, vault.replicaState.vaultId) ||
      !bytesEqual(projection.generationId, vault.replicaState.generationId) ||
      !sameIdSet(projection.frontier, vault.replicaState.causalFrontier)
    ) {
      throw Object.assign(new Error("The Vault changed while preparing Search."), {
        id: "VAULT_CONTEXT_CHANGED",
      });
    }

    const expectedMaterializationId = await canonicalSearchMaterializationId(projection);
    const cached = await this.readCurrent(vault, expectedMaterializationId);
    if (
      cached !== undefined &&
      sameContext(cached, vault) &&
      bytesEqual(cached.materializationId, expectedMaterializationId)
    ) {
      return cached;
    }

    const materialization = await buildCanonicalSearchMaterialization(projection);
    const encoded = encodeCanonicalSearchMaterialization(materialization);
    const validated = decodeCanonicalSearchMaterialization(encoded);
    if (!bytesEqual(validated.materializationId, materialization.materializationId)) {
      throw new TypeError("The rebuilt Search Materialization identity changed during validation");
    }
    const item = await prepareWrappedLocalStateItem({
      namespace: NAMESPACES.searchMaterialization.key,
      scopeKey: identifierStorageKey(vaultId),
      itemKey: "current",
      wrappingKey: vault.installationWrappingKey,
      domain: SEARCH_STORAGE_DOMAIN,
      context: canonicalLocalStorageContext(vaultId, materialization.materializationId),
      bytes: encoded,
    });
    await this.vaults.storage.commitReplicaMutation({
      realm: this.vaults.realm,
      expectedReplicaState: vault.replicaStateStorageBytes,
      nextReplicaState: {
        namespace: NAMESPACES.replicaState.key,
        scopeKey: identifierStorageKey(vaultId),
        itemKey: "current",
        bytes: vault.replicaStateStorageBytes,
      },
      mutableItems: [item],
    });
    return materialization;
  }

  async query(
    vaultId: Identifier<"Vault">,
    input: CanonicalSearchQuery,
  ): Promise<readonly CanonicalSearchResult[]> {
    return queryCanonicalSearch(await this.load(vaultId), input);
  }

  private async readCurrent(
    vault: PersistedOpenedCanonicalVault,
    materializationId: Uint8Array,
  ): Promise<CanonicalSearchMaterialization | undefined> {
    const bytes = await this.vaults.storage.getBytes(this.vaults.realm, {
      namespace: NAMESPACES.searchMaterialization.key,
      scopeKey: identifierStorageKey(vault.replicaState.vaultId),
      itemKey: "current",
    });
    if (bytes === undefined) return undefined;
    try {
      return decodeCanonicalSearchMaterialization(
        await openWrappedLocalState({
          wrappingKey: vault.installationWrappingKey,
          domain: SEARCH_STORAGE_DOMAIN,
          vaultId: vault.replicaState.vaultId,
          identity: materializationId,
          wrappedBytes: bytes,
        }),
      );
    } catch {
      return undefined;
    }
  }
}
