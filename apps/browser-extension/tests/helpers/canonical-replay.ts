import { identifier } from "../../src/domain/canonical/identifiers";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import type { ReplayedCanonicalVault } from "../../src/runtime/projection/canonical-replay";

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
      memberId: identifier("Member", new Uint8Array(32).fill(2)),
    },
  },
} as unknown as Pick<ReplayedCanonicalVault, "vault">;
