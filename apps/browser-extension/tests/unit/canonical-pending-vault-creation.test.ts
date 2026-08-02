import { describe, expect, it } from "vitest";

import { identifier } from "../../src/domain/canonical/identifiers";
import {
  canonicalMap,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../src/domain/canonical/value";
import {
  decodeCanonicalPendingVaultCreation,
  encodeCanonicalPendingVaultCreation,
} from "../../src/runtime/vault/canonical-pending-vault-creation";

const SETUP_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

describe("canonical pending Vault creation", () => {
  it("stores exactly the restart-safe creation material without a Recovery Phrase", () => {
    const pending = {
      setupId: SETUP_ID,
      expectedVaultId: null,
      label: "Research",
      assertedAt: 1234,
      ids: {
        vaultId: filled("Vault", 1),
        generationId: filled("Generation", 2),
        firstMemberId: filled("Member", 3),
        clientCredentialId: filled("ClientCredential", 4),
        recoveryCredentialId: filled("RecoveryCredential", 5),
        labelCauseId: filled("BaselineCause", 6),
      },
      clientSigningSeed: new Uint8Array(32).fill(7),
      clientWrappingPrivateKey: new Uint8Array(32).fill(8),
      keyEpochKey: new Uint8Array(32).fill(9),
      recoveryEnvelopeBytes: new Uint8Array([10, 11, 12]),
      clientEnvelopeBytes: new Uint8Array([13, 14, 15]),
      baselineProtectionParameters: new Uint8Array(64).fill(16),
      genesisProtectionParameters: new Uint8Array(64).fill(17),
    };

    const encoded = encodeCanonicalPendingVaultCreation(pending);

    expect(decodeCanonicalPendingVaultCreation(encoded)).toEqual(pending);
    expect(
      encodeCanonicalPendingVaultCreation(decodeCanonicalPendingVaultCreation(encoded)),
    ).toEqual(encoded);
  });

  it("rejects non-canonical bytes and a phrase-bearing Prepared Data shape", () => {
    const pending = {
      setupId: SETUP_ID,
      expectedVaultId: filled("Vault", 1),
      label: null,
      assertedAt: 1n,
      ids: {
        vaultId: filled("Vault", 1),
        generationId: filled("Generation", 2),
        firstMemberId: filled("Member", 3),
        clientCredentialId: filled("ClientCredential", 4),
        recoveryCredentialId: filled("RecoveryCredential", 5),
        labelCauseId: filled("BaselineCause", 6),
      },
      clientSigningSeed: new Uint8Array(32).fill(7),
      clientWrappingPrivateKey: new Uint8Array(32).fill(8),
      keyEpochKey: new Uint8Array(32).fill(9),
      recoveryEnvelopeBytes: new Uint8Array([10]),
      clientEnvelopeBytes: new Uint8Array([11]),
      baselineProtectionParameters: new Uint8Array(64).fill(12),
      genesisProtectionParameters: new Uint8Array(64).fill(13),
    };
    const encoded = encodeCanonicalPendingVaultCreation(pending);
    const extended = new Uint8Array(encoded.byteLength + 1);
    extended.set(encoded);
    extended[extended.length - 1] = 0;
    const decoded = decodeCanonicalValue(encoded);
    if (!(decoded instanceof Map)) throw new Error("encoded pending creation was not a map");
    const phraseBearing = encodeCanonicalValue(
      canonicalMap([...decoded.entries(), [13, "must not be persisted"]]),
    );

    expect(() => decodeCanonicalPendingVaultCreation(extended)).toThrow();
    expect(() => decodeCanonicalPendingVaultCreation(phraseBearing)).toThrow();
  });
});
