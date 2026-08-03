import { bytesEqual } from "../../domain/hash";
import type {
  CompleteExportKeyInventory,
  CompleteExportManifest,
} from "../complete-export/contracts";
import type { CompleteImportPreparedSource } from "../complete-import/semantic";
import type { RecoveredCompleteImport } from "../complete-import/service";
import {
  CanonicalHostedReplicaHttp,
  type CanonicalHostedReplicaSession,
  CanonicalHostedReplicaSessionHttp,
} from "./canonical-host-http";
import {
  type CanonicalHostedRecoveryClosure,
  CanonicalHostedRecoveryClosureService,
  wipeHostedRecoveryClosure,
} from "./canonical-hosted-recovery-closure";
import {
  CanonicalHostedRecoveryDiscoveryService,
  type CanonicalHostedRecoveryEnvelopeCandidate,
} from "./canonical-hosted-recovery-discovery";

type CompleteImportPort = {
  readonly activateUnknownWithMemberRecovery: (input: {
    readonly manifest: CompleteExportManifest;
    readonly keyInventory: CompleteExportKeyInventory;
    readonly source: CompleteImportPreparedSource;
    readonly recoveryPhrase: string;
    readonly assertedAt: number | bigint;
    readonly artifactInventory?: "Complete" | "Sparse";
  }) => Promise<RecoveredCompleteImport>;
};

type SessionHttp = Pick<CanonicalHostedReplicaSessionHttp, "signIn">;
type ItemHttp = Pick<CanonicalHostedReplicaHttp, "item">;

function uniqueCandidatesByReplica(
  candidates: readonly CanonicalHostedRecoveryEnvelopeCandidate[],
): readonly CanonicalHostedRecoveryEnvelopeCandidate[] {
  const byReplica = new Map<string, CanonicalHostedRecoveryEnvelopeCandidate>();
  for (const candidate of candidates) {
    if (!byReplica.has(candidate.replicaHandle)) byReplica.set(candidate.replicaHandle, candidate);
  }
  return [...byReplica.values()];
}

function selectCompleteClosure(
  closures: readonly CanonicalHostedRecoveryClosure[],
): CanonicalHostedRecoveryClosure {
  if (closures.length === 0) {
    throw new TypeError("Hosted Recovery found no complete phrase-authenticated Vault closure");
  }
  const first = closures[0];
  if (first === undefined) {
    throw new TypeError("Hosted Recovery found no complete phrase-authenticated Vault closure");
  }
  for (const closure of closures.slice(1)) {
    if (
      !bytesEqual(closure.validated.manifest.vaultId, first.validated.manifest.vaultId) ||
      !bytesEqual(closure.validated.manifest.stateDigest, first.validated.manifest.stateDigest)
    ) {
      throw new TypeError(
        "Hosted Recovery found multiple divergent phrase-authenticated Vault closures",
      );
    }
  }
  return first;
}

/**
 * Performs the trusted-client part of Hosted Member Recovery. Account credentials create a
 * transient Host session only; the resulting local Vault is not automatically bound as a Remote.
 */
export class CanonicalHostedMemberRecoveryService {
  constructor(
    private readonly dependencies: {
      readonly completeImports: CompleteImportPort;
      readonly discovery?: Pick<CanonicalHostedRecoveryDiscoveryService, "discover">;
      readonly closures?: Pick<CanonicalHostedRecoveryClosureService, "authenticate">;
      readonly createSessionHttp?: (input: { readonly endpoint: string }) => SessionHttp;
      readonly createReplicaHttp?: (input: {
        readonly endpoint: string;
        readonly bearerToken: string;
      }) => ItemHttp;
    },
  ) {}

  async recover(input: {
    readonly endpoint: string;
    readonly username: string;
    readonly password: string;
    readonly recoveryPhrase: string;
    readonly assertedAt: number | bigint;
  }): Promise<RecoveredCompleteImport> {
    const session = await (
      this.dependencies.createSessionHttp?.({ endpoint: input.endpoint }) ??
      new CanonicalHostedReplicaSessionHttp({ endpoint: input.endpoint })
    ).signIn({ username: input.username, password: input.password });
    this.assertSessionUsername(session, input.username);
    const discovery = this.dependencies.discovery ?? new CanonicalHostedRecoveryDiscoveryService();
    const closures = this.dependencies.closures ?? new CanonicalHostedRecoveryClosureService();
    const candidates = uniqueCandidatesByReplica(
      await discovery.discover({
        endpoint: input.endpoint,
        bearerToken: session.accessToken,
        recoveryPhrase: input.recoveryPhrase,
      }),
    );
    const authenticated: CanonicalHostedRecoveryClosure[] = [];
    try {
      for (const candidate of candidates) {
        try {
          authenticated.push(
            await closures.authenticate({
              endpoint: input.endpoint,
              bearerToken: session.accessToken,
              recoveryPhrase: input.recoveryPhrase,
              candidate,
            }),
          );
        } catch {
          // A phrase-openable Envelope is not a trusted recovery source until its full closure is
          // authenticated. Another Host-local Replica may still provide that closure.
        }
      }
      const closure = selectCompleteClosure(authenticated);
      const http =
        this.dependencies.createReplicaHttp?.({
          endpoint: input.endpoint,
          bearerToken: session.accessToken,
        }) ??
        new CanonicalHostedReplicaHttp({
          endpoint: input.endpoint,
          bearerToken: session.accessToken,
        });
      return this.dependencies.completeImports.activateUnknownWithMemberRecovery({
        manifest: closure.validated.manifest,
        keyInventory: closure.validated.keyInventory,
        source: {
          openOpaque: (item) =>
            http.item({
              replicaHandle: closure.replicaHandle,
              storageItemId: item.storageItemId,
              byteLength: item.byteLength,
            }),
        },
        recoveryPhrase: input.recoveryPhrase,
        assertedAt: input.assertedAt,
        artifactInventory: "Sparse",
      });
    } finally {
      await Promise.all(authenticated.map((closure) => wipeHostedRecoveryClosure(closure)));
    }
  }

  private assertSessionUsername(session: CanonicalHostedReplicaSession, username: string): void {
    if (session.username !== username) {
      throw new TypeError("Hosted Recovery session username does not match the sign-in request");
    }
  }
}
