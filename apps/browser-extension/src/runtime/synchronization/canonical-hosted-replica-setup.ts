import type { Identifier } from "../../domain/canonical/identifiers";
import {
  CanonicalHostedReplicaHttp,
  type CanonicalHostedReplicaSession,
  CanonicalHostedReplicaSessionHttp,
  type CanonicalHostedReplicaSummary,
} from "./canonical-host-http";
import type { CanonicalReplicaRemoteService } from "./canonical-remote-service";
import type { CanonicalReplicaRemote } from "./canonical-state";

const REQUIRED_CAPABILITIES = [
  "awsm.replica.inventory.read",
  "awsm.replica.item.read",
  "awsm.replica.item.write",
] as const;

function requireUsableReplica(summary: CanonicalHostedReplicaSummary): void {
  for (const capability of REQUIRED_CAPABILITIES) {
    if (!summary.capabilities.includes(capability)) {
      throw new TypeError(`New Hosted Replica is missing ${capability} access`);
    }
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
      }) => Pick<CanonicalHostedReplicaHttp, "createReplica">;
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
      remoteId: this.dependencies.createRemoteId?.() ?? crypto.randomUUID(),
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

  private sameUsername(session: CanonicalHostedReplicaSession, expected: string): void {
    if (session.username !== expected) {
      throw new TypeError("Replica Host session username does not match the sign-in request");
    }
  }
}
