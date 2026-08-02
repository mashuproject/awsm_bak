import { describe, expect, it } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import {
  deriveHostedReplicaOpaqueLocator,
  HOSTED_REPLICA_LOGICAL_NAMESPACE,
} from "../../src/runtime/synchronization/canonical-hosted-replica-locator";

describe("Hosted Replica opaque locator", () => {
  it("derives a stable Host-specific opaque locator without reusing it across Hosts or namespaces", async () => {
    const logicalId = identifier("KeyEnvelope", new Uint8Array(32).fill(1));

    const first = await deriveHostedReplicaOpaqueLocator({
      locatorSalt: new Uint8Array(32).fill(2),
      logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.KeyEnvelope,
      logicalId,
    });
    const repeated = await deriveHostedReplicaOpaqueLocator({
      locatorSalt: new Uint8Array(32).fill(2),
      logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.KeyEnvelope,
      logicalId,
    });
    const otherHost = await deriveHostedReplicaOpaqueLocator({
      locatorSalt: new Uint8Array(32).fill(3),
      logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.KeyEnvelope,
      logicalId,
    });
    const otherNamespace = await deriveHostedReplicaOpaqueLocator({
      locatorSalt: new Uint8Array(32).fill(2),
      logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.VaultObject,
      logicalId,
    });

    expect(repeated).toEqual(first);
    expect(otherHost).not.toEqual(first);
    expect(otherNamespace).not.toEqual(first);
    expect(first).toHaveLength(32);
  });
});
