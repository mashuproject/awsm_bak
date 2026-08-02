import { describe, expect, it } from "vitest";

import { EMPTY_REQUIRED_FEATURE_SET_ID } from "../../src/domain/canonical/features";
import { identifier } from "../../src/domain/canonical/identifiers";
import { canonicalMap, canonicalSet, encodeCanonicalValue } from "../../src/domain/canonical/value";
import {
  AUTHORITY_FENCE_KINDS,
  decodeCanonicalAuthorityCheckpoint,
  encodeCanonicalAuthorityCheckpoint,
} from "../../src/runtime/projection/canonical-authority-checkpoint";
import type { CanonicalAuthorityState } from "../../src/runtime/projection/canonical-authority-replay";
import { validateLocalClientAuthority } from "../../src/runtime/vault/canonical-open";

function id<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

describe("canonical Authority checkpoint", () => {
  it("retains exact conflict candidate pairs and portable fence causes", () => {
    const vaultId = id("Vault", 1);
    const memberId = id("Member", 2);
    const conflictedAdministratorId = id("Member", 3);
    const clientCredentialId = id("ClientCredential", 4);
    const recoveryOneId = id("RecoveryCredential", 5);
    const recoveryTwoId = id("RecoveryCredential", 6);
    const epochOneId = id("KeyEpoch", 7);
    const epochTwoId = id("KeyEpoch", 8);
    const invitationId = id("Invitation", 9);
    const causeOne = id("VaultRecord", 10);
    const causeTwo = id("VaultRecord", 11);
    const causeThree = id("VaultRecord", 12);
    const causeFour = id("VaultRecord", 13);
    const recoveryOne = {
      recoveryCredentialId: recoveryOneId,
      memberId,
      revision: 1,
      signingPublicKey: new Uint8Array(32).fill(14),
      wrappingPublicKey: new Uint8Array(32).fill(15),
      effective: true,
    } as const;
    const recoveryTwo = {
      recoveryCredentialId: recoveryTwoId,
      memberId,
      revision: 1,
      signingPublicKey: new Uint8Array(32).fill(16),
      wrappingPublicKey: new Uint8Array(32).fill(17),
      effective: true,
    } as const;
    const state: CanonicalAuthorityState = {
      activeMemberIds: [memberId, conflictedAdministratorId],
      administratorIds: [memberId],
      administratorConflicts: [
        {
          memberId: conflictedAdministratorId,
          candidates: [
            { headRecordId: causeOne, administrator: true },
            { headRecordId: causeTwo, administrator: false },
          ],
        },
      ],
      activeInvitations: [
        {
          invitationId,
          issuerMemberId: memberId,
          capabilities: canonicalSet([
            canonicalMap([
              [0, "awsm.vault"],
              [1, memberId],
              [2, vaultId],
              [3, "awsm.vault.join"],
              [4, new Uint8Array()],
            ]),
          ]),
          redemptionVerifier: new Uint8Array(32).fill(18),
          cancellationVerifier: new Uint8Array(32).fill(19),
          redemptionAuthorityId: new Uint8Array(32).fill(20),
          receiptVerificationKey: new Uint8Array(32).fill(21),
          creationRecordId: causeOne,
        },
      ],
      invitationConflicts: [
        {
          invitationId,
          candidates: [
            {
              headRecordId: causeOne,
              outcome: 1,
              authorityReceiptId: new Uint8Array(32).fill(22),
              joinRequestId: new Uint8Array(32).fill(23),
              memberId: conflictedAdministratorId,
            },
            {
              headRecordId: causeTwo,
              outcome: 2,
              authorityReceiptId: new Uint8Array(32).fill(24),
              joinRequestId: null,
              memberId: null,
            },
          ],
        },
      ],
      recoveryCredentials: [recoveryOne, recoveryTwo],
      recoveryConflicts: [
        {
          memberId,
          candidates: [
            { headRecordId: causeOne, recoveryCredentialId: recoveryOneId },
            { headRecordId: causeTwo, recoveryCredentialId: recoveryTwoId },
          ],
        },
      ],
      keyEpochs: [
        { keyEpochId: epochOneId, displayNumber: 1, current: true },
        { keyEpochId: epochTwoId, displayNumber: 1, current: true },
      ],
      keyEpochConflicts: [
        {
          candidates: [
            { headRecordId: causeThree, keyEpochId: epochOneId },
            { headRecordId: causeFour, keyEpochId: epochTwoId },
          ],
        },
      ],
      keyEnvelopeSlots: [
        {
          keyEpochId: epochOneId,
          targetKind: 1,
          targetCredentialId: recoveryOneId,
          targetRevision: 1,
          keyEnvelopeId: id("KeyEnvelope", 25),
        },
      ],
      requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
      featureManifests: [],
      featureSetConflict: null,
      writeFences: [
        { kind: "member-removal", subjectId: memberId, causeRecordIds: [causeOne] },
        {
          kind: "client-credential-removal",
          subjectId: clientCredentialId,
          causeRecordIds: [causeTwo],
        },
        { kind: "invitation-conflict", subjectId: invitationId, causeRecordIds: [causeThree] },
        { kind: "key-epoch-conflict", subjectId: vaultId, causeRecordIds: [causeFour] },
      ],
      clientCredentials: new Map([
        [
          Buffer.from(clientCredentialId).toString("hex"),
          {
            clientCredentialId,
            memberId,
            signingPublicKey: new Uint8Array(32).fill(26),
            wrappingPublicKey: new Uint8Array(32).fill(27),
            active: true,
          },
        ],
      ]),
      lifecycle: 1,
    };

    const expectedConflicts = canonicalSet([
      canonicalMap([
        [0, 1],
        [1, invitationId],
        [
          2,
          canonicalSet([
            canonicalMap([
              [0, causeOne],
              [1, 1],
              [2, new Uint8Array(32).fill(22)],
              [3, new Uint8Array(32).fill(23)],
              [4, conflictedAdministratorId],
            ]),
            canonicalMap([
              [0, causeTwo],
              [1, 2],
              [2, new Uint8Array(32).fill(24)],
              [3, null],
              [4, null],
            ]),
          ]),
        ],
      ]),
      canonicalMap([
        [0, 2],
        [1, memberId],
        [
          2,
          canonicalSet([
            canonicalMap([
              [0, causeOne],
              [1, recoveryOneId],
            ]),
            canonicalMap([
              [0, causeTwo],
              [1, recoveryTwoId],
            ]),
          ]),
        ],
      ]),
      canonicalMap([
        [0, 3],
        [1, vaultId],
        [
          2,
          canonicalSet([
            canonicalMap([
              [0, causeThree],
              [1, epochOneId],
            ]),
            canonicalMap([
              [0, causeFour],
              [1, epochTwoId],
            ]),
          ]),
        ],
      ]),
      canonicalMap([
        [0, 4],
        [1, conflictedAdministratorId],
        [
          2,
          canonicalSet([
            canonicalMap([
              [0, causeOne],
              [1, true],
            ]),
            canonicalMap([
              [0, causeTwo],
              [1, false],
            ]),
          ]),
        ],
      ]),
    ]);
    const expectedFences = canonicalSet([
      canonicalMap([
        [0, AUTHORITY_FENCE_KINDS.memberRemoval],
        [1, memberId],
        [2, canonicalSet([causeOne])],
      ]),
      canonicalMap([
        [0, AUTHORITY_FENCE_KINDS.clientCredentialRemoval],
        [1, clientCredentialId],
        [2, canonicalSet([causeTwo])],
      ]),
      canonicalMap([
        [0, AUTHORITY_FENCE_KINDS.invitationConflict],
        [1, invitationId],
        [2, canonicalSet([causeThree])],
      ]),
      canonicalMap([
        [0, AUTHORITY_FENCE_KINDS.keyEpochConflict],
        [1, vaultId],
        [2, canonicalSet([causeFour])],
      ]),
    ]);
    const encoded = encodeCanonicalAuthorityCheckpoint({ vaultId, authority: state });
    const map = encoded as ReadonlyMap<number, unknown>;

    expect(encodeCanonicalValue(map.get(8) as never)).toEqual(
      encodeCanonicalValue(expectedConflicts),
    );
    expect(encodeCanonicalValue(map.get(9) as never)).toEqual(encodeCanonicalValue(expectedFences));

    const decoded = decodeCanonicalAuthorityCheckpoint({
      vaultId,
      checkpoint: encoded,
      requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
      featureManifests: [],
      lifecycle: 1,
    });
    expect(
      encodeCanonicalValue(encodeCanonicalAuthorityCheckpoint({ vaultId, authority: decoded })),
    ).toEqual(encodeCanonicalValue(encoded));
    expect(decoded.activeInvitations[0]?.issuerMemberId).toEqual(memberId);
    expect(() =>
      validateLocalClientAuthority({
        vaultId,
        authority: decoded,
        replicaAuthority: { authoringClientCredentialId: clientCredentialId, memberId },
        clientSecret: {
          vaultId,
          memberId,
          clientCredentialId,
          signingPublicKey: new Uint8Array(32).fill(26),
          signingSecretKey: new Uint8Array(64),
          wrappingPublicKey: new Uint8Array(32).fill(27),
          wrappingPrivateKey: new Uint8Array(32),
        },
      }),
    ).not.toThrow();
  });
});
