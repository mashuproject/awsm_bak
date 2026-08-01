import { sealCompactItem } from "../../crypto/compact";
import type { TypedDependency } from "../../domain/canonical/dependencies";
import { advisoryExtensions } from "../../domain/canonical/features";
import { type AuthenticatedVaultEvent, signVaultEvent } from "../../domain/canonical/record";
import type { CanonicalValue } from "../../domain/canonical/value";
import type { OpaqueEnvelope } from "../../storage/opaque-envelope";
import type { CanonicalReplicaState } from "../vault/canonical-local-state";
import {
  type OpenedCanonicalVault,
  requireCanonicalClientSecret,
} from "../vault/canonical-service";

export interface PreparedCanonicalContentEvent {
  readonly event: AuthenticatedVaultEvent;
  readonly eventEnvelope: OpaqueEnvelope;
  readonly nextReplicaState: CanonicalReplicaState;
}

export async function prepareCanonicalContentEvent(input: {
  readonly vault: OpenedCanonicalVault;
  readonly type: number;
  readonly assertedAt: number | bigint;
  readonly body: CanonicalValue;
  readonly dependencies?: readonly TypedDependency[];
  readonly protectionParameters?: Uint8Array;
}): Promise<PreparedCanonicalContentEvent> {
  const { vault } = input;
  const clientSecret = requireCanonicalClientSecret(vault);
  if (vault.replicaState.lifecycle !== 1) {
    throw new TypeError("Closed Vaults cannot author Content Events");
  }
  const event = await signVaultEvent(
    {
      vaultId: vault.replicaState.vaultId,
      generationId: vault.replicaState.generationId,
      parentRecordIds: vault.replicaState.causalFrontier,
      authorityParentRecordIds: vault.replicaState.authorityFrontier,
      dependencies: input.dependencies ?? [],
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 2,
      type: input.type,
      signerCredentialId: clientSecret.clientCredentialId,
      assertedAt: input.assertedAt,
      body: input.body,
    },
    clientSecret.signingSecretKey,
  );
  const eventEnvelope = await sealCompactItem({
    vaultId: vault.replicaState.vaultId,
    keyEpochId: vault.epochSecret.keyEpochId,
    keyEpochKey: vault.epochSecret.key,
    payloadType: 1,
    payloadBytes: event.bytes,
    ...(input.protectionParameters === undefined
      ? {}
      : { protectionParameters: input.protectionParameters }),
  });
  return {
    event,
    eventEnvelope,
    nextReplicaState: { ...vault.replicaState, causalFrontier: [event.recordId] },
  };
}
