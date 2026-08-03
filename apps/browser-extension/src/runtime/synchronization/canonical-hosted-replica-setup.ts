import type { Identifier } from "../../domain/canonical/identifiers";
import {
  CanonicalHostedReplicaHttp,
  type CanonicalHostedReplicaSession,
  CanonicalHostedReplicaSessionHttp,
  type CanonicalHostedReplicaSummary,
} from "./canonical-host-http";
import type { CanonicalReplicaRemoteService } from "./canonical-remote-service";
import { type CanonicalReplicaRemote, encodeCanonicalReplicaRemote } from "./canonical-state";

const REQUIRED_CAPABILITIES = [
  "awsm.replica.inventory.read",
  "awsm.replica.item.read",
  "awsm.replica.item.write",
] as const;

function hasRequiredCapabilities(summary: CanonicalHostedReplicaSummary): boolean {
  return REQUIRED_CAPABILITIES.every((capability) => summary.capabilities.includes(capability));
}

function requireUsableReplica(summary: CanonicalHostedReplicaSummary): void {
  for (const capability of REQUIRED_CAPABILITIES) {
    if (!summary.capabilities.includes(capability)) {
      throw new TypeError(`Hosted Replica is missing ${capability} access`);
    }
  }
}

/** A transient Host session and its currently selectable opaque Hosted Replicas. */
export class CanonicalHostedReplicaAttachmentCeremony {
  private active = true;

  constructor(
    readonly replicas: readonly CanonicalHostedReplicaSummary[],
    private readonly input: {
      readonly vaultId: Identifier<"Vault">;
      readonly endpoint: string;
      readonly name: string;
      readonly remoteId: string;
      readonly session: CanonicalHostedReplicaSession;
      readonly configure: (input: {
        readonly remote: CanonicalReplicaRemote;
        readonly session: CanonicalHostedReplicaSession;
      }) => Promise<void>;
    },
  ) {}

  async confirm(replicaHandle: string): Promise<CanonicalReplicaRemote> {
    this.assertActive();
    const selected = this.replicas.find((replica) => replica.replicaHandle === replicaHandle);
    if (selected === undefined) throw new TypeError("Selected Hosted Replica is unavailable");
    this.active = false;
    const remote: CanonicalReplicaRemote = {
      remoteId: this.input.remoteId,
      vaultId: this.input.vaultId,
      name: this.input.name,
      endpoint: this.input.endpoint,
      hostedReplicaHandle: selected.replicaHandle,
      locatorSalt: selected.locatorSalt,
      enabled: true,
      inventoryPageSize: 100,
    };
    await this.input.configure({ remote, session: this.input.session });
    return remote;
  }

  cancel(): void {
    this.active = false;
  }

  private assertActive(): void {
    if (!this.active)
      throw new Error("The Hosted Replica attachment ceremony is no longer active.");
  }
}

/**
 * Creates one Host-local Hosted Replica and one local Remote configuration from transient reference
 * Host credentials. The password is never retained after the sign-in request.
 */
export class CanonicalHostedReplicaSetupService {
  constructor(
    private readonly dependencies: {
      readonly remotes: Pick<CanonicalReplicaRemoteService, "configureHostedSession">;
      readonly createSessionHttp?: (input: {
        readonly endpoint: string;
      }) => Pick<CanonicalHostedReplicaSessionHttp, "signIn">;
      readonly createReplicaHttp?: (input: {
        readonly endpoint: string;
        readonly bearerToken: string;
      }) => Pick<CanonicalHostedReplicaHttp, "createReplica" | "listReplicas">;
      readonly createRemoteId?: () => string;
    },
  ) {}

  async create(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly endpoint: string;
    readonly name: string;
    readonly username: string;
    readonly password: string;
    readonly inventoryPageSize?: number;
  }): Promise<CanonicalReplicaRemote> {
    const remoteId = this.dependencies.createRemoteId?.() ?? crypto.randomUUID();
    this.validateLocalConfiguration(input, remoteId);
    const session = await (
      this.dependencies.createSessionHttp?.({ endpoint: input.endpoint }) ??
      new CanonicalHostedReplicaSessionHttp({ endpoint: input.endpoint })
    ).signIn({ username: input.username, password: input.password });
    this.sameUsername(session, input.username);
    const summary = await (
      this.dependencies.createReplicaHttp?.({
        endpoint: input.endpoint,
        bearerToken: session.accessToken,
      }) ??
      new CanonicalHostedReplicaHttp({ endpoint: input.endpoint, bearerToken: session.accessToken })
    ).createReplica();
    requireUsableReplica(summary);
    const remote: CanonicalReplicaRemote = {
      remoteId,
      vaultId: input.vaultId,
      name: input.name,
      endpoint: input.endpoint,
      hostedReplicaHandle: summary.replicaHandle,
      locatorSalt: summary.locatorSalt,
      enabled: true,
      inventoryPageSize: input.inventoryPageSize ?? 100,
    };
    await this.dependencies.remotes.configureHostedSession({ remote, session });
    return remote;
  }

  /**
   * Signs into one Host and retains the rotating session only until the user chooses one of that
   * Account's existing authorized Hosted Replicas. Nothing is persisted until confirmation.
   */
  async beginAttachment(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly endpoint: string;
    readonly name: string;
    readonly username: string;
    readonly password: string;
  }): Promise<CanonicalHostedReplicaAttachmentCeremony> {
    const remoteId = this.dependencies.createRemoteId?.() ?? crypto.randomUUID();
    this.validateLocalConfiguration(input, remoteId);
    const session = await (
      this.dependencies.createSessionHttp?.({ endpoint: input.endpoint }) ??
      new CanonicalHostedReplicaSessionHttp({ endpoint: input.endpoint })
    ).signIn({ username: input.username, password: input.password });
    this.sameUsername(session, input.username);
    const replicas = (
      await (
        this.dependencies.createReplicaHttp?.({
          endpoint: input.endpoint,
          bearerToken: session.accessToken,
        }) ??
        new CanonicalHostedReplicaHttp({
          endpoint: input.endpoint,
          bearerToken: session.accessToken,
        })
      ).listReplicas()
    )
      .filter(hasRequiredCapabilities)
      .toSorted((left, right) => left.replicaHandle.localeCompare(right.replicaHandle));
    if (replicas.length === 0) {
      throw new TypeError("This Account has no existing Hosted Replica with full sync access");
    }
    return new CanonicalHostedReplicaAttachmentCeremony(replicas, {
      vaultId: input.vaultId,
      endpoint: input.endpoint,
      name: input.name,
      remoteId,
      session,
      configure: this.dependencies.remotes.configureHostedSession.bind(this.dependencies.remotes),
    });
  }

  private validateLocalConfiguration(
    input: {
      readonly vaultId: Identifier<"Vault">;
      readonly endpoint: string;
      readonly name: string;
      readonly inventoryPageSize?: number;
    },
    remoteId: string,
  ): void {
    encodeCanonicalReplicaRemote({
      remoteId,
      vaultId: input.vaultId,
      name: input.name,
      endpoint: input.endpoint,
      hostedReplicaHandle: "00000000-0000-4000-8000-000000000000",
      locatorSalt: new Uint8Array(32),
      enabled: true,
      inventoryPageSize: input.inventoryPageSize ?? 100,
    });
  }

  private sameUsername(session: CanonicalHostedReplicaSession, expected: string): void {
    if (session.username !== expected) {
      throw new TypeError("Replica Host session username does not match the sign-in request");
    }
  }
}
