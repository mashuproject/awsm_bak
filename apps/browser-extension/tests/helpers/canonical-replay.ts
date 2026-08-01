import { identifier } from "../../src/domain/canonical/identifiers";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import type { ReplayedCanonicalVault } from "../../src/runtime/projection/canonical-replay";

export const emptyReplayCredentialId = identifier("ClientCredential", new Uint8Array(32).fill(3));
export const emptyReplayMemberId = identifier("Member", new Uint8Array(32).fill(2));

const emptyContentCheckpoint = canonicalMap([
  [0, 1],
  [
    1,
    canonicalMap([
      [0, null],
      [1, canonicalSet([])],
    ]),
  ],
  [2, canonicalSet([])],
  [3, canonicalSet([])],
  [4, canonicalSet([])],
  [5, canonicalSet([])],
  [6, canonicalSet([])],
  [7, canonicalSet([])],
  [8, canonicalSet([])],
  [9, canonicalSet([])],
]);

export const emptyCanonicalReplayVault = {
  credentialMembers: new Map([
    [
      Array.from(emptyReplayCredentialId, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      emptyReplayMemberId,
    ],
  ]),
  vault: {
    baseline: {
      body: canonicalMap([
        [0, 1],
        [1, 1],
        [2, emptyContentCheckpoint],
        [3, canonicalMap([])],
        [4, canonicalMap([[0, 1]])],
        [5, null],
      ]),
    },
    replicaState: {
      vaultId: identifier("Vault", new Uint8Array(32).fill(1)),
      memberId: emptyReplayMemberId,
    },
  },
} as unknown as Pick<ReplayedCanonicalVault, "vault" | "credentialMembers">;
