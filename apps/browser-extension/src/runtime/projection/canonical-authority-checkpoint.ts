import { requiredFeatureSetId } from "../../domain/canonical/features";
import type { Identifier } from "../../domain/canonical/identifiers";
import {
  booleanValue,
  byteString,
  canonicalSetValue,
  exactCode,
  exactMap,
  identifierValue,
  idSetValue,
  mapValue,
  nonnegativeInteger,
  nullable,
  oneOfCodes,
} from "../../domain/canonical/schema";
import { type CanonicalValue, canonicalMap, canonicalSet } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import type {
  CanonicalAuthorityClientCredential,
  CanonicalAuthorityFeatureManifest,
  CanonicalAuthorityState,
  CanonicalAuthorityWriteFence,
} from "./canonical-authority-replay";

export const AUTHORITY_FENCE_KINDS = {
  memberRemoval: 1,
  clientCredentialRemoval: 2,
  invitationConflict: 3,
  keyEpochConflict: 4,
} as const;

function key(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeSet<Value>(
  value: CanonicalValue,
  field: string,
  decode: (entry: CanonicalValue, index: number) => Value,
  options: { readonly nonempty?: boolean } = {},
): readonly Value[] {
  return canonicalSetValue(value, field, (entry) => entry, options).map(decode);
}

function fenceKind(fence: CanonicalAuthorityWriteFence): number {
  switch (fence.kind) {
    case "member-removal":
      return AUTHORITY_FENCE_KINDS.memberRemoval;
    case "client-credential-removal":
      return AUTHORITY_FENCE_KINDS.clientCredentialRemoval;
    case "invitation-conflict":
      return AUTHORITY_FENCE_KINDS.invitationConflict;
    case "key-epoch-conflict":
      return AUTHORITY_FENCE_KINDS.keyEpochConflict;
    case "feature-set-incompatibility":
      throw new TypeError("An incompatible Required Feature Set cannot be checkpointed");
  }
}

function invitationIssuer(capabilities: CanonicalValue): Identifier<"Member"> {
  const values = canonicalSetValue(
    capabilities,
    "Checkpoint Invitation capabilities",
    (value) => value,
    { nonempty: true },
  );
  let issuer: Identifier<"Member"> | undefined;
  for (const [index, value] of values.entries()) {
    const capability = exactMap(
      value,
      [0, 1, 2, 3, 4],
      `Checkpoint Invitation capability ${index}`,
    );
    const candidate = identifierValue(
      mapValue(capability, 1),
      "Member",
      `Checkpoint Invitation capability ${index} issuer`,
    );
    if (issuer !== undefined && !bytesEqual(issuer, candidate)) {
      throw new TypeError("Checkpoint Invitation capabilities do not have one issuer");
    }
    issuer = candidate;
  }
  if (issuer === undefined) throw new TypeError("Checkpoint Invitation has no issuer");
  return issuer;
}

function decodeFenceKind(value: CanonicalValue): CanonicalAuthorityWriteFence["kind"] {
  switch (oneOfCodes(value, [1, 2, 3, 4] as const, "Authority fence kind")) {
    case AUTHORITY_FENCE_KINDS.memberRemoval:
      return "member-removal";
    case AUTHORITY_FENCE_KINDS.clientCredentialRemoval:
      return "client-credential-removal";
    case AUTHORITY_FENCE_KINDS.invitationConflict:
      return "invitation-conflict";
    case AUTHORITY_FENCE_KINDS.keyEpochConflict:
      return "key-epoch-conflict";
  }
}

export function decodeCanonicalAuthorityCheckpoint(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly checkpoint: CanonicalValue;
  readonly requiredFeatureSetId: Identifier<"RequiredFeatureSet">;
  readonly featureManifests: readonly CanonicalAuthorityFeatureManifest[];
  readonly lifecycle: 1 | 2;
}): CanonicalAuthorityState {
  const checkpoint = exactMap(input.checkpoint, [...Array(10).keys()], "Authority checkpoint");
  exactCode(mapValue(checkpoint, 0), 1, "Authority checkpoint format");
  const activeMemberIds = idSetValue(mapValue(checkpoint, 1), "Member", "Active Member IDs", {
    nonempty: true,
  });
  const administratorIds = idSetValue(
    mapValue(checkpoint, 2),
    "Member",
    "Administrator Member IDs",
    { nonempty: true },
  );
  if (
    administratorIds.some(
      (administratorId) =>
        !activeMemberIds.some((memberId) => bytesEqual(memberId, administratorId)),
    )
  ) {
    throw new TypeError("Every checkpointed Administrator must be an Active Member");
  }
  const clientCredentials = new Map<string, CanonicalAuthorityClientCredential>();
  canonicalSetValue(
    mapValue(checkpoint, 3),
    "Client Certificates",
    (value, index) => {
      const certificate = exactMap(value, [0, 1, 2, 3], `Client Certificate ${index}`);
      const clientCredentialId = identifierValue(
        mapValue(certificate, 0),
        "ClientCredential",
        `Client Certificate ${index} ID`,
      );
      const memberId = identifierValue(
        mapValue(certificate, 1),
        "Member",
        `Client Certificate ${index} Member ID`,
      );
      if (!activeMemberIds.some((candidate) => bytesEqual(candidate, memberId))) {
        throw new TypeError("Checkpoint Client Certificate belongs to an inactive Member");
      }
      clientCredentials.set(key(clientCredentialId), {
        clientCredentialId,
        memberId,
        signingPublicKey: byteString(
          mapValue(certificate, 2),
          32,
          `Client Certificate ${index} signing key`,
        ),
        wrappingPublicKey: byteString(
          mapValue(certificate, 3),
          32,
          `Client Certificate ${index} wrapping key`,
        ),
        active: true,
      });
      return value;
    },
    { nonempty: true },
  );
  const recoveryCredentials = decodeSet(
    mapValue(checkpoint, 4),
    "Recovery Credentials",
    (value, index) => {
      const descriptor = exactMap(value, [0, 1, 2, 3, 4], `Recovery Credential ${index}`);
      const memberId = identifierValue(
        mapValue(descriptor, 1),
        "Member",
        `Recovery Credential ${index} Member ID`,
      );
      if (!activeMemberIds.some((candidate) => bytesEqual(candidate, memberId))) {
        throw new TypeError("Checkpoint Recovery Credential belongs to an inactive Member");
      }
      return {
        recoveryCredentialId: identifierValue(
          mapValue(descriptor, 0),
          "RecoveryCredential",
          `Recovery Credential ${index} ID`,
        ),
        memberId,
        revision: nonnegativeInteger(
          mapValue(descriptor, 2),
          `Recovery Credential ${index} revision`,
        ),
        signingPublicKey: byteString(
          mapValue(descriptor, 3),
          32,
          `Recovery Credential ${index} signing key`,
        ),
        wrappingPublicKey: byteString(
          mapValue(descriptor, 4),
          32,
          `Recovery Credential ${index} wrapping key`,
        ),
        effective: true,
      };
    },
    { nonempty: true },
  );
  const activeInvitations = decodeSet(
    mapValue(checkpoint, 5),
    "Active Invitations",
    (value, index) => {
      const invitation = exactMap(value, [0, 1, 2, 3, 4, 5, 6], `Active Invitation ${index}`);
      const capabilities = mapValue(invitation, 3);
      return {
        invitationId: identifierValue(
          mapValue(invitation, 0),
          "Invitation",
          `Active Invitation ${index} ID`,
        ),
        issuerMemberId: invitationIssuer(capabilities),
        redemptionVerifier: byteString(
          mapValue(invitation, 1),
          32,
          `Active Invitation ${index} redemption verifier`,
        ),
        cancellationVerifier: byteString(
          mapValue(invitation, 2),
          32,
          `Active Invitation ${index} cancellation verifier`,
        ),
        capabilities,
        creationRecordId: identifierValue(
          mapValue(invitation, 4),
          "VaultRecord",
          `Active Invitation ${index} creation Record`,
        ),
        redemptionAuthorityId: byteString(
          mapValue(invitation, 5),
          32,
          `Active Invitation ${index} redemption authority ID`,
        ),
        receiptVerificationKey: byteString(
          mapValue(invitation, 6),
          32,
          `Active Invitation ${index} receipt verification key`,
        ),
      };
    },
  );
  const keyEpochs = decodeSet(
    mapValue(checkpoint, 6),
    "Key Epoch summaries",
    (value, index) => {
      const epoch = exactMap(value, [0, 1, 2], `Key Epoch summary ${index}`);
      return {
        keyEpochId: identifierValue(
          mapValue(epoch, 0),
          "KeyEpoch",
          `Key Epoch summary ${index} ID`,
        ),
        displayNumber: nonnegativeInteger(
          mapValue(epoch, 1),
          `Key Epoch summary ${index} display number`,
        ),
        current: booleanValue(mapValue(epoch, 2), `Key Epoch summary ${index} current marker`),
      };
    },
    { nonempty: true },
  );
  const keyEnvelopeSlots = decodeSet(
    mapValue(checkpoint, 7),
    "Checkpoint Key Envelope slots",
    (value, index) => {
      const slot = exactMap(value, [0, 1, 2, 3, 4], `Checkpoint Key Envelope slot ${index}`);
      const targetKind = oneOfCodes(
        mapValue(slot, 1),
        [1, 2] as const,
        `Checkpoint Key Envelope slot ${index} target kind`,
      );
      const targetRevision = nullable(mapValue(slot, 3), (revision) =>
        nonnegativeInteger(revision, `Checkpoint Key Envelope slot ${index} target revision`),
      );
      if ((targetKind === 1) !== (targetRevision !== null)) {
        throw new TypeError("Checkpoint Key Envelope target revision does not match its kind");
      }
      return {
        keyEpochId: identifierValue(
          mapValue(slot, 0),
          "KeyEpoch",
          `Checkpoint Key Envelope slot ${index} Epoch ID`,
        ),
        targetKind,
        targetCredentialId: identifierValue(
          mapValue(slot, 2),
          targetKind === 1 ? "RecoveryCredential" : "ClientCredential",
          `Checkpoint Key Envelope slot ${index} target Credential ID`,
        ),
        targetRevision,
        keyEnvelopeId: identifierValue(
          mapValue(slot, 4),
          "KeyEnvelope",
          `Checkpoint Key Envelope slot ${index} ID`,
        ),
      };
    },
    { nonempty: true },
  );
  const invitationConflicts: CanonicalAuthorityState["invitationConflicts"][number][] = [];
  const recoveryConflicts: CanonicalAuthorityState["recoveryConflicts"][number][] = [];
  const keyEpochConflicts: CanonicalAuthorityState["keyEpochConflicts"][number][] = [];
  const administratorConflicts: CanonicalAuthorityState["administratorConflicts"][number][] = [];
  canonicalSetValue(mapValue(checkpoint, 8), "Active Authority Conflicts", (value, index) => {
    const conflict = exactMap(value, [0, 1, 2], `Authority Conflict ${index}`);
    const kind = oneOfCodes(
      mapValue(conflict, 0),
      [1, 2, 3, 4] as const,
      `Authority Conflict ${index} kind`,
    );
    if (kind === 1) {
      invitationConflicts.push({
        invitationId: identifierValue(
          mapValue(conflict, 1),
          "Invitation",
          `Authority Conflict ${index} Invitation ID`,
        ),
        candidates: decodeSet(
          mapValue(conflict, 2),
          `Authority Conflict ${index} candidates`,
          (candidateValue, candidateIndex) => {
            const candidate = exactMap(
              candidateValue,
              [0, 1, 2, 3, 4],
              `Authority Conflict ${index} candidate ${candidateIndex}`,
            );
            const outcome = oneOfCodes(
              mapValue(candidate, 1),
              [1, 2] as const,
              `Authority Conflict ${index} candidate ${candidateIndex} outcome`,
            );
            const joinRequestId = nullable(mapValue(candidate, 3), (requestId) =>
              byteString(
                requestId,
                32,
                `Authority Conflict ${index} candidate ${candidateIndex} Join Request ID`,
              ),
            );
            const memberId = nullable(mapValue(candidate, 4), (member) =>
              identifierValue(
                member,
                "Member",
                `Authority Conflict ${index} candidate ${candidateIndex} Member ID`,
              ),
            );
            if ((outcome === 1) !== (joinRequestId !== null && memberId !== null)) {
              throw new TypeError("Invitation Conflict candidate outcome is inconsistent");
            }
            return {
              headRecordId: identifierValue(
                mapValue(candidate, 0),
                "VaultRecord",
                `Authority Conflict ${index} candidate ${candidateIndex} head`,
              ),
              outcome,
              authorityReceiptId: byteString(
                mapValue(candidate, 2),
                32,
                `Authority Conflict ${index} candidate ${candidateIndex} receipt ID`,
              ),
              joinRequestId,
              memberId,
            };
          },
          { nonempty: true },
        ),
      });
      return value;
    }
    if (kind === 2) {
      const memberId = identifierValue(
        mapValue(conflict, 1),
        "Member",
        `Authority Conflict ${index} Member ID`,
      );
      recoveryConflicts.push({
        memberId,
        candidates: decodeSet(
          mapValue(conflict, 2),
          `Authority Conflict ${index} candidates`,
          (candidateValue, candidateIndex) => {
            const candidate = exactMap(
              candidateValue,
              [0, 1],
              `Authority Conflict ${index} candidate ${candidateIndex}`,
            );
            return {
              headRecordId: identifierValue(
                mapValue(candidate, 0),
                "VaultRecord",
                `Authority Conflict ${index} candidate ${candidateIndex} head`,
              ),
              recoveryCredentialId: identifierValue(
                mapValue(candidate, 1),
                "RecoveryCredential",
                `Authority Conflict ${index} candidate ${candidateIndex} Credential ID`,
              ),
            };
          },
          { nonempty: true },
        ),
      });
      return value;
    }
    if (kind === 3) {
      const subject = identifierValue(
        mapValue(conflict, 1),
        "Vault",
        `Authority Conflict ${index} Vault ID`,
      );
      if (!bytesEqual(subject, input.vaultId)) {
        throw new TypeError("Key Epoch Conflict belongs to another Vault");
      }
      keyEpochConflicts.push({
        candidates: decodeSet(
          mapValue(conflict, 2),
          `Authority Conflict ${index} candidates`,
          (candidateValue, candidateIndex) => {
            const candidate = exactMap(
              candidateValue,
              [0, 1],
              `Authority Conflict ${index} candidate ${candidateIndex}`,
            );
            return {
              headRecordId: identifierValue(
                mapValue(candidate, 0),
                "VaultRecord",
                `Authority Conflict ${index} candidate ${candidateIndex} head`,
              ),
              keyEpochId: identifierValue(
                mapValue(candidate, 1),
                "KeyEpoch",
                `Authority Conflict ${index} candidate ${candidateIndex} Epoch ID`,
              ),
            };
          },
          { nonempty: true },
        ),
      });
      return value;
    }
    const memberId = identifierValue(
      mapValue(conflict, 1),
      "Member",
      `Authority Conflict ${index} Member ID`,
    );
    administratorConflicts.push({
      memberId,
      candidates: decodeSet(
        mapValue(conflict, 2),
        `Authority Conflict ${index} candidates`,
        (candidateValue, candidateIndex) => {
          const candidate = exactMap(
            candidateValue,
            [0, 1],
            `Authority Conflict ${index} candidate ${candidateIndex}`,
          );
          return {
            headRecordId: identifierValue(
              mapValue(candidate, 0),
              "VaultRecord",
              `Authority Conflict ${index} candidate ${candidateIndex} head`,
            ),
            administrator: booleanValue(
              mapValue(candidate, 1),
              `Authority Conflict ${index} candidate ${candidateIndex} state`,
            ),
          };
        },
        { nonempty: true },
      ),
    });
    return value;
  });
  const writeFences = decodeSet(
    mapValue(checkpoint, 9),
    "Active Authority fences",
    (value, index): CanonicalAuthorityWriteFence => {
      const fence = exactMap(value, [0, 1, 2], `Authority fence ${index}`);
      const kind = decodeFenceKind(mapValue(fence, 0));
      const subjectKind =
        kind === "member-removal"
          ? "Member"
          : kind === "client-credential-removal"
            ? "ClientCredential"
            : kind === "invitation-conflict"
              ? "Invitation"
              : "Vault";
      const subjectId = identifierValue(
        mapValue(fence, 1),
        subjectKind,
        `Authority fence ${index} subject ID`,
      );
      if (kind === "key-epoch-conflict" && !bytesEqual(subjectId, input.vaultId)) {
        throw new TypeError("Key Epoch fence belongs to another Vault");
      }
      return {
        kind,
        subjectId,
        causeRecordIds: idSetValue(
          mapValue(fence, 2),
          "VaultRecord",
          `Authority fence ${index} cause Record IDs`,
          { nonempty: true },
        ),
      };
    },
  );
  if (
    !bytesEqual(
      requiredFeatureSetId(input.featureManifests.map(({ manifest }) => manifest)),
      input.requiredFeatureSetId,
    )
  ) {
    throw new TypeError("Checkpoint Feature Manifests do not match the Required Feature Set");
  }
  return {
    activeMemberIds,
    administratorIds,
    administratorConflicts,
    activeInvitations,
    invitationConflicts,
    recoveryCredentials,
    recoveryConflicts,
    keyEpochs,
    keyEpochConflicts,
    keyEnvelopeSlots,
    requiredFeatureSetId: input.requiredFeatureSetId,
    featureManifests: input.featureManifests,
    featureSetConflict: null,
    writeFences,
    clientCredentials,
    lifecycle: input.lifecycle,
  };
}

export function encodeCanonicalAuthorityCheckpoint(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly authority: CanonicalAuthorityState;
}): CanonicalValue {
  const { authority } = input;
  if (authority.lifecycle !== 1) {
    throw new TypeError("A Closed Authority State cannot become a continuing Baseline");
  }
  if (authority.featureSetConflict !== null) {
    throw new TypeError("An incompatible Required Feature Set cannot be checkpointed");
  }
  const activeMemberIds = new Set(authority.activeMemberIds.map(key));
  const clientCertificates = [...authority.clientCredentials.values()]
    .filter(({ active, memberId }) => active && activeMemberIds.has(key(memberId)))
    .map(({ clientCredentialId, memberId, signingPublicKey, wrappingPublicKey }) =>
      canonicalMap([
        [0, clientCredentialId],
        [1, memberId],
        [2, signingPublicKey],
        [3, wrappingPublicKey],
      ]),
    );
  const recoveryCredentials = authority.recoveryCredentials
    .filter(({ effective, memberId }) => effective && activeMemberIds.has(key(memberId)))
    .map(({ recoveryCredentialId, memberId, revision, signingPublicKey, wrappingPublicKey }) =>
      canonicalMap([
        [0, recoveryCredentialId],
        [1, memberId],
        [2, revision],
        [3, signingPublicKey],
        [4, wrappingPublicKey],
      ]),
    );
  const activeInvitations = authority.activeInvitations.map((invitation) =>
    canonicalMap([
      [0, invitation.invitationId],
      [1, invitation.redemptionVerifier],
      [2, invitation.cancellationVerifier],
      [3, invitation.capabilities],
      [4, invitation.creationRecordId],
      [5, invitation.redemptionAuthorityId],
      [6, invitation.receiptVerificationKey],
    ]),
  );
  const keyEpochs = authority.keyEpochs.map(({ keyEpochId, displayNumber, current }) =>
    canonicalMap([
      [0, keyEpochId],
      [1, displayNumber],
      [2, current],
    ]),
  );
  const envelopeSlots = authority.keyEnvelopeSlots.map((slot) =>
    canonicalMap([
      [0, slot.keyEpochId],
      [1, slot.targetKind],
      [2, slot.targetCredentialId],
      [3, slot.targetRevision],
      [4, slot.keyEnvelopeId],
    ]),
  );
  const activeConflicts = [
    ...authority.invitationConflicts.map((conflict) =>
      canonicalMap([
        [0, 1],
        [1, conflict.invitationId],
        [
          2,
          canonicalSet(
            conflict.candidates.map((candidate) =>
              canonicalMap([
                [0, candidate.headRecordId],
                [1, candidate.outcome],
                [2, candidate.authorityReceiptId],
                [3, candidate.joinRequestId],
                [4, candidate.memberId],
              ]),
            ),
          ),
        ],
      ]),
    ),
    ...authority.recoveryConflicts.map((conflict) =>
      canonicalMap([
        [0, 2],
        [1, conflict.memberId],
        [
          2,
          canonicalSet(
            conflict.candidates.map((candidate) =>
              canonicalMap([
                [0, candidate.headRecordId],
                [1, candidate.recoveryCredentialId],
              ]),
            ),
          ),
        ],
      ]),
    ),
    ...authority.keyEpochConflicts.map((conflict) =>
      canonicalMap([
        [0, 3],
        [1, input.vaultId],
        [
          2,
          canonicalSet(
            conflict.candidates.map((candidate) =>
              canonicalMap([
                [0, candidate.headRecordId],
                [1, candidate.keyEpochId],
              ]),
            ),
          ),
        ],
      ]),
    ),
    ...authority.administratorConflicts.map((conflict) =>
      canonicalMap([
        [0, 4],
        [1, conflict.memberId],
        [
          2,
          canonicalSet(
            conflict.candidates.map((candidate) =>
              canonicalMap([
                [0, candidate.headRecordId],
                [1, candidate.administrator],
              ]),
            ),
          ),
        ],
      ]),
    ),
  ];
  const activeFences = authority.writeFences.map((fence) =>
    canonicalMap([
      [0, fenceKind(fence)],
      [1, fence.subjectId],
      [2, canonicalSet(fence.causeRecordIds)],
    ]),
  );
  return canonicalMap([
    [0, 1],
    [1, canonicalSet(authority.activeMemberIds)],
    [2, canonicalSet(authority.administratorIds)],
    [3, canonicalSet(clientCertificates)],
    [4, canonicalSet(recoveryCredentials)],
    [5, canonicalSet(activeInvitations)],
    [6, canonicalSet(keyEpochs)],
    [7, canonicalSet(envelopeSlots)],
    [8, canonicalSet(activeConflicts)],
    [9, canonicalSet(activeFences)],
  ]);
}
