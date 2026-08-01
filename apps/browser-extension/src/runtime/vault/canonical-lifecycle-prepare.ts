import { sealCompactItem } from "../../crypto/compact";
import { advisoryExtensions } from "../../domain/canonical/features";
import { type AuthenticatedVaultEvent, signVaultEvent } from "../../domain/canonical/record";
import { canonicalMap, canonicalSet } from "../../domain/canonical/value";
import type { OpaqueEnvelope } from "../../storage/opaque-envelope";
import type { CanonicalReplicaState } from "./canonical-local-state";
import type { OpenedCanonicalVault } from "./canonical-service";

export interface PreparedCanonicalClosureEvent {
  readonly event: AuthenticatedVaultEvent;
  readonly eventEnvelope: OpaqueEnvelope;
  readonly nextReplicaState: CanonicalReplicaState;
}

export async function prepareCanonicalClosureEvent(input: {
  readonly vault: OpenedCanonicalVault;
  readonly assertedAt: number | bigint;
  readonly protectionParameters?: Uint8Array;
}): Promise<PreparedCanonicalClosureEvent> {
  const { vault } = input;
  if (vault.replicaState.lifecycle !== 1) {
    throw new TypeError("Closed Vaults cannot author Lifecycle Events");
  }
  const event = await signVaultEvent(
    {
      vaultId: vault.replicaState.vaultId,
      generationId: vault.replicaState.generationId,
      parentRecordIds: vault.replicaState.causalFrontier,
      authorityParentRecordIds: vault.replicaState.authorityFrontier,
      dependencies: [],
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 3,
      type: 2,
      signerCredentialId: vault.clientSecret.clientCredentialId,
      assertedAt: input.assertedAt,
      body: canonicalMap([]),
    },
    vault.clientSecret.signingSecretKey,
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
    nextReplicaState: {
      ...vault.replicaState,
      causalFrontier: [event.recordId],
      authorityFrontier: [event.recordId],
      continuityRecordIds: canonicalSet([
        ...vault.replicaState.continuityRecordIds,
        event.recordId,
      ]),
      lifecycle: 2,
    },
  };
}
