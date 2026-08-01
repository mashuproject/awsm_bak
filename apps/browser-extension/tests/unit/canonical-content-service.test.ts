import { describe, expect, it, vi } from "vitest";

import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { CanonicalContentService } from "../../src/runtime/content/canonical-service";
import type { CanonicalVaultService } from "../../src/runtime/vault/canonical-service";

describe("canonical Content Service", () => {
  it("rejects a fenced command when the accepted causal Frontier changed", async () => {
    const vaultId = randomIdentifier("Vault");
    const expectedParent = randomIdentifier("VaultRecord");
    const currentParent = randomIdentifier("VaultRecord");
    const storage = {
      getBytes: vi.fn(async () => undefined),
      commitReplicaMutation: vi.fn(),
    };
    const vaults = {
      realm: "default",
      storage,
      openVault: vi.fn(async () => ({
        replicaState: { causalFrontier: [currentParent] },
      })),
    } as unknown as CanonicalVaultService;
    const service = new CanonicalContentService(vaults);

    await expect(
      service.execute({
        commandId: "fenced-content-1",
        vaultId,
        type: 4,
        assertedAt: 10,
        body: canonicalMap([[0, canonicalSet([randomIdentifier("Bundle")])]]),
        expectedCausalFrontier: [expectedParent],
      }),
    ).rejects.toMatchObject({ id: "VAULT_CONTEXT_CHANGED" });
    expect(storage.commitReplicaMutation).not.toHaveBeenCalled();
  });
});
