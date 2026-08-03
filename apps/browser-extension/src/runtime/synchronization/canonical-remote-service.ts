import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import {
  type CanonicalIndexedDb,
  identifierStorageKey,
  type NamespaceBytes,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES, type StorageRealm } from "../../drivers/indexeddb/canonical-schema";
import {
  canonicalLocalStorageContext,
  openWrappedLocalState,
  prepareWrappedLocalStateItem,
} from "../vault/canonical-local-state";
import {
  type CanonicalHostedReplicaSession,
  CanonicalHostedReplicaSessionHttp,
} from "./canonical-host-http";
import {
  type CanonicalRemoteCredential,
  type CanonicalReplicaRemote,
  decodeCanonicalPullSynchronizationJob,
  decodeCanonicalRemoteCredential,
  decodeCanonicalReplicaRemote,
  encodeCanonicalRemoteCredential,
  encodeCanonicalReplicaRemote,
} from "./canonical-state";

const textEncoder = new TextEncoder();

export type LoadedReplicaRemote = {
  readonly remote: CanonicalReplicaRemote;
  readonly bearerToken: string;
};

export interface CanonicalRemoteRetirementSummary {
  /** Local prepared/confirmed destination ledger entries removed with this Remote. */
  readonly materializationLedgerCount: number;
  /** Local pull checkpoints removed with this Remote. */
  readonly pullJobCount: number;
  /** Downloaded untrusted opaque bytes removed with this Remote. */
  readonly quarantinedItemCount: number;
}

type HostedSessionCredential = Extract<
  CanonicalRemoteCredential,
  { readonly kind: "HostedSession" }
>;

function required(value: Uint8Array | undefined, field: string): Uint8Array {
  if (value === undefined) throw new TypeError(`${field} is unavailable`);
  return value;
}

export class CanonicalReplicaRemoteService {
  private readonly now: () => number;
  private readonly createSessionHttp: (input: {
    readonly endpoint: string;
  }) => Pick<CanonicalHostedReplicaSessionHttp, "refresh">;
  private readonly channelLoads = new Map<string, Promise<LoadedReplicaRemote>>();
  private readonly lifecycles = new Map<
    string,
    { uses: number; retiring: boolean; idle: (() => void) | undefined }
  >();

  constructor(
    private readonly storage: CanonicalIndexedDb,
    private readonly realm: StorageRealm,
    options: {
      readonly now?: () => number;
      readonly createSessionHttp?: (input: {
        readonly endpoint: string;
      }) => Pick<CanonicalHostedReplicaSessionHttp, "refresh">;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createSessionHttp =
      options.createSessionHttp ??
      ((input) => new CanonicalHostedReplicaSessionHttp({ endpoint: input.endpoint }));
  }

  async configure(input: {
    readonly remote: CanonicalReplicaRemote;
    readonly bearerToken: string;
  }): Promise<void> {
    return this.store(input.remote, {
      remoteId: input.remote.remoteId,
      kind: "Bearer",
      bearerToken: input.bearerToken,
    });
  }

  async configureHostedSession(input: {
    readonly remote: CanonicalReplicaRemote;
    readonly session: CanonicalHostedReplicaSession;
  }): Promise<void> {
    if (input.session.username.length === 0 || input.session.sessionId.length === 0) {
      throw new TypeError("Hosted Replica session identity is incomplete");
    }
    return this.store(input.remote, {
      remoteId: input.remote.remoteId,
      kind: "HostedSession",
      username: input.session.username,
      sessionId: input.session.sessionId,
      accessToken: input.session.accessToken,
      accessExpiresAt: input.session.accessExpiresAt,
      refreshToken: input.session.refreshToken,
      refreshExpiresAt: input.session.refreshExpiresAt,
    });
  }

  private async store(
    configured: CanonicalReplicaRemote,
    credentialValue: CanonicalRemoteCredential,
  ): Promise<void> {
    const remoteBytes = encodeCanonicalReplicaRemote(configured);
    if (credentialValue.remoteId !== configured.remoteId) {
      throw new TypeError("Replica Remote credential does not match its configuration");
    }
    const credentialBytes = encodeCanonicalRemoteCredential(credentialValue);
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const remoteIdentity = textEncoder.encode(configured.remoteId);
    const vaultKey = identifierStorageKey(configured.vaultId);
    const [remote, credential] = await Promise.all([
      prepareWrappedLocalStateItem({
        namespace: NAMESPACES.replicaRemote.key,
        scopeKey: vaultKey,
        itemKey: configured.remoteId,
        wrappingKey,
        domain: "awsm.local.replica-remote",
        context: canonicalLocalStorageContext(configured.vaultId, remoteIdentity),
        bytes: remoteBytes,
      }),
      prepareWrappedLocalStateItem({
        namespace: NAMESPACES.remoteChannelCredential.key,
        scopeKey: configured.remoteId,
        itemKey: "bearer",
        wrappingKey,
        domain: "awsm.local.remote-channel-credential",
        context: canonicalLocalStorageContext(configured.vaultId, remoteIdentity),
        bytes: credentialBytes,
      }),
    ]);
    await this.storage.commitInstallationMutation({
      realm: this.realm,
      expectedAbsentItems: [
        {
          namespace: NAMESPACES.replicaRemote.key,
          scopeKey: vaultKey,
          itemKey: configured.remoteId,
        },
        {
          namespace: NAMESPACES.remoteChannelCredential.key,
          scopeKey: configured.remoteId,
          itemKey: "bearer",
        },
      ],
      mutableItems: [remote, credential],
    });
  }

  async list(vaultId: Identifier<"Vault">): Promise<readonly CanonicalReplicaRemote[]> {
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const vaultKey = identifierStorageKey(vaultId);
    const entries = await this.storage.listBytes(
      this.realm,
      NAMESPACES.replicaRemote.key,
      vaultKey,
    );
    return Promise.all(
      entries.map(async (entry) => {
        const remote = decodeCanonicalReplicaRemote(
          await openWrappedLocalState({
            wrappingKey,
            domain: "awsm.local.replica-remote",
            vaultId,
            identity: textEncoder.encode(entry.itemKey),
            wrappedBytes: entry.bytes,
          }),
        );
        if (!bytesEqual(remote.vaultId, vaultId) || remote.remoteId !== entry.itemKey) {
          throw new TypeError("Replica Remote storage identity does not match its protected state");
        }
        return remote;
      }),
    );
  }

  /**
   * Changes only the encrypted, Installation-local Remote configuration. This intentionally leaves
   * the Remote's Channel Authenticator and every Host-held byte untouched.
   */
  async update(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
    readonly name?: string;
    readonly enabled?: boolean;
  }): Promise<CanonicalReplicaRemote> {
    const release = this.beginUse(input);
    try {
      if (input.name === undefined && input.enabled === undefined) {
        throw new TypeError("Replica Remote update must change its name or enabled state");
      }
      const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
      const scopeKey = identifierStorageKey(input.vaultId);
      const remoteKey = {
        namespace: NAMESPACES.replicaRemote.key,
        scopeKey,
        itemKey: input.remoteId,
      };
      const wrappedBytes = required(
        await this.storage.getBytes(this.realm, remoteKey),
        "Replica Remote configuration",
      );
      const current = decodeCanonicalReplicaRemote(
        await openWrappedLocalState({
          wrappingKey,
          domain: "awsm.local.replica-remote",
          vaultId: input.vaultId,
          identity: textEncoder.encode(input.remoteId),
          wrappedBytes,
        }),
      );
      if (!bytesEqual(current.vaultId, input.vaultId) || current.remoteId !== input.remoteId) {
        throw new TypeError("Replica Remote storage identity does not match its protected state");
      }
      const next: CanonicalReplicaRemote = {
        ...current,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      };
      const prepared = await prepareWrappedLocalStateItem({
        ...remoteKey,
        wrappingKey,
        domain: "awsm.local.replica-remote",
        context: canonicalLocalStorageContext(input.vaultId, textEncoder.encode(input.remoteId)),
        bytes: encodeCanonicalReplicaRemote(next),
      });
      await this.storage.commitInstallationMutation({
        realm: this.realm,
        expectedMutableItems: [{ ...remoteKey, bytes: wrappedBytes }],
        mutableItems: [prepared],
      });
      return next;
    } finally {
      release();
    }
  }

  async withLoaded<T>(
    input: { readonly vaultId: Identifier<"Vault">; readonly remoteId: string },
    operation: (loaded: LoadedReplicaRemote) => Promise<T>,
  ): Promise<T> {
    const release = this.beginUse(input);
    try {
      return await operation(await this.load(input));
    } finally {
      release();
    }
  }

  /**
   * Removes only this Client's local connection to a Replica Remote. It does not contact the
   * Replica Host, revoke a Grant, or delete Host-held bytes.
   */
  async retire(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
  }): Promise<CanonicalRemoteRetirementSummary> {
    const finish = await this.beginRetirement(input);
    try {
      return await this.retireOnce(input);
    } finally {
      finish();
    }
  }

  private async retireOnce(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
  }): Promise<CanonicalRemoteRetirementSummary> {
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const vaultKey = identifierStorageKey(input.vaultId);
    const remoteKey = {
      namespace: NAMESPACES.replicaRemote.key,
      scopeKey: vaultKey,
      itemKey: input.remoteId,
    };
    const remoteBytes = required(
      await this.storage.getBytes(this.realm, remoteKey),
      "Replica Remote configuration",
    );
    const remote = decodeCanonicalReplicaRemote(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.replica-remote",
        vaultId: input.vaultId,
        identity: textEncoder.encode(input.remoteId),
        wrappedBytes: remoteBytes,
      }),
    );
    if (!bytesEqual(remote.vaultId, input.vaultId) || remote.remoteId !== input.remoteId) {
      throw new TypeError("Replica Remote storage identity does not match its protected state");
    }

    const credentialKey = {
      namespace: NAMESPACES.remoteChannelCredential.key,
      scopeKey: input.remoteId,
      itemKey: "bearer",
    };
    const credentialBytes = required(
      await this.storage.getBytes(this.realm, credentialKey),
      "Replica Remote credential",
    );
    const credential = decodeCanonicalRemoteCredential(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.remote-channel-credential",
        vaultId: input.vaultId,
        identity: textEncoder.encode(input.remoteId),
        wrappedBytes: credentialBytes,
      }),
    );
    if (credential.remoteId !== input.remoteId) {
      throw new TypeError("Replica Remote credential identity does not match its configuration");
    }

    const [ledgerItems, preparedItems, quarantineItems, pullJobs] = await Promise.all([
      this.storage.listBytes(
        this.realm,
        NAMESPACES.remoteMaterializationLedger.key,
        input.remoteId,
      ),
      this.storage.listBytes(this.realm, NAMESPACES.preparedOutgoingItem.key, input.remoteId),
      this.storage.listBytes(this.realm, NAMESPACES.incomingQuarantine.key, input.remoteId),
      this.storage.listBytes(this.realm, NAMESPACES.pullSynchronizationJob.key, vaultKey),
    ]);
    const remotePullJobs = pullJobs.filter((stored) => {
      const job = decodeCanonicalPullSynchronizationJob(stored.bytes);
      if (
        !bytesEqual(job.vaultId, input.vaultId) ||
        job.realm.kind !== this.realm.kind ||
        job.realm.id !== this.realm.id
      ) {
        throw new TypeError(
          "Synchronization Job storage identity does not match its protected state",
        );
      }
      return job.remoteId === input.remoteId;
    });

    const deletedItems: readonly Omit<NamespaceBytes, "bytes">[] = [
      remoteKey,
      credentialKey,
      ...ledgerItems,
      ...preparedItems,
      ...quarantineItems,
      ...remotePullJobs,
    ].map(({ namespace, scopeKey, itemKey }) => ({ namespace, scopeKey, itemKey }));
    await this.storage.commitRemoteRetirement({
      realm: this.realm,
      vaultId: input.vaultId,
      remoteId: input.remoteId,
      expectedRemote: { ...remoteKey, bytes: remoteBytes },
      expectedCredential: { ...credentialKey, bytes: credentialBytes },
      deletedItems,
    });
    return {
      materializationLedgerCount: ledgerItems.length,
      pullJobCount: remotePullJobs.length,
      quarantinedItemCount: quarantineItems.length,
    };
  }

  private lifecycleKey(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
  }): string {
    return `${identifierStorageKey(input.vaultId)}:${input.remoteId}`;
  }

  private beginUse(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
  }): () => void {
    const key = this.lifecycleKey(input);
    const lifecycle = this.lifecycles.get(key) ?? { uses: 0, retiring: false, idle: undefined };
    if (lifecycle.retiring) throw new TypeError("Replica Remote is being removed from this Client");
    lifecycle.uses += 1;
    this.lifecycles.set(key, lifecycle);
    return () => {
      lifecycle.uses -= 1;
      if (lifecycle.uses < 0) throw new Error("Replica Remote lifecycle use count underflowed");
      if (lifecycle.uses === 0) lifecycle.idle?.();
      if (lifecycle.uses === 0 && !lifecycle.retiring && this.lifecycles.get(key) === lifecycle) {
        this.lifecycles.delete(key);
      }
    };
  }

  private async beginRetirement(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
  }): Promise<() => void> {
    const key = this.lifecycleKey(input);
    const lifecycle = this.lifecycles.get(key) ?? { uses: 0, retiring: false, idle: undefined };
    if (lifecycle.retiring)
      throw new TypeError("Replica Remote is already being removed from this Client");
    lifecycle.retiring = true;
    this.lifecycles.set(key, lifecycle);
    if (lifecycle.uses > 0) {
      await new Promise<void>((resolve) => {
        lifecycle.idle = resolve;
      });
    }
    return () => {
      if (this.lifecycles.get(key) === lifecycle) this.lifecycles.delete(key);
    };
  }

  private async load(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
  }): Promise<LoadedReplicaRemote> {
    const loadKey = `${identifierStorageKey(input.vaultId)}:${input.remoteId}`;
    const inFlight = this.channelLoads.get(loadKey);
    if (inFlight !== undefined) return inFlight;
    const load = this.loadOnce(input);
    this.channelLoads.set(loadKey, load);
    try {
      return await load;
    } finally {
      if (this.channelLoads.get(loadKey) === load) this.channelLoads.delete(loadKey);
    }
  }

  private async loadOnce(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly remoteId: string;
  }): Promise<LoadedReplicaRemote> {
    const remote = (await this.list(input.vaultId)).find(
      ({ remoteId }) => remoteId === input.remoteId,
    );
    if (remote === undefined)
      throw new TypeError("Replica Remote is not configured for this Vault");
    const wrappingKey = await this.storage.getOrCreateInstallationWrappingKey(this.realm);
    const wrappedBytes = required(
      await this.storage.getBytes(this.realm, {
        namespace: NAMESPACES.remoteChannelCredential.key,
        scopeKey: input.remoteId,
        itemKey: "bearer",
      }),
      "Replica Remote credential",
    );
    const credential = decodeCanonicalRemoteCredential(
      await openWrappedLocalState({
        wrappingKey,
        domain: "awsm.local.remote-channel-credential",
        vaultId: input.vaultId,
        identity: textEncoder.encode(input.remoteId),
        wrappedBytes,
      }),
    );
    if (credential.remoteId !== input.remoteId) {
      throw new TypeError("Replica Remote credential identity does not match its configuration");
    }
    if (credential.kind === "Bearer") {
      return { remote, bearerToken: credential.bearerToken };
    }
    if (credential.accessExpiresAt > this.now()) {
      return { remote, bearerToken: credential.accessToken };
    }
    return this.refreshHostedSession({
      input,
      remote,
      credential,
      wrappingKey,
      wrappedBytes,
    });
  }

  private async refreshHostedSession(input: {
    readonly input: { readonly vaultId: Identifier<"Vault">; readonly remoteId: string };
    readonly remote: CanonicalReplicaRemote;
    readonly credential: HostedSessionCredential;
    readonly wrappingKey: CryptoKey;
    readonly wrappedBytes: Uint8Array;
  }): Promise<LoadedReplicaRemote> {
    const { input: request, remote, credential, wrappingKey, wrappedBytes } = input;
    const refreshed = await this.createSessionHttp({ endpoint: remote.endpoint }).refresh({
      refreshToken: credential.refreshToken,
    });
    if (
      refreshed.username !== credential.username ||
      refreshed.sessionId !== credential.sessionId
    ) {
      throw new TypeError("Refreshed Hosted Replica session does not match its stored identity");
    }
    const nextCredential: CanonicalRemoteCredential = {
      remoteId: credential.remoteId,
      kind: "HostedSession",
      username: credential.username,
      sessionId: credential.sessionId,
      accessToken: refreshed.accessToken,
      accessExpiresAt: refreshed.accessExpiresAt,
      refreshToken: refreshed.refreshToken,
      refreshExpiresAt: refreshed.refreshExpiresAt,
    };
    const next = await prepareWrappedLocalStateItem({
      namespace: NAMESPACES.remoteChannelCredential.key,
      scopeKey: request.remoteId,
      itemKey: "bearer",
      wrappingKey,
      domain: "awsm.local.remote-channel-credential",
      context: canonicalLocalStorageContext(request.vaultId, textEncoder.encode(request.remoteId)),
      bytes: encodeCanonicalRemoteCredential(nextCredential),
    });
    await this.storage.commitInstallationMutation({
      realm: this.realm,
      expectedMutableItems: [
        {
          namespace: NAMESPACES.remoteChannelCredential.key,
          scopeKey: request.remoteId,
          itemKey: "bearer",
          bytes: wrappedBytes,
        },
      ],
      mutableItems: [next],
    });
    return { remote, bearerToken: refreshed.accessToken };
  }
}
