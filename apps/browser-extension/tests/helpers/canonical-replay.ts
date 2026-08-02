import { identifier } from "../../src/domain/canonical/identifiers";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import type { CanonicalAuthorityState } from "../../src/runtime/projection/canonical-authority-replay";
import type { ReplayedCanonicalVault } from "../../src/runtime/projection/canonical-replay";

export const emptyReplayCredentialId = identifier("ClientCredential", new Uint8Array(32).fill(3));
export const emptyReplayMemberId = identifier("Member", new Uint8Array(32).fill(2));

export function singleCredentialAuthority(input: {
  readonly clientCredentialId: typeof emptyReplayCredentialId;
  readonly memberId: typeof emptyReplayMemberId;
  readonly signingPublicKey?: Uint8Array;
  readonly wrappingPublicKey?: Uint8Array;
  readonly lifecycle?: 1 | 2;
}): CanonicalAuthorityState {
  const lifecycle = input.lifecycle ?? 1;
  return {
    activeMemberIds: lifecycle === 1 ? [input.memberId] : [],
    administratorIds: lifecycle === 1 ? [input.memberId] : [],
    administratorConflicts: [],
    activeInvitations: [],
    invitationConflicts: [],
    recoveryCredentials: [],
    recoveryConflicts: [],
    keyEpochs: [],
    keyEpochConflicts: [],
    keyEnvelopeSlots: [],
    writeFences: [],
    clientCredentials: new Map([
      [
        Array.from(input.clientCredentialId, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        {
          clientCredentialId: input.clientCredentialId,
          memberId: input.memberId,
          signingPublicKey: input.signingPublicKey ?? new Uint8Array(32),
          wrappingPublicKey: input.wrappingPublicKey ?? new Uint8Array(32),
          active: lifecycle === 1,
        },
      ],
    ]),
    lifecycle,
  };
}

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
  authority: singleCredentialAuthority({
    clientCredentialId: emptyReplayCredentialId,
    memberId: emptyReplayMemberId,
  }),
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
} as unknown as Pick<ReplayedCanonicalVault, "vault" | "authority">;
