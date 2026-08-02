import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import {
  type CanonicalIndexedDb,
  identifierStorageKey,
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
  decodeCanonicalRemoteCredential,
  decodeCanonicalReplicaRemote,
  encodeCanonicalRemoteCredential,
  encodeCanonicalReplicaRemote,
} from "./canonical-state";

const textEncoder = new TextEncoder();

type LoadedReplicaRemote = {
  readonly remote: CanonicalReplicaRemote;
  readonly bearerToken: string;
};

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
  private readonly hostedSessionRefreshes = new Map<string, Promise<LoadedReplicaRemote>>();

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

  async load(input: {
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
    const refreshKey = `${identifierStorageKey(input.vaultId)}:${input.remoteId}`;
    const inFlight = this.hostedSessionRefreshes.get(refreshKey);
    if (inFlight !== undefined) return inFlight;
    const refresh = this.refreshHostedSession({
      input,
      remote,
      credential,
      wrappingKey,
      wrappedBytes,
    });
    this.hostedSessionRefreshes.set(refreshKey, refresh);
    try {
      return await refresh;
    } finally {
      if (this.hostedSessionRefreshes.get(refreshKey) === refresh) {
        this.hostedSessionRefreshes.delete(refreshKey);
      }
    }
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
