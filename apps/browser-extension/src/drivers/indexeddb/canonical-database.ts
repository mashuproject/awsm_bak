import {
  type Identifier,
  type IdentifierKind,
  identifier,
} from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import {
  CANONICAL_DATABASE_NAME,
  CANONICAL_DATABASE_VERSION,
  NAMESPACE_REGISTRY,
  NAMESPACES,
  type NamespaceKey,
  STORAGE_FAMILIES,
  type StorageFamily,
  type StorageRealm,
  storageRealmKey,
} from "./canonical-schema";

export type CanonicalStorageErrorId =
  | "IMMUTABLE_ITEM_CONFLICT"
  | "STORAGE_CONTEXT_CHANGED"
  | "STORAGE_SCHEMA_INVALID"
  | "STORAGE_TRANSACTION_FAILED"
  | "VAULT_ALREADY_EXISTS"
  | "VAULT_CONTEXT_CHANGED";

export class CanonicalStorageError extends Error {
  readonly id: CanonicalStorageErrorId;

  constructor(id: CanonicalStorageErrorId, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CanonicalStorageError";
    this.id = id;
  }
}

export interface NamespaceBytes {
  readonly namespace: NamespaceKey;
  readonly scopeKey: string;
  readonly itemKey: string;
  readonly bytes: Uint8Array;
}

export interface ListedNamespaceBytes extends NamespaceBytes {
  readonly realmKey: string;
}

export interface InitialVaultCommit {
  readonly realm: StorageRealm;
  readonly vaultKey: string;
  readonly immutableItems: readonly NamespaceBytes[];
  readonly replicaState: NamespaceBytes;
  readonly replicaSafetyItems?: readonly NamespaceBytes[];
  readonly vaultDirectoryEntry: NamespaceBytes;
  readonly installationStateItems?: readonly NamespaceBytes[];
  readonly trustedSecrets: readonly NamespaceBytes[];
  readonly expectedMutableItems?: readonly NamespaceBytes[];
  readonly deletedItems?: readonly Omit<NamespaceBytes, "bytes">[];
}

export interface ReplicaMutationCommit {
  readonly realm: StorageRealm;
  readonly expectedReplicaState: Uint8Array;
  readonly expectedAbsentItems?: readonly Omit<NamespaceBytes, "bytes">[];
  readonly expectedMutableItems?: readonly NamespaceBytes[];
  readonly nextReplicaState: NamespaceBytes;
  readonly immutableItems?: readonly NamespaceBytes[];
  readonly mutableItems?: readonly NamespaceBytes[];
  readonly deletedItems?: readonly Omit<NamespaceBytes, "bytes">[];
}

export interface InstallationMutationCommit {
  readonly realm: StorageRealm;
  readonly expectedAbsentItems?: readonly Omit<NamespaceBytes, "bytes">[];
  readonly expectedMutableItems?: readonly NamespaceBytes[];
  readonly mutableItems?: readonly NamespaceBytes[];
  readonly deletedItems?: readonly Omit<NamespaceBytes, "bytes">[];
}

export interface ExecutionMutationCommit {
  readonly realm: StorageRealm;
  readonly expectedAbsentItems?: readonly Omit<NamespaceBytes, "bytes">[];
  readonly expectedMutableItems?: readonly NamespaceBytes[];
  readonly immutableItems?: readonly NamespaceBytes[];
  readonly mutableItems?: readonly NamespaceBytes[];
  readonly deletedItems?: readonly Omit<NamespaceBytes, "bytes">[];
}

/**
 * Removes one Installation-local Replica Remote and every local execution artifact scoped to it.
 * This is a dedicated cross-family transaction; ordinary Installation and Execution mutations
 * remain deliberately separate.
 */
export interface RemoteRetirementCommit {
  readonly realm: StorageRealm;
  readonly vaultId: Identifier<"Vault">;
  readonly remoteId: string;
  readonly expectedRemote: NamespaceBytes;
  readonly expectedCredential: NamespaceBytes;
  readonly deletedItems: readonly Omit<NamespaceBytes, "bytes">[];
}

type StorageKey = [string, NamespaceKey, string, string];

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new DOMException("Transaction aborted", "AbortError")),
      { once: true },
    );
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
  }
}

function storageError(error: unknown): CanonicalStorageError {
  if (error instanceof CanonicalStorageError) return error;
  const reason = error instanceof Error ? error.name : "UnknownError";
  return new CanonicalStorageError(
    "STORAGE_TRANSACTION_FAILED",
    `The canonical storage transaction failed (${reason}).`,
    { cause: error },
  );
}

function assertKeyComponent(field: string, value: string): void {
  const containsControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (value.length < 1 || value.length > 1024 || containsControlCharacter) {
    throw new TypeError(`${field} is not a valid storage key component`);
  }
}

function descriptor(namespace: NamespaceKey) {
  const value = NAMESPACE_REGISTRY.get(namespace);
  if (value === undefined) throw new TypeError(`Unknown canonical namespace: ${namespace}`);
  return value;
}

function familyNames(items: readonly NamespaceBytes[]): readonly StorageFamily[] {
  return [...new Set(items.map((item) => descriptor(item.namespace).family))];
}

function storageKey(realm: StorageRealm, item: Omit<NamespaceBytes, "bytes">): StorageKey {
  assertKeyComponent("Scope key", item.scopeKey);
  assertKeyComponent("Item key", item.itemKey);
  descriptor(item.namespace);
  return [storageRealmKey(realm), item.namespace, item.scopeKey, item.itemKey];
}

function serializedStorageKey(realm: StorageRealm, item: Omit<NamespaceBytes, "bytes">): string {
  return storageKey(realm, item).join("\u0000");
}

function assertUniqueItems(
  realm: StorageRealm,
  items: readonly Omit<NamespaceBytes, "bytes">[],
): void {
  const keys = items.map((item) => serializedStorageKey(realm, item));
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("A canonical storage commit contains duplicate item keys");
  }
}

function assertBytes(item: NamespaceBytes): void {
  if (!(item.bytes instanceof Uint8Array) || item.bytes.byteLength === 0) {
    throw new TypeError(`${item.namespace} must contain nonempty bytes`);
  }
}

function assertNamespace(item: NamespaceBytes, expected: NamespaceKey): void {
  if (item.namespace !== expected) {
    throw new TypeError(`Expected namespace ${expected}, received ${item.namespace}`);
  }
}

function assertVaultScope(item: NamespaceBytes, vaultKey: string): void {
  if (item.scopeKey !== vaultKey) {
    throw new TypeError(`${item.namespace} is outside the committed Vault scope`);
  }
}

function assertInitialItemScope(item: NamespaceBytes, vaultKey: string): void {
  if (item.namespace === NAMESPACES.vaultDirectory.key) {
    if (item.scopeKey !== "installation" || item.itemKey !== vaultKey) {
      throw new TypeError("Vault Directory entry is outside the committed Installation scope");
    }
    return;
  }
  if (item.namespace === NAMESPACES.installationSelection.key) {
    if (item.scopeKey !== "installation" || item.itemKey !== "current") {
      throw new TypeError("Installation Selection is outside its singleton scope");
    }
    return;
  }
  assertVaultScope(item, vaultKey);
}

function validateInstallationWrappingKey(value: unknown): CryptoKey {
  if (
    !(value instanceof CryptoKey) ||
    value.extractable ||
    value.algorithm.name !== "AES-KW" ||
    !value.usages.includes("wrapKey") ||
    !value.usages.includes("unwrapKey")
  ) {
    throw new CanonicalStorageError(
      "STORAGE_SCHEMA_INVALID",
      "The installation wrapping key is invalid.",
    );
  }
  return value;
}

export function identifierStorageKey<Kind extends IdentifierKind>(
  identifier: Identifier<Kind>,
): string {
  return [...identifier].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function identifierFromStorageKey<Kind extends IdentifierKind>(
  kind: Kind,
  value: string,
): Identifier<Kind> {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${kind} storage key must contain 64 lowercase hexadecimal characters`);
  }
  return identifier(
    kind,
    Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16)),
  );
}

export async function openCanonicalDatabase(
  name = CANONICAL_DATABASE_NAME,
  factory: IDBFactory = indexedDB,
): Promise<IDBDatabase> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, CANONICAL_DATABASE_VERSION);
    let upgradeFailure: Error | undefined;
    request.addEventListener(
      "upgradeneeded",
      (event) => {
        if (event.oldVersion !== 0) {
          upgradeFailure = new CanonicalStorageError(
            "STORAGE_SCHEMA_INVALID",
            "The canonical database cannot be upgraded from another schema.",
          );
          request.transaction?.abort();
          return;
        }
        for (const family of Object.values(STORAGE_FAMILIES)) {
          request.result.createObjectStore(family);
        }
      },
      { once: true },
    );
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(upgradeFailure ?? request.error), {
      once: true,
    });
    request.addEventListener(
      "blocked",
      () => reject(new Error("Canonical database opening is blocked")),
      { once: true },
    );
  });

  const expected = Object.values(STORAGE_FAMILIES).toSorted();
  const actual = [...database.objectStoreNames].toSorted();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    database.close();
    throw new CanonicalStorageError(
      "STORAGE_SCHEMA_INVALID",
      "The canonical database does not contain the exact storage families.",
    );
  }
  return database;
}

export class CanonicalIndexedDb {
  readonly databaseName: string;
  private readonly databasePromise: Promise<IDBDatabase>;

  constructor(databaseName = CANONICAL_DATABASE_NAME, factory: IDBFactory = indexedDB) {
    this.databaseName = databaseName;
    this.databasePromise = openCanonicalDatabase(databaseName, factory);
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
  }

  async getBytes(
    realm: StorageRealm,
    item: Omit<NamespaceBytes, "bytes">,
  ): Promise<Uint8Array | undefined> {
    const database = await this.databasePromise;
    const namespace = descriptor(item.namespace);
    const transaction = database.transaction(namespace.family, "readonly");
    try {
      const value = await requestValue(
        transaction.objectStore(namespace.family).get(storageKey(realm, item)),
      );
      await transactionDone(transaction);
      if (value === undefined) return undefined;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        throw new CanonicalStorageError(
          "STORAGE_SCHEMA_INVALID",
          `${item.namespace} contains an invalid stored value.`,
        );
      }
      return Uint8Array.from(value);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async listBytes(
    realm: StorageRealm,
    namespaceKey: NamespaceKey,
    scopeKey: string,
  ): Promise<readonly ListedNamespaceBytes[]> {
    assertKeyComponent("Scope key", scopeKey);
    const database = await this.databasePromise;
    const namespace = descriptor(namespaceKey);
    const expectedRealm = storageRealmKey(realm);
    const transaction = database.transaction(namespace.family, "readonly");
    try {
      const items = await new Promise<ListedNamespaceBytes[]>((resolve, reject) => {
        const found: ListedNamespaceBytes[] = [];
        const request = transaction.objectStore(namespace.family).openCursor();
        request.addEventListener("error", () => reject(request.error), { once: true });
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (cursor === null) {
            resolve(found);
            return;
          }
          const key = cursor.primaryKey;
          if (
            Array.isArray(key) &&
            key.length === 4 &&
            key[0] === expectedRealm &&
            key[1] === namespaceKey &&
            key[2] === scopeKey
          ) {
            if (typeof key[3] !== "string" || !(cursor.value instanceof Uint8Array)) {
              reject(
                new CanonicalStorageError(
                  "STORAGE_SCHEMA_INVALID",
                  `${namespaceKey} contains an invalid stored entry.`,
                ),
              );
              return;
            }
            found.push({
              realmKey: expectedRealm,
              namespace: namespaceKey,
              scopeKey,
              itemKey: key[3],
              bytes: Uint8Array.from(cursor.value),
            });
          }
          cursor.continue();
        });
      });
      await transactionDone(transaction);
      return items.toSorted((left, right) => left.itemKey.localeCompare(right.itemKey));
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async putMutable(realm: StorageRealm, item: NamespaceBytes): Promise<void> {
    assertBytes(item);
    const namespace = descriptor(item.namespace);
    if (namespace.immutable) throw new TypeError(`${item.namespace} is immutable`);
    const database = await this.databasePromise;
    const transaction = database.transaction(namespace.family, "readwrite");
    try {
      transaction
        .objectStore(namespace.family)
        .put(Uint8Array.from(item.bytes), storageKey(realm, item));
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async putImmutable(realm: StorageRealm, item: NamespaceBytes): Promise<void> {
    assertBytes(item);
    if (!descriptor(item.namespace).immutable) {
      throw new TypeError(`${item.namespace} is not an immutable namespace`);
    }
    const database = await this.databasePromise;
    const family = descriptor(item.namespace).family;
    const transaction = database.transaction(family, "readwrite");
    try {
      await this.putImmutableInTransaction(transaction, realm, item);
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async commitInitialVault(input: InitialVaultCommit): Promise<void> {
    assertKeyComponent("Vault key", input.vaultKey);
    assertNamespace(input.replicaState, NAMESPACES.replicaState.key);
    assertNamespace(input.vaultDirectoryEntry, NAMESPACES.vaultDirectory.key);
    assertVaultScope(input.replicaState, input.vaultKey);
    assertInitialItemScope(input.vaultDirectoryEntry, input.vaultKey);
    const allItems = [
      ...input.immutableItems,
      input.replicaState,
      ...(input.replicaSafetyItems ?? []),
      input.vaultDirectoryEntry,
      ...(input.installationStateItems ?? []),
      ...input.trustedSecrets,
    ];
    const expectedMutableItems = input.expectedMutableItems ?? [];
    const deletedItems = input.deletedItems ?? [];
    for (const item of allItems) {
      assertBytes(item);
      assertInitialItemScope(item, input.vaultKey);
    }
    for (const item of input.immutableItems) {
      if (!descriptor(item.namespace).immutable) {
        throw new TypeError(`${item.namespace} is not immutable initialization data`);
      }
    }
    for (const item of input.replicaSafetyItems ?? []) {
      if (descriptor(item.namespace).family !== STORAGE_FAMILIES.ReplicaSafetyState) {
        throw new TypeError(`${item.namespace} is not Replica Safety State`);
      }
    }
    for (const item of input.installationStateItems ?? []) {
      if (
        descriptor(item.namespace).family !== STORAGE_FAMILIES.InstallationState ||
        descriptor(item.namespace).immutable
      ) {
        throw new TypeError(`${item.namespace} is not mutable Installation State`);
      }
    }
    for (const item of input.trustedSecrets) {
      if (
        item.namespace !== NAMESPACES.clientSecret.key &&
        item.namespace !== NAMESPACES.epochSecret.key
      ) {
        throw new TypeError(`${item.namespace} is not an initial Vault secret`);
      }
    }
    for (const item of expectedMutableItems) {
      assertBytes(item);
      const namespace = descriptor(item.namespace);
      if (namespace.family !== STORAGE_FAMILIES.PreparedData || namespace.immutable) {
        throw new TypeError(`${item.namespace} is not mutable Prepared Data`);
      }
    }
    for (const item of deletedItems) {
      const namespace = descriptor(item.namespace);
      if (namespace.family !== STORAGE_FAMILIES.PreparedData || namespace.immutable) {
        throw new TypeError(`${item.namespace} is not mutable Prepared Data`);
      }
    }
    assertUniqueItems(input.realm, allItems);
    assertUniqueItems(input.realm, expectedMutableItems);
    assertUniqueItems(input.realm, deletedItems);
    assertUniqueItems(input.realm, [...allItems, ...deletedItems]);

    const database = await this.databasePromise;
    const families = [
      ...familyNames(allItems),
      ...familyNames(expectedMutableItems),
      ...deletedItems.map((item) => descriptor(item.namespace).family),
    ];
    const transaction = database.transaction([...new Set(families)], "readwrite");
    try {
      const replicaStore = transaction.objectStore(STORAGE_FAMILIES.ReplicaSafetyState);
      const directoryStore = transaction.objectStore(STORAGE_FAMILIES.InstallationState);
      const [existingReplica, existingDirectory] = await Promise.all([
        requestValue(replicaStore.get(storageKey(input.realm, input.replicaState))),
        requestValue(directoryStore.get(storageKey(input.realm, input.vaultDirectoryEntry))),
      ]);
      if (existingReplica !== undefined || existingDirectory !== undefined) {
        throw new CanonicalStorageError(
          "VAULT_ALREADY_EXISTS",
          "The Vault already exists in this Storage Realm.",
        );
      }
      for (const item of expectedMutableItems) {
        const stored = await requestValue(
          transaction
            .objectStore(descriptor(item.namespace).family)
            .get(storageKey(input.realm, item)),
        );
        if (!(stored instanceof Uint8Array) || !bytesEqual(stored, item.bytes)) {
          throw new CanonicalStorageError(
            "STORAGE_CONTEXT_CHANGED",
            "Prepared Data changed before initial Vault activation.",
          );
        }
      }
      for (const item of input.immutableItems) {
        transaction
          .objectStore(descriptor(item.namespace).family)
          .add(Uint8Array.from(item.bytes), storageKey(input.realm, item));
      }
      replicaStore.add(
        Uint8Array.from(input.replicaState.bytes),
        storageKey(input.realm, input.replicaState),
      );
      for (const item of input.replicaSafetyItems ?? []) {
        replicaStore.add(Uint8Array.from(item.bytes), storageKey(input.realm, item));
      }
      directoryStore.add(
        Uint8Array.from(input.vaultDirectoryEntry.bytes),
        storageKey(input.realm, input.vaultDirectoryEntry),
      );
      for (const item of input.installationStateItems ?? []) {
        directoryStore.put(Uint8Array.from(item.bytes), storageKey(input.realm, item));
      }
      for (const item of input.trustedSecrets) {
        transaction
          .objectStore(STORAGE_FAMILIES.TrustedSecrets)
          .add(Uint8Array.from(item.bytes), storageKey(input.realm, item));
      }
      for (const item of deletedItems) {
        transaction
          .objectStore(descriptor(item.namespace).family)
          .delete(storageKey(input.realm, item));
      }
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async commitReplicaMutation(input: ReplicaMutationCommit): Promise<void> {
    assertNamespace(input.nextReplicaState, NAMESPACES.replicaState.key);
    assertBytes(input.nextReplicaState);
    const immutableItems = input.immutableItems ?? [];
    const mutableItems = input.mutableItems ?? [];
    const deletedItems = input.deletedItems ?? [];
    const expectedAbsentItems = input.expectedAbsentItems ?? [];
    const expectedMutableItems = input.expectedMutableItems ?? [];
    const allWrittenItems = [input.nextReplicaState, ...immutableItems, ...mutableItems];
    for (const item of allWrittenItems) assertBytes(item);
    for (const item of immutableItems) {
      if (!descriptor(item.namespace).immutable) {
        throw new TypeError(`${item.namespace} is not immutable commit data`);
      }
    }
    for (const item of mutableItems) {
      if (descriptor(item.namespace).immutable) {
        throw new TypeError(`${item.namespace} cannot be replaced as mutable state`);
      }
    }
    for (const item of expectedMutableItems) {
      assertBytes(item);
      if (descriptor(item.namespace).immutable) {
        throw new TypeError(`${item.namespace} cannot be a mutable compare-and-swap input`);
      }
    }
    for (const item of expectedAbsentItems) {
      if (descriptor(item.namespace).immutable) {
        throw new TypeError(`${item.namespace} cannot be an absent mutable-state assertion`);
      }
    }
    assertUniqueItems(input.realm, expectedAbsentItems);
    assertUniqueItems(input.realm, expectedMutableItems);
    assertUniqueItems(input.realm, [...allWrittenItems, ...deletedItems]);

    const families = [
      ...familyNames(allWrittenItems),
      ...expectedAbsentItems.map((item) => descriptor(item.namespace).family),
      ...familyNames(expectedMutableItems),
      ...deletedItems.map((item) => descriptor(item.namespace).family),
    ];
    const database = await this.databasePromise;
    const transaction = database.transaction([...new Set(families)], "readwrite");
    try {
      const replicaStore = transaction.objectStore(STORAGE_FAMILIES.ReplicaSafetyState);
      const replicaKey = storageKey(input.realm, input.nextReplicaState);
      const existing = await requestValue(replicaStore.get(replicaKey));
      if (!(existing instanceof Uint8Array) || !bytesEqual(existing, input.expectedReplicaState)) {
        throw new CanonicalStorageError(
          "VAULT_CONTEXT_CHANGED",
          "The Replica frontier changed before the commit.",
        );
      }
      for (const item of expectedAbsentItems) {
        const stored = await requestValue(
          transaction
            .objectStore(descriptor(item.namespace).family)
            .get(storageKey(input.realm, item)),
        );
        if (stored !== undefined) {
          throw new CanonicalStorageError(
            "VAULT_CONTEXT_CHANGED",
            "Mutable safety state already contains the requested local identity.",
          );
        }
      }
      for (const item of expectedMutableItems) {
        const stored = await requestValue(
          transaction
            .objectStore(descriptor(item.namespace).family)
            .get(storageKey(input.realm, item)),
        );
        if (!(stored instanceof Uint8Array) || !bytesEqual(stored, item.bytes)) {
          throw new CanonicalStorageError(
            "VAULT_CONTEXT_CHANGED",
            "Mutable safety state changed before the commit.",
          );
        }
      }
      for (const item of immutableItems) {
        await this.putImmutableInTransaction(transaction, input.realm, item);
      }
      for (const item of mutableItems) {
        transaction
          .objectStore(descriptor(item.namespace).family)
          .put(Uint8Array.from(item.bytes), storageKey(input.realm, item));
      }
      for (const item of deletedItems) {
        transaction
          .objectStore(descriptor(item.namespace).family)
          .delete(storageKey(input.realm, item));
      }
      replicaStore.put(Uint8Array.from(input.nextReplicaState.bytes), replicaKey);
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async commitInstallationMutation(input: InstallationMutationCommit): Promise<void> {
    const expectedAbsentItems = input.expectedAbsentItems ?? [];
    const expectedMutableItems = input.expectedMutableItems ?? [];
    const mutableItems = input.mutableItems ?? [];
    const deletedItems = input.deletedItems ?? [];
    const allowedFamilies = new Set<StorageFamily>([
      STORAGE_FAMILIES.InstallationState,
      STORAGE_FAMILIES.TrustedSecrets,
    ]);
    const assertInstallationItem = (item: Omit<NamespaceBytes, "bytes">): void => {
      const namespace = descriptor(item.namespace);
      if (namespace.immutable || !allowedFamilies.has(namespace.family)) {
        throw new TypeError(`${item.namespace} is not mutable Installation state`);
      }
    };
    for (const item of expectedAbsentItems) assertInstallationItem(item);
    for (const item of expectedMutableItems) {
      assertBytes(item);
      assertInstallationItem(item);
    }
    for (const item of mutableItems) {
      assertBytes(item);
      assertInstallationItem(item);
    }
    for (const item of deletedItems) assertInstallationItem(item);
    assertUniqueItems(input.realm, expectedAbsentItems);
    assertUniqueItems(input.realm, expectedMutableItems);
    assertUniqueItems(input.realm, [...mutableItems, ...deletedItems]);

    const families = [
      ...familyNames(expectedMutableItems),
      ...familyNames(mutableItems),
      ...expectedAbsentItems.map((item) => descriptor(item.namespace).family),
      ...deletedItems.map((item) => descriptor(item.namespace).family),
    ];
    if (families.length === 0) return;
    const database = await this.databasePromise;
    const transaction = database.transaction([...new Set(families)], "readwrite");
    try {
      for (const item of expectedAbsentItems) {
        const stored = await requestValue(
          transaction
            .objectStore(descriptor(item.namespace).family)
            .get(storageKey(input.realm, item)),
        );
        if (stored !== undefined) {
          throw new CanonicalStorageError(
            "STORAGE_CONTEXT_CHANGED",
            "Installation state already contains the requested local identity.",
          );
        }
      }
      for (const item of expectedMutableItems) {
        const stored = await requestValue(
          transaction
            .objectStore(descriptor(item.namespace).family)
            .get(storageKey(input.realm, item)),
        );
        if (!(stored instanceof Uint8Array) || !bytesEqual(stored, item.bytes)) {
          throw new CanonicalStorageError(
            "STORAGE_CONTEXT_CHANGED",
            "Installation state changed before the commit.",
          );
        }
      }
      for (const item of mutableItems) {
        transaction
          .objectStore(descriptor(item.namespace).family)
          .put(Uint8Array.from(item.bytes), storageKey(input.realm, item));
      }
      for (const item of deletedItems) {
        transaction
          .objectStore(descriptor(item.namespace).family)
          .delete(storageKey(input.realm, item));
      }
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async commitExecutionMutation(input: ExecutionMutationCommit): Promise<void> {
    const expectedAbsentItems = input.expectedAbsentItems ?? [];
    const expectedMutableItems = input.expectedMutableItems ?? [];
    const immutableItems = input.immutableItems ?? [];
    const mutableItems = input.mutableItems ?? [];
    const deletedItems = input.deletedItems ?? [];
    const allowedFamilies = new Set<StorageFamily>([
      STORAGE_FAMILIES.ExecutionState,
      STORAGE_FAMILIES.PreparedData,
      STORAGE_FAMILIES.Quarantine,
    ]);
    const assertExecutionItem = (item: Omit<NamespaceBytes, "bytes">): void => {
      if (!allowedFamilies.has(descriptor(item.namespace).family)) {
        throw new TypeError(
          `${item.namespace} is not Execution State, Prepared Data, or Quarantine`,
        );
      }
    };
    for (const item of expectedAbsentItems) assertExecutionItem(item);
    for (const item of expectedMutableItems) {
      assertBytes(item);
      assertExecutionItem(item);
      if (descriptor(item.namespace).immutable) {
        throw new TypeError(`${item.namespace} cannot be a mutable compare-and-swap input`);
      }
    }
    for (const item of immutableItems) {
      assertBytes(item);
      assertExecutionItem(item);
      if (!descriptor(item.namespace).immutable) {
        throw new TypeError(
          `${item.namespace} is not immutable Execution State, Prepared Data, or Quarantine`,
        );
      }
    }
    for (const item of mutableItems) {
      assertBytes(item);
      assertExecutionItem(item);
      if (descriptor(item.namespace).immutable) {
        throw new TypeError(`${item.namespace} cannot be replaced as mutable state`);
      }
    }
    for (const item of deletedItems) assertExecutionItem(item);
    assertUniqueItems(input.realm, expectedAbsentItems);
    assertUniqueItems(input.realm, expectedMutableItems);
    assertUniqueItems(input.realm, [...immutableItems, ...mutableItems, ...deletedItems]);

    const families = [
      ...familyNames(expectedMutableItems),
      ...familyNames(immutableItems),
      ...familyNames(mutableItems),
      ...expectedAbsentItems.map((item) => descriptor(item.namespace).family),
      ...deletedItems.map((item) => descriptor(item.namespace).family),
    ];
    if (families.length === 0) return;
    const database = await this.databasePromise;
    const transaction = database.transaction([...new Set(families)], "readwrite");
    try {
      for (const item of expectedAbsentItems) {
        const stored = await requestValue(
          transaction
            .objectStore(descriptor(item.namespace).family)
            .get(storageKey(input.realm, item)),
        );
        if (stored !== undefined) {
          throw new CanonicalStorageError(
            "STORAGE_CONTEXT_CHANGED",
            "Execution State already contains the requested local identity.",
          );
        }
      }
      for (const item of expectedMutableItems) {
        const stored = await requestValue(
          transaction
            .objectStore(descriptor(item.namespace).family)
            .get(storageKey(input.realm, item)),
        );
        if (!(stored instanceof Uint8Array) || !bytesEqual(stored, item.bytes)) {
          throw new CanonicalStorageError(
            "STORAGE_CONTEXT_CHANGED",
            "Execution State changed before the commit.",
          );
        }
      }
      for (const item of immutableItems) {
        await this.putImmutableInTransaction(transaction, input.realm, item);
      }
      for (const item of mutableItems) {
        transaction
          .objectStore(descriptor(item.namespace).family)
          .put(Uint8Array.from(item.bytes), storageKey(input.realm, item));
      }
      for (const item of deletedItems) {
        transaction
          .objectStore(descriptor(item.namespace).family)
          .delete(storageKey(input.realm, item));
      }
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async commitRemoteRetirement(input: RemoteRetirementCommit): Promise<void> {
    const vaultKey = identifierStorageKey(input.vaultId);
    const remote = input.expectedRemote;
    const credential = input.expectedCredential;
    if (
      remote.namespace !== NAMESPACES.replicaRemote.key ||
      remote.scopeKey !== vaultKey ||
      remote.itemKey !== input.remoteId
    ) {
      throw new TypeError("Remote retirement configuration is outside the selected Vault");
    }
    if (
      credential.namespace !== NAMESPACES.remoteChannelCredential.key ||
      credential.scopeKey !== input.remoteId ||
      credential.itemKey !== "bearer"
    ) {
      throw new TypeError("Remote retirement credential does not match its Remote");
    }
    assertBytes(remote);
    assertBytes(credential);

    const remoteKey = {
      namespace: remote.namespace,
      scopeKey: remote.scopeKey,
      itemKey: remote.itemKey,
    };
    const credentialKey = {
      namespace: credential.namespace,
      scopeKey: credential.scopeKey,
      itemKey: credential.itemKey,
    };
    const hasDeletion = (expected: Omit<NamespaceBytes, "bytes">): boolean =>
      input.deletedItems.some(
        (candidate) =>
          candidate.namespace === expected.namespace &&
          candidate.scopeKey === expected.scopeKey &&
          candidate.itemKey === expected.itemKey,
      );
    if (!hasDeletion(remoteKey) || !hasDeletion(credentialKey)) {
      throw new TypeError(
        "Remote retirement must remove its configuration and credential together",
      );
    }

    const remoteScopedNamespaces = new Set<NamespaceKey>([
      NAMESPACES.remoteMaterializationLedger.key,
      NAMESPACES.preparedOutgoingItem.key,
      NAMESPACES.incomingQuarantine.key,
    ]);
    for (const item of input.deletedItems) {
      if (
        item.namespace === NAMESPACES.replicaRemote.key &&
        item.scopeKey === vaultKey &&
        item.itemKey === input.remoteId
      ) {
        continue;
      }
      if (
        item.namespace === NAMESPACES.remoteChannelCredential.key &&
        item.scopeKey === input.remoteId &&
        item.itemKey === "bearer"
      ) {
        continue;
      }
      if (remoteScopedNamespaces.has(item.namespace) && item.scopeKey === input.remoteId) {
        continue;
      }
      if (item.namespace === NAMESPACES.pullSynchronizationJob.key && item.scopeKey === vaultKey) {
        continue;
      }
      throw new TypeError("Remote retirement attempts to remove state outside its local Remote");
    }
    assertUniqueItems(input.realm, input.deletedItems);

    const families = [
      ...familyNames([remote, credential]),
      ...input.deletedItems.map((item) => descriptor(item.namespace).family),
    ];
    const database = await this.databasePromise;
    const transaction = database.transaction([...new Set(families)], "readwrite");
    try {
      for (const expected of [remote, credential]) {
        const stored = await requestValue(
          transaction
            .objectStore(descriptor(expected.namespace).family)
            .get(storageKey(input.realm, expected)),
        );
        if (!(stored instanceof Uint8Array) || !bytesEqual(stored, expected.bytes)) {
          throw new CanonicalStorageError(
            "STORAGE_CONTEXT_CHANGED",
            "Replica Remote state changed before local removal.",
          );
        }
      }
      for (const item of input.deletedItems) {
        transaction
          .objectStore(descriptor(item.namespace).family)
          .delete(storageKey(input.realm, item));
      }
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async getOrCreateInstallationWrappingKey(realm: StorageRealm): Promise<CryptoKey> {
    const database = await this.databasePromise;
    const item = {
      namespace: NAMESPACES.installationWrappingKey.key,
      scopeKey: storageRealmKey(realm),
      itemKey: "aes-kw",
    } as const;
    const key = storageKey(realm, item);
    const read = async (): Promise<CryptoKey | undefined> => {
      const transaction = database.transaction(STORAGE_FAMILIES.TrustedSecrets, "readonly");
      const value = await requestValue(
        transaction.objectStore(STORAGE_FAMILIES.TrustedSecrets).get(key),
      );
      await transactionDone(transaction);
      return value === undefined ? undefined : validateInstallationWrappingKey(value);
    };

    const existing = await read();
    if (existing !== undefined) return existing;
    const generated = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    if (!(generated instanceof CryptoKey)) {
      throw new CanonicalStorageError(
        "STORAGE_SCHEMA_INVALID",
        "WebCrypto returned an invalid installation wrapping key.",
      );
    }

    const transaction = database.transaction(STORAGE_FAMILIES.TrustedSecrets, "readwrite");
    try {
      transaction.objectStore(STORAGE_FAMILIES.TrustedSecrets).add(generated, key);
      await transactionDone(transaction);
      return generated;
    } catch (error) {
      abortTransaction(transaction);
      if (error instanceof DOMException && error.name === "ConstraintError") {
        const raced = await read();
        if (raced !== undefined) return raced;
      }
      throw storageError(error);
    }
  }

  private async putImmutableInTransaction(
    transaction: IDBTransaction,
    realm: StorageRealm,
    item: NamespaceBytes,
  ): Promise<void> {
    const family = descriptor(item.namespace).family;
    const store = transaction.objectStore(family);
    const key = storageKey(realm, item);
    const existing = await requestValue(store.get(key));
    if (existing === undefined) {
      store.add(Uint8Array.from(item.bytes), key);
      return;
    }
    if (!(existing instanceof Uint8Array) || !bytesEqual(existing, item.bytes)) {
      throw new CanonicalStorageError(
        "IMMUTABLE_ITEM_CONFLICT",
        `Immutable ${item.namespace} bytes conflict with the existing identity.`,
      );
    }
  }
}
