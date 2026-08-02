import { byteString } from "../../domain/canonical/schema";
import { transcript, uint8 } from "../../domain/canonical/transcript";
import { bytesEqual, sha256 } from "../../domain/hash";

export const HOSTED_REPLICA_LOGICAL_NAMESPACE = {
  VaultRecord: 1,
  KeyEnvelope: 2,
  VaultObject: 3,
  FeatureManifest: 4,
  Artifact: 5,
} as const;

export type HostedReplicaLogicalNamespace =
  (typeof HOSTED_REPLICA_LOGICAL_NAMESPACE)[keyof typeof HOSTED_REPLICA_LOGICAL_NAMESPACE];

const LOGICAL_NAMESPACES = new Set<number>(Object.values(HOSTED_REPLICA_LOGICAL_NAMESPACE));

export async function deriveHostedReplicaOpaqueLocator(input: {
  readonly locatorSalt: Uint8Array;
  readonly logicalNamespace: HostedReplicaLogicalNamespace;
  readonly logicalId: Uint8Array;
}): Promise<Uint8Array> {
  const locatorSalt = byteString(input.locatorSalt, 32, "Hosted Replica locator salt");
  const logicalId = byteString(input.logicalId, 32, "Hosted Replica logical ID");
  if (!LOGICAL_NAMESPACES.has(input.logicalNamespace)) {
    throw new TypeError("Hosted Replica logical namespace is unknown");
  }
  return sha256(
    transcript("awsm:hosted-replica-item-locator:v1", [
      locatorSalt,
      uint8(input.logicalNamespace),
      logicalId,
    ]),
  );
}

/**
 * Returns every physical Host representation that matches one known protected logical identity.
 * The result is still untrusted Quarantine input until the caller performs its required opening or
 * signed-dependency validation.
 */
export async function findHostedReplicaOpaqueReferences<
  Reference extends { readonly storageItemId: Uint8Array; readonly locator: Uint8Array },
>(input: {
  readonly locatorSalt: Uint8Array;
  readonly logicalNamespace: HostedReplicaLogicalNamespace;
  readonly logicalId: Uint8Array;
  readonly references: readonly Reference[];
}): Promise<readonly Reference[]> {
  const locator = await deriveHostedReplicaOpaqueLocator(input);
  return input.references.filter((reference) => {
    byteString(reference.storageItemId, 32, "Hosted Replica opaque Storage Item ID");
    return bytesEqual(byteString(reference.locator, 32, "Hosted Replica opaque locator"), locator);
  });
}
