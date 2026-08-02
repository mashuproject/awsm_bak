import { sha256 } from "@noble/hashes/sha2.js";

import { readySodium } from "../../crypto/sodium";
import type { Identifier } from "../../domain/canonical/identifiers";
import {
  type AuthenticatedVaultEvent,
  verifyVaultEventSignature,
} from "../../domain/canonical/record";
import { CausalGraph, causalMaxima } from "../../domain/canonical/reducers";
import {
  byteString,
  canonicalSetValue,
  exactMap,
  identifierValue,
  idSetValue,
  mapValue,
  nonnegativeInteger,
  nullable,
  oneOfCodes,
} from "../../domain/canonical/schema";
import { transcript } from "../../domain/canonical/transcript";
import {
  type CanonicalMapKey,
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import { initialVaultClientAuthority } from "../vault/canonical-open";

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareIds(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < shared; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function containsId(values: readonly Uint8Array[], candidate: Uint8Array): boolean {
  return values.some((value) => bytesEqual(value, candidate));
}

export interface CanonicalAuthorityClientCredential {
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly memberId: Identifier<"Member">;
  readonly signingPublicKey: Uint8Array;
  readonly wrappingPublicKey: Uint8Array;
  readonly active: boolean;
}

export interface CanonicalAuthorityState {
  readonly activeMemberIds: readonly Identifier<"Member">[];
  readonly administratorIds: readonly Identifier<"Member">[];
  readonly administratorConflicts: readonly {
    readonly memberId: Identifier<"Member">;
    readonly candidateRecordIds: readonly Identifier<"VaultRecord">[];
  }[];
  readonly activeInvitations: readonly CanonicalAuthorityInvitation[];
  readonly invitationConflicts: readonly CanonicalAuthorityInvitationConflict[];
  readonly recoveryCredentials: readonly CanonicalAuthorityRecoveryCredential[];
  readonly recoveryConflicts: readonly {
    readonly memberId: Identifier<"Member">;
    readonly candidateRecordIds: readonly Identifier<"VaultRecord">[];
    readonly recoveryCredentialIds: readonly Identifier<"RecoveryCredential">[];
  }[];
  readonly keyEpochs: readonly CanonicalAuthorityKeyEpoch[];
  readonly writeFences: readonly CanonicalAuthorityWriteFence[];
  readonly clientCredentials: ReadonlyMap<string, CanonicalAuthorityClientCredential>;
  readonly lifecycle: 1 | 2;
}

export interface CanonicalAuthorityWriteFence {
  readonly kind: "member-removal" | "client-credential-removal" | "invitation-conflict";
  readonly subjectId: Uint8Array;
  readonly causeRecordIds: readonly Identifier<"VaultRecord">[];
}

export interface CanonicalAuthorityInvitationConflictCandidate {
  readonly headRecordId: Identifier<"VaultRecord">;
  readonly outcome: 1 | 2;
  readonly authorityReceiptId: Uint8Array;
  readonly joinRequestId: Uint8Array | null;
  readonly memberId: Identifier<"Member"> | null;
}

export interface CanonicalAuthorityInvitationConflict {
  readonly invitationId: Identifier<"Invitation">;
  readonly candidates: readonly CanonicalAuthorityInvitationConflictCandidate[];
}

export interface CanonicalAuthorityRecoveryCredential {
  readonly recoveryCredentialId: Identifier<"RecoveryCredential">;
  readonly memberId: Identifier<"Member">;
  readonly revision: number;
  readonly signingPublicKey: Uint8Array;
  readonly wrappingPublicKey: Uint8Array;
  readonly effective: boolean;
}

export interface CanonicalAuthorityKeyEpoch {
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly displayNumber: number;
  readonly current: boolean;
}

export interface CanonicalAuthorityInvitation {
  readonly invitationId: Identifier<"Invitation">;
  readonly issuerMemberId: Identifier<"Member">;
  readonly capabilities: CanonicalValue;
  readonly redemptionVerifier: Uint8Array;
  readonly cancellationVerifier: Uint8Array;
  readonly redemptionAuthorityId: Uint8Array;
  readonly receiptVerificationKey: Uint8Array;
  readonly creationRecordId: Identifier<"VaultRecord">;
}

interface AdministratorFact {
  readonly memberId: Identifier<"Member">;
  readonly causeId: Identifier<"VaultRecord">;
  readonly administrator: boolean;
}

interface AcceptedInvitation {
  readonly invitationId: Identifier<"Invitation">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredential: Omit<CanonicalAuthorityClientCredential, "active">;
  readonly recoveryCredential: Omit<CanonicalAuthorityRecoveryCredential, "effective">;
  readonly administrator: boolean;
  readonly joinRequestId: Uint8Array;
  readonly authorityReceiptId: Uint8Array;
  readonly capabilitiesBytes: Uint8Array;
  readonly joinRequestPrefixBytes: Uint8Array;
  readonly clientPossessionSignature: Uint8Array;
  readonly recoveryPossessionSignature: Uint8Array;
  readonly redemptionSignature: Uint8Array;
  readonly receiptPrefixBytes: Uint8Array;
  readonly receiptSignature: Uint8Array;
  readonly envelopeSlots: readonly InvitationEnvelopeSlot[];
}

interface InvitationTerminalFact extends CanonicalAuthorityInvitationConflictCandidate {
  readonly causeId: Identifier<"VaultRecord">;
  readonly invitationId: Identifier<"Invitation">;
  readonly acceptance: AcceptedInvitation | null;
}

interface InvitationEnvelopeSlot {
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly targetKind: 1 | 2;
  readonly targetCredentialId: Uint8Array;
  readonly targetRevision: number | null;
  readonly keyEnvelopeId: Identifier<"KeyEnvelope">;
}

interface CancelledInvitation {
  readonly invitationId: Identifier<"Invitation">;
  readonly cancellationRequestId: Uint8Array;
  readonly authorityReceiptId: Uint8Array;
  readonly authorityChallenge: Uint8Array;
  readonly cancellationSignature: Uint8Array;
  readonly receiptPrefixBytes: Uint8Array;
  readonly receiptSignature: Uint8Array;
}

interface ResolvedInvitation {
  readonly invitationId: Identifier<"Invitation">;
  readonly conflictingReceiptIds: readonly Uint8Array[];
  readonly conflictingRecordIds: readonly Identifier<"VaultRecord">[];
  readonly outcome: 1 | 2;
  readonly selectedJoinRequestId: Uint8Array | null;
  readonly rejectedConsumedRecordIds: readonly Identifier<"VaultRecord">[];
}

interface ClientCredentialEnrollment {
  readonly memberId: Identifier<"Member">;
  readonly clientCredential: Omit<CanonicalAuthorityClientCredential, "active">;
  readonly authorizationKind: 1 | 2;
  readonly recoveryCredentialId: Identifier<"RecoveryCredential"> | null;
  readonly recoveryAuthorization: Uint8Array | null;
  readonly proposalBytes: Uint8Array;
  readonly proposalPrefixBytes: Uint8Array;
  readonly possessionSignature: Uint8Array;
  readonly envelopeSlots: readonly InvitationEnvelopeSlot[];
}

interface RecoveryCredentialReplacement {
  readonly memberId: Identifier<"Member">;
  readonly replacedRecoveryCredentialIds: readonly Identifier<"RecoveryCredential">[];
  readonly recoveryCredential: Omit<CanonicalAuthorityRecoveryCredential, "effective">;
  readonly replacementCredentialBytes: Uint8Array;
  readonly envelopeSlotsBytes: Uint8Array;
  readonly envelopeSlots: readonly InvitationEnvelopeSlot[];
  readonly possessionSignature: Uint8Array;
}

export class CanonicalAuthorityReplay {
  readonly #anchorRecordId: Identifier<"VaultRecord">;
  readonly #firstMemberId: Identifier<"Member">;
  readonly #initialCredential: CanonicalAuthorityClientCredential;
  readonly #initialRecoveryCredential: CanonicalAuthorityRecoveryCredential;
  readonly #initialKeyEpoch: CanonicalAuthorityKeyEpoch;
  readonly #graph = new CausalGraph();
  readonly #events: AuthenticatedVaultEvent[] = [];
  readonly #acceptedInvitations = new Map<string, AcceptedInvitation>();
  readonly #cancelledInvitations = new Map<string, CancelledInvitation>();
  readonly #resolvedInvitations = new Map<string, ResolvedInvitation>();
  readonly #clientEnrollments = new Map<string, ClientCredentialEnrollment>();
  readonly #recoveryReplacements = new Map<string, RecoveryCredentialReplacement>();

  constructor(
    genesis: AuthenticatedVaultEvent,
    anchorRecordId: Identifier<"VaultRecord"> = genesis.recordId,
  ) {
    const initial = initialVaultClientAuthority(genesis);
    this.#anchorRecordId = anchorRecordId;
    this.#firstMemberId = initial.memberId;
    this.#initialCredential = {
      clientCredentialId: initial.clientCredentialId,
      memberId: initial.memberId,
      signingPublicKey: initial.signingPublicKey,
      wrappingPublicKey: initial.wrappingPublicKey,
      active: true,
    };
    const genesisBody = exactMap(genesis.body, [0, 1, 2, 3, 4, 5, 6], "Genesis body");
    const recovery = exactMap(
      mapValue(genesisBody, 3),
      [0, 1, 2, 3, 4],
      "Genesis Recovery Credential",
    );
    this.#initialRecoveryCredential = {
      recoveryCredentialId: identifierValue(
        mapValue(recovery, 0),
        "RecoveryCredential",
        "Genesis Recovery Credential ID",
      ),
      memberId: identifierValue(mapValue(recovery, 1), "Member", "Genesis Recovery Member ID"),
      revision: 0,
      signingPublicKey: byteString(
        mapValue(recovery, 3),
        32,
        "Genesis Recovery signing public key",
      ),
      wrappingPublicKey: byteString(
        mapValue(recovery, 4),
        32,
        "Genesis Recovery wrapping public key",
      ),
      effective: true,
    };
    this.#initialKeyEpoch = {
      keyEpochId: identifierValue(mapValue(genesisBody, 4), "KeyEpoch", "Genesis Key Epoch ID"),
      displayNumber: 0,
      current: true,
    };
    this.#graph.add(anchorRecordId, []);
  }

  stateAt(frontier: readonly Identifier<"VaultRecord">[]): CanonicalAuthorityState {
    if (frontier.length === 0 || frontier.some((recordId) => !this.#graph.has(recordId))) {
      throw new TypeError("Authority Frontier references an unknown Record");
    }
    const terminalFactsByInvitation = new Map<string, InvitationTerminalFact[]>();
    for (const event of this.#events) {
      if (event.family !== 1 || !this.#isIncluded(event.recordId, frontier)) continue;
      let fact: InvitationTerminalFact | undefined;
      if (event.type === 6) {
        const acceptance = this.#acceptedInvitations.get(key(event.recordId));
        if (acceptance === undefined) throw new TypeError("Invitation Acceptance state is missing");
        fact = {
          causeId: event.recordId,
          headRecordId: event.recordId,
          invitationId: acceptance.invitationId,
          outcome: 1,
          authorityReceiptId: acceptance.authorityReceiptId,
          joinRequestId: acceptance.joinRequestId,
          memberId: acceptance.memberId,
          acceptance,
        };
      } else if (event.type === 7) {
        const cancellation = this.#cancelledInvitations.get(key(event.recordId));
        if (cancellation === undefined) {
          throw new TypeError("Invitation Cancellation state is missing");
        }
        fact = {
          causeId: event.recordId,
          headRecordId: event.recordId,
          invitationId: cancellation.invitationId,
          outcome: 2,
          authorityReceiptId: cancellation.authorityReceiptId,
          joinRequestId: null,
          memberId: null,
          acceptance: null,
        };
      }
      if (fact === undefined) continue;
      const facts = terminalFactsByInvitation.get(key(fact.invitationId)) ?? [];
      facts.push(fact);
      terminalFactsByInvitation.set(key(fact.invitationId), facts);
    }
    const effectiveAcceptanceRecordIds = new Set<string>();
    const invitationConflicts: CanonicalAuthorityInvitationConflict[] = [];
    const resolutionsByInvitation = new Map<
      string,
      { readonly causeId: Identifier<"VaultRecord">; readonly resolution: ResolvedInvitation }[]
    >();
    for (const event of this.#events) {
      if (event.family !== 1 || event.type !== 8 || !this.#isIncluded(event.recordId, frontier)) {
        continue;
      }
      const resolution = this.#resolvedInvitations.get(key(event.recordId));
      if (resolution === undefined) throw new TypeError("Invitation Resolution state is missing");
      const resolutions = resolutionsByInvitation.get(key(resolution.invitationId)) ?? [];
      resolutions.push({ causeId: event.recordId, resolution });
      resolutionsByInvitation.set(key(resolution.invitationId), resolutions);
    }
    const effectiveResolutions = new Map<
      string,
      { readonly causeId: Identifier<"VaultRecord">; readonly resolution: ResolvedInvitation }
    >();
    for (const [invitationKey, resolutions] of resolutionsByInvitation) {
      const heads = causalMaxima(resolutions, this.#graph);
      if (heads.length !== 1) {
        throw new TypeError("Concurrent Invitation Conflict Resolutions cannot yet be reduced");
      }
      effectiveResolutions.set(invitationKey, heads[0] as (typeof heads)[number]);
    }
    const resolvedInvitationFences: {
      readonly invitationId: Identifier<"Invitation">;
      readonly causeRecordIds: readonly Identifier<"VaultRecord">[];
    }[] = [];
    for (const facts of terminalFactsByInvitation.values()) {
      const heads = [...causalMaxima(facts, this.#graph)].sort((left, right) =>
        compareIds(left.headRecordId, right.headRecordId),
      );
      const invitationId = heads[0]?.invitationId;
      if (invitationId === undefined) throw new TypeError("Invitation terminal state is empty");
      const resolved = effectiveResolutions.get(key(invitationId));
      if (resolved !== undefined) {
        if (
          heads.some(({ headRecordId }) => !this.#graph.isAncestor(headRecordId, resolved.causeId))
        ) {
          throw new TypeError("Invitation Resolution is concurrent with a terminal candidate");
        }
        if (resolved.resolution.selectedJoinRequestId !== null) {
          const selectedHeads = heads.filter(
            ({ outcome, joinRequestId }) =>
              outcome === 1 &&
              joinRequestId !== null &&
              bytesEqual(joinRequestId, resolved.resolution.selectedJoinRequestId as Uint8Array),
          );
          if (selectedHeads.length === 0) {
            throw new TypeError("Invitation Resolution selected candidate is unavailable");
          }
          for (const selectedHead of selectedHeads) {
            effectiveAcceptanceRecordIds.add(key(selectedHead.headRecordId));
          }
        }
        if (resolved.resolution.rejectedConsumedRecordIds.length > 0) {
          resolvedInvitationFences.push({
            invitationId,
            causeRecordIds: resolved.resolution.rejectedConsumedRecordIds,
          });
        }
        continue;
      }
      const outcomes = new Set(
        heads.map((candidate) =>
          candidate.outcome === 1
            ? `1:${key(candidate.joinRequestId as Uint8Array)}:${key(candidate.memberId as Uint8Array)}`
            : "2",
        ),
      );
      if (outcomes.size > 1) {
        invitationConflicts.push({
          invitationId,
          candidates: heads.map(
            ({ headRecordId, outcome, authorityReceiptId, joinRequestId, memberId }) => ({
              headRecordId,
              outcome,
              authorityReceiptId,
              joinRequestId,
              memberId,
            }),
          ),
        });
      } else {
        for (const accepted of heads.filter(({ outcome }) => outcome === 1)) {
          effectiveAcceptanceRecordIds.add(key(accepted.headRecordId));
        }
      }
    }
    invitationConflicts.sort((left, right) => compareIds(left.invitationId, right.invitationId));

    const activeMembers = new Map([[key(this.#firstMemberId), this.#firstMemberId]]);
    const permanentMemberRequests = new Map([[key(this.#firstMemberId), "genesis"]]);
    const administratorFacts: AdministratorFact[] = [
      {
        memberId: this.#firstMemberId,
        causeId: this.#anchorRecordId,
        administrator: true,
      },
    ];
    let explicitlyClosed = false;
    for (const event of this.#events) {
      if (!this.#isIncluded(event.recordId, frontier)) continue;
      if (event.family === 1 && event.type === 6) {
        const acceptance = this.#acceptedInvitations.get(key(event.recordId));
        if (acceptance === undefined) throw new TypeError("Invitation Acceptance state is missing");
        const priorRequest = permanentMemberRequests.get(key(acceptance.memberId));
        const requestKey = key(acceptance.joinRequestId);
        if (priorRequest !== undefined && priorRequest !== requestKey) {
          throw new TypeError("Invitation Acceptance reuses a permanent Member identity");
        }
        permanentMemberRequests.set(key(acceptance.memberId), requestKey);
        if (!effectiveAcceptanceRecordIds.has(key(event.recordId))) continue;
        activeMembers.set(key(acceptance.memberId), acceptance.memberId);
        if (acceptance.administrator) {
          administratorFacts.push({
            memberId: acceptance.memberId,
            causeId: event.recordId,
            administrator: true,
          });
        }
      } else if (event.family === 1 && event.type === 2) {
        const body = exactMap(event.body, [0], "Membership End Event body");
        const memberId = identifierValue(mapValue(body, 0), "Member", "Target Member ID");
        activeMembers.delete(key(memberId));
      } else if (event.family === 1 && (event.type === 3 || event.type === 4)) {
        const body = exactMap(event.body, [0, 1], "Administrator role Event body");
        administratorFacts.push({
          memberId: identifierValue(mapValue(body, 0), "Member", "Target Member ID"),
          causeId: event.recordId,
          administrator: event.type === 3,
        });
      } else if (event.family === 3 && event.type === 2) {
        explicitlyClosed = true;
      }
    }
    const activeMemberIds = [...activeMembers.values()].sort(compareIds);
    const administratorIds: Identifier<"Member">[] = [];
    const administratorConflicts: CanonicalAuthorityState["administratorConflicts"][number][] = [];
    const factsByMember = new Map<string, AdministratorFact[]>();
    for (const fact of administratorFacts) {
      const facts = factsByMember.get(key(fact.memberId)) ?? [];
      facts.push(fact);
      factsByMember.set(key(fact.memberId), facts);
    }
    for (const facts of factsByMember.values()) {
      const memberId = facts[0]?.memberId;
      if (memberId === undefined || !activeMembers.has(key(memberId))) continue;
      const heads = causalMaxima(facts, this.#graph);
      if (
        heads.some(({ administrator }) => administrator) &&
        heads.some(({ administrator }) => !administrator)
      ) {
        administratorConflicts.push({
          memberId,
          candidateRecordIds: heads.map(({ causeId }) => causeId).sort(compareIds),
        });
      } else if (heads[0]?.administrator === true) {
        administratorIds.push(memberId);
      }
    }
    administratorIds.sort(compareIds);
    administratorConflicts.sort((left, right) => compareIds(left.memberId, right.memberId));
    const activeInvitations = new Map<string, CanonicalAuthorityInvitation>();
    const invitationBodies = new Map<string, Uint8Array>();
    for (const event of this.#events) {
      if (event.family !== 1 || event.type !== 5 || !this.#isIncluded(event.recordId, frontier)) {
        continue;
      }
      const invitation = invitationCreation(event);
      const invitationKey = key(invitation.invitationId);
      const bodyBytes = encodeCanonicalValue(event.body);
      const priorBody = invitationBodies.get(invitationKey);
      if (priorBody !== undefined && !bytesEqual(priorBody, bodyBytes)) {
        throw new TypeError("Invitation ID has incompatible authenticated creation facts");
      }
      invitationBodies.set(invitationKey, bodyBytes);
      activeInvitations.set(invitationKey, invitation);
    }
    for (const event of this.#events) {
      if (event.family !== 1 || !this.#isIncluded(event.recordId, frontier)) continue;
      if (event.type === 6) {
        const acceptance = this.#acceptedInvitations.get(key(event.recordId));
        if (acceptance === undefined) throw new TypeError("Invitation Acceptance state is missing");
        activeInvitations.delete(key(acceptance.invitationId));
      } else if (event.type === 7) {
        const cancellation = this.#cancelledInvitations.get(key(event.recordId));
        if (cancellation === undefined) {
          throw new TypeError("Invitation Cancellation state is missing");
        }
        activeInvitations.delete(key(cancellation.invitationId));
      }
    }
    const endedCredentialIds = new Set(
      this.#events.flatMap((event) => {
        if (
          event.family !== 1 ||
          event.type !== 10 ||
          !this.#isIncluded(event.recordId, frontier)
        ) {
          return [];
        }
        const body = exactMap(event.body, [0], "Client Credential End Event body");
        return [
          key(
            identifierValue(mapValue(body, 0), "ClientCredential", "Target Client Credential ID"),
          ),
        ];
      }),
    );
    const recoveryFenceCauses = new Map<string, Identifier<"VaultRecord">[]>();
    for (const replacementEvent of this.#events) {
      if (
        replacementEvent.family !== 1 ||
        replacementEvent.type !== 11 ||
        !this.#isIncluded(replacementEvent.recordId, frontier)
      ) {
        continue;
      }
      const replacement = this.#recoveryReplacements.get(key(replacementEvent.recordId));
      if (replacement === undefined) {
        throw new TypeError("Recovery Credential Replacement state is missing");
      }
      for (const recoveryCredentialId of replacement.replacedRecoveryCredentialIds) {
        const fenceKey = `${key(replacement.memberId)}:${key(recoveryCredentialId)}`;
        const causes = recoveryFenceCauses.get(fenceKey) ?? [];
        causes.push(replacementEvent.recordId);
        recoveryFenceCauses.set(fenceKey, causes);
      }
    }
    const dominatedRecoveryEnrollmentRecordIds = new Set<string>();
    for (const enrollmentEvent of this.#events) {
      if (
        enrollmentEvent.family !== 1 ||
        enrollmentEvent.type !== 9 ||
        !this.#isIncluded(enrollmentEvent.recordId, frontier)
      ) {
        continue;
      }
      const enrollment = this.#clientEnrollments.get(key(enrollmentEvent.recordId));
      if (
        enrollment === undefined ||
        enrollment.authorizationKind !== 2 ||
        enrollment.recoveryCredentialId === null
      ) {
        continue;
      }
      const fenceKey = `${key(enrollment.memberId)}:${key(enrollment.recoveryCredentialId)}`;
      if (
        recoveryFenceCauses
          .get(fenceKey)
          ?.some((causeId) => !this.#graph.isAncestor(enrollmentEvent.recordId, causeId)) === true
      ) {
        dominatedRecoveryEnrollmentRecordIds.add(key(enrollmentEvent.recordId));
      }
    }
    const clientCredentials = new Map<string, CanonicalAuthorityClientCredential>();
    const addClientCredential = (
      credential: Omit<CanonicalAuthorityClientCredential, "active">,
      eligible = true,
    ): void => {
      const active =
        eligible &&
        activeMembers.has(key(credential.memberId)) &&
        !endedCredentialIds.has(key(credential.clientCredentialId));
      const existing = clientCredentials.get(key(credential.clientCredentialId));
      if (existing !== undefined) {
        if (
          !bytesEqual(existing.memberId, credential.memberId) ||
          !bytesEqual(existing.signingPublicKey, credential.signingPublicKey) ||
          !bytesEqual(existing.wrappingPublicKey, credential.wrappingPublicKey)
        ) {
          throw new TypeError("Authority State reuses a Client Credential identity");
        }
        if (active && !existing.active) {
          clientCredentials.set(key(credential.clientCredentialId), { ...existing, active: true });
        }
        return;
      }
      clientCredentials.set(key(credential.clientCredentialId), {
        ...credential,
        active,
      });
    };
    addClientCredential(this.#initialCredential);
    const recoveryCredentialCandidates = new Map<
      string,
      Omit<CanonicalAuthorityRecoveryCredential, "effective">
    >();
    const recoveryCredentialCauseIds = new Map<string, Identifier<"VaultRecord">>();
    const addRecoveryCredential = (
      credential: Omit<CanonicalAuthorityRecoveryCredential, "effective">,
      causeId: Identifier<"VaultRecord">,
    ): void => {
      const existing = recoveryCredentialCandidates.get(key(credential.recoveryCredentialId));
      if (existing !== undefined) {
        if (
          !bytesEqual(existing.memberId, credential.memberId) ||
          existing.revision !== credential.revision ||
          !bytesEqual(existing.signingPublicKey, credential.signingPublicKey) ||
          !bytesEqual(existing.wrappingPublicKey, credential.wrappingPublicKey)
        ) {
          throw new TypeError("Authority State reuses a Recovery Credential identity");
        }
        return;
      }
      recoveryCredentialCandidates.set(key(credential.recoveryCredentialId), credential);
      recoveryCredentialCauseIds.set(key(credential.recoveryCredentialId), causeId);
    };
    addRecoveryCredential(
      {
        recoveryCredentialId: this.#initialRecoveryCredential.recoveryCredentialId,
        memberId: this.#initialRecoveryCredential.memberId,
        revision: this.#initialRecoveryCredential.revision,
        signingPublicKey: this.#initialRecoveryCredential.signingPublicKey,
        wrappingPublicKey: this.#initialRecoveryCredential.wrappingPublicKey,
      },
      this.#anchorRecordId,
    );
    const replacedRecoveryCredentialIds = new Set<string>();
    for (const event of this.#events) {
      if (event.family !== 1 || !this.#isIncluded(event.recordId, frontier)) {
        continue;
      }
      if (event.type === 9) {
        const enrollment = this.#clientEnrollments.get(key(event.recordId));
        if (enrollment === undefined) {
          throw new TypeError("Client Credential Enrollment state is missing");
        }
        addClientCredential(
          enrollment.clientCredential,
          !dominatedRecoveryEnrollmentRecordIds.has(key(event.recordId)),
        );
        continue;
      }
      if (event.type === 6) {
        const acceptance = this.#acceptedInvitations.get(key(event.recordId));
        if (acceptance === undefined) throw new TypeError("Invitation Acceptance state is missing");
        addClientCredential(acceptance.clientCredential);
        addRecoveryCredential(acceptance.recoveryCredential, event.recordId);
        continue;
      }
      if (event.type !== 11) continue;
      const replacement = this.#recoveryReplacements.get(key(event.recordId));
      if (replacement === undefined) {
        throw new TypeError("Recovery Credential Replacement state is missing");
      }
      addRecoveryCredential(replacement.recoveryCredential, event.recordId);
      for (const recoveryCredentialId of replacement.replacedRecoveryCredentialIds) {
        replacedRecoveryCredentialIds.add(key(recoveryCredentialId));
      }
    }
    const recoveryCredentials = [...recoveryCredentialCandidates.values()].map(
      (credential): CanonicalAuthorityRecoveryCredential => ({
        ...credential,
        effective:
          activeMembers.has(key(credential.memberId)) &&
          !replacedRecoveryCredentialIds.has(key(credential.recoveryCredentialId)),
      }),
    );
    const effectiveRecoveryByMember = new Map<string, CanonicalAuthorityRecoveryCredential[]>();
    for (const credential of recoveryCredentials.filter(({ effective }) => effective)) {
      const credentials = effectiveRecoveryByMember.get(key(credential.memberId)) ?? [];
      credentials.push(credential);
      effectiveRecoveryByMember.set(key(credential.memberId), credentials);
    }
    const recoveryConflicts = [...effectiveRecoveryByMember.values()]
      .filter((credentials) => credentials.length > 1)
      .map((credentials) => {
        const memberId = credentials[0]?.memberId;
        if (memberId === undefined) throw new TypeError("Recovery Conflict has no Member");
        return {
          memberId,
          candidateRecordIds: credentials
            .map(({ recoveryCredentialId }) => {
              const causeId = recoveryCredentialCauseIds.get(key(recoveryCredentialId));
              if (causeId === undefined) {
                throw new TypeError("Recovery Conflict candidate has no authority Cause");
              }
              return causeId;
            })
            .sort(compareIds),
          recoveryCredentialIds: credentials
            .map(({ recoveryCredentialId }) => recoveryCredentialId)
            .sort(compareIds),
        };
      })
      .sort((left, right) => compareIds(left.memberId, right.memberId));
    const writeFences = new Map<string, CanonicalAuthorityWriteFence>();
    for (const conflict of invitationConflicts) {
      const causeRecordIds = conflict.candidates
        .filter(({ outcome }) => outcome === 1)
        .map(({ headRecordId }) => headRecordId)
        .sort(compareIds);
      if (causeRecordIds.length === 0) continue;
      writeFences.set(`invitation-conflict:${key(conflict.invitationId)}`, {
        kind: "invitation-conflict",
        subjectId: conflict.invitationId,
        causeRecordIds,
      });
    }
    for (const fence of resolvedInvitationFences) {
      writeFences.set(`invitation-conflict:${key(fence.invitationId)}`, {
        kind: "invitation-conflict",
        subjectId: fence.invitationId,
        causeRecordIds: [...fence.causeRecordIds].sort(compareIds),
      });
    }
    for (const event of this.#events) {
      if (event.family !== 1 || !this.#isIncluded(event.recordId, frontier)) {
        continue;
      }
      if (event.type === 2) {
        const signer = clientCredentials.get(key(event.signerCredentialId));
        if (signer === undefined) throw new TypeError("Membership End signer has no Credential");
        const body = exactMap(event.body, [0], "Membership End Event body");
        const targetMemberId = identifierValue(mapValue(body, 0), "Member", "Target Member ID");
        if (bytesEqual(signer.memberId, targetMemberId)) continue;
        const fenceKey = `member-removal:${key(targetMemberId)}`;
        const existing = writeFences.get(fenceKey);
        writeFences.set(fenceKey, {
          kind: "member-removal",
          subjectId: targetMemberId,
          causeRecordIds: [...(existing?.causeRecordIds ?? []), event.recordId].sort(compareIds),
        });
      } else if (event.type === 10) {
        const signer = clientCredentials.get(key(event.signerCredentialId));
        if (signer === undefined) {
          throw new TypeError("Client Credential End signer has no Credential");
        }
        const body = exactMap(event.body, [0], "Client Credential End Event body");
        const targetCredentialId = identifierValue(
          mapValue(body, 0),
          "ClientCredential",
          "Target Client Credential ID",
        );
        const target = clientCredentials.get(key(targetCredentialId));
        if (target === undefined) {
          throw new TypeError("Client Credential End target has no Credential");
        }
        if (bytesEqual(signer.memberId, target.memberId)) continue;
        const fenceKey = `client-credential-removal:${key(targetCredentialId)}`;
        const existing = writeFences.get(fenceKey);
        writeFences.set(fenceKey, {
          kind: "client-credential-removal",
          subjectId: targetCredentialId,
          causeRecordIds: [...(existing?.causeRecordIds ?? []), event.recordId].sort(compareIds),
        });
      }
    }
    return {
      activeMemberIds,
      administratorIds,
      administratorConflicts,
      activeInvitations: [...activeInvitations.values()].sort((left, right) =>
        compareIds(left.invitationId, right.invitationId),
      ),
      invitationConflicts,
      recoveryCredentials: recoveryCredentials.sort((left, right) =>
        compareIds(left.recoveryCredentialId, right.recoveryCredentialId),
      ),
      recoveryConflicts,
      keyEpochs: [this.#initialKeyEpoch],
      writeFences: [...writeFences.values()].sort((left, right) =>
        compareIds(left.subjectId, right.subjectId),
      ),
      clientCredentials,
      lifecycle:
        explicitlyClosed || (administratorIds.length === 0 && administratorConflicts.length === 0)
          ? 2
          : 1,
    };
  }

  async validateAndAccept(event: AuthenticatedVaultEvent): Promise<void> {
    const parentState = this.stateAt(event.authorityParentRecordIds);
    if (parentState.lifecycle === 2) {
      throw new TypeError("An Event cannot descend from Closed Authority State");
    }
    const enrollment =
      event.family === 1 && event.type === 9 ? parseClientCredentialEnrollment(event) : null;
    let signer: CanonicalAuthorityClientCredential;
    if (enrollment?.authorizationKind === 2) {
      if (!bytesEqual(event.signerCredentialId, enrollment.clientCredential.clientCredentialId)) {
        throw new TypeError("Recovery-authorized Enrollment signer is not the proposed Credential");
      }
      signer = { ...enrollment.clientCredential, active: false };
    } else {
      const activeSigner = parentState.clientCredentials.get(key(event.signerCredentialId));
      if (activeSigner === undefined || !activeSigner.active) {
        throw new TypeError("Vault Event signer is not an active Client Credential");
      }
      signer = activeSigner;
    }
    if (!(await verifyVaultEventSignature(event, signer.signingPublicKey))) {
      throw new TypeError("Vault Event signature is invalid");
    }

    if (event.family === 1) {
      if (event.type === 2) {
        const body = exactMap(event.body, [0], "Membership End Event body");
        const targetMemberId = identifierValue(mapValue(body, 0), "Member", "Target Member ID");
        if (!containsId(parentState.activeMemberIds, targetMemberId)) {
          throw new TypeError("Membership End target is not an active Member");
        }
        if (
          !bytesEqual(signer.memberId, targetMemberId) &&
          !containsId(parentState.administratorIds, signer.memberId)
        ) {
          throw new TypeError("Membership End signer is not authorized for the target Member");
        }
      } else if (event.type === 3 || event.type === 4) {
        const body = exactMap(event.body, [0, 1], "Administrator role Event body");
        const targetMemberId = identifierValue(mapValue(body, 0), "Member", "Target Member ID");
        const resolvedRecordIds = idSetValue(
          mapValue(body, 1),
          "VaultRecord",
          "Resolved Administrator Record IDs",
        );
        if (!containsId(parentState.administratorIds, signer.memberId)) {
          throw new TypeError("Administrator role Event signer is not an Administrator");
        }
        if (!containsId(parentState.activeMemberIds, targetMemberId)) {
          throw new TypeError("Administrator role target is not an active Member");
        }
        const conflict = parentState.administratorConflicts.find(({ memberId }) =>
          bytesEqual(memberId, targetMemberId),
        );
        if (conflict === undefined) {
          if (resolvedRecordIds.length !== 0) {
            throw new TypeError("Ordinary Administrator role change cannot resolve Record IDs");
          }
          const targetIsAdministrator = containsId(parentState.administratorIds, targetMemberId);
          if ((event.type === 3) === targetIsAdministrator) {
            throw new TypeError("Administrator role change does not change the target state");
          }
        } else if (!sameIdSet(resolvedRecordIds, conflict.candidateRecordIds)) {
          throw new TypeError("Administrator role resolution does not name every candidate");
        }
      } else if (event.type === 10) {
        const body = exactMap(event.body, [0], "Client Credential End Event body");
        const targetCredentialId = identifierValue(
          mapValue(body, 0),
          "ClientCredential",
          "Target Client Credential ID",
        );
        const target = parentState.clientCredentials.get(key(targetCredentialId));
        if (target === undefined || !target.active) {
          throw new TypeError("Client Credential End target is not active");
        }
        const sameMember = bytesEqual(signer.memberId, target.memberId);
        if (
          !bytesEqual(signer.clientCredentialId, targetCredentialId) &&
          !sameMember &&
          !containsId(parentState.administratorIds, signer.memberId)
        ) {
          throw new TypeError("Client Credential End signer is not authorized for the target");
        }
      } else if (event.type === 5) {
        if (!containsId(parentState.administratorIds, signer.memberId)) {
          throw new TypeError("Invitation Creation signer is not an Administrator");
        }
        const invitation = invitationCreation(event);
        if (!bytesEqual(invitation.issuerMemberId, signer.memberId)) {
          throw new TypeError("Invitation capability issuer is not the signing Administrator");
        }
        const existing = parentState.activeInvitations.find(({ invitationId }) =>
          bytesEqual(invitationId, invitation.invitationId),
        );
        if (existing !== undefined) {
          throw new TypeError("Invitation ID is already active");
        }
      } else if (event.type === 6) {
        const acceptance = parseInvitationAcceptance(event);
        const invitation = parentState.activeInvitations.find(({ invitationId }) =>
          bytesEqual(invitationId, acceptance.invitationId),
        );
        if (invitation === undefined) {
          throw new TypeError("Invitation Acceptance does not name an Active Invitation");
        }
        if (
          [...parentState.clientCredentials.values()].some(({ memberId }) =>
            bytesEqual(memberId, acceptance.memberId),
          )
        ) {
          throw new TypeError("Invitation Acceptance reuses a permanent Member identity");
        }
        if (
          parentState.clientCredentials.has(key(acceptance.clientCredential.clientCredentialId)) ||
          parentState.recoveryCredentials.some(({ recoveryCredentialId }) =>
            bytesEqual(recoveryCredentialId, acceptance.recoveryCredential.recoveryCredentialId),
          )
        ) {
          throw new TypeError("Invitation Acceptance reuses an existing authority identity");
        }
        if (
          !bytesEqual(encodeCanonicalValue(invitation.capabilities), acceptance.capabilitiesBytes)
        ) {
          throw new TypeError("Invitation Acceptance capabilities differ from the Invitation");
        }
        await verifyInvitationAcceptance(acceptance, invitation);
        validateInvitationAcceptanceSlots(acceptance, parentState);
        this.#acceptedInvitations.set(key(event.recordId), acceptance);
      } else if (event.type === 7) {
        const cancellation = parseInvitationCancellation(event);
        const invitation = parentState.activeInvitations.find(({ invitationId }) =>
          bytesEqual(invitationId, cancellation.invitationId),
        );
        if (invitation === undefined) {
          throw new TypeError("Invitation Cancellation does not name an Active Invitation");
        }
        await verifyInvitationCancellation(cancellation, invitation);
        this.#cancelledInvitations.set(key(event.recordId), cancellation);
      } else if (event.type === 8) {
        if (!containsId(parentState.administratorIds, signer.memberId)) {
          throw new TypeError("Invitation Conflict Resolution signer is not an Administrator");
        }
        const resolution = parseInvitationResolution(event);
        const conflict = parentState.invitationConflicts.find(({ invitationId }) =>
          bytesEqual(invitationId, resolution.invitationId),
        );
        if (conflict === undefined) {
          throw new TypeError("Invitation Conflict Resolution has no current Conflict");
        }
        if (
          !sameIdSet(
            resolution.conflictingReceiptIds,
            conflict.candidates.map(({ authorityReceiptId }) => authorityReceiptId),
          ) ||
          !sameIdSet(
            resolution.conflictingRecordIds,
            conflict.candidates.map(({ headRecordId }) => headRecordId),
          )
        ) {
          throw new TypeError("Invitation Conflict Resolution does not name every candidate");
        }
        const selectedCandidates = conflict.candidates.filter(
          ({ outcome, joinRequestId }) =>
            outcome === 1 &&
            resolution.selectedJoinRequestId !== null &&
            joinRequestId !== null &&
            bytesEqual(joinRequestId, resolution.selectedJoinRequestId),
        );
        if (
          (resolution.outcome === 1 && selectedCandidates.length === 0) ||
          (resolution.outcome === 2 && selectedCandidates.length !== 0)
        ) {
          throw new TypeError("Invitation Conflict Resolution selected candidate is invalid");
        }
        if (
          resolution.outcome === 1 &&
          !selectedCandidates.some(({ headRecordId }) =>
            this.#acceptedInvitations.has(key(headRecordId)),
          )
        ) {
          throw new TypeError("Invitation Conflict Resolution selected Acceptance is unavailable");
        }
        this.#resolvedInvitations.set(key(event.recordId), {
          ...resolution,
          rejectedConsumedRecordIds: conflict.candidates
            .filter(
              ({ outcome, joinRequestId }) =>
                outcome === 1 &&
                (resolution.selectedJoinRequestId === null ||
                  joinRequestId === null ||
                  !bytesEqual(joinRequestId, resolution.selectedJoinRequestId)),
            )
            .map(({ headRecordId }) => headRecordId),
        });
      } else if (event.type === 9) {
        if (enrollment === null) throw new TypeError("Client Enrollment state is missing");
        if (!containsId(parentState.activeMemberIds, enrollment.memberId)) {
          throw new TypeError("Client Enrollment target is not an active Member");
        }
        if (
          enrollment.authorizationKind === 1 &&
          !bytesEqual(enrollment.memberId, signer.memberId)
        ) {
          throw new TypeError("Client Enrollment signer does not belong to the target Member");
        }
        if (
          parentState.clientCredentials.has(key(enrollment.clientCredential.clientCredentialId))
        ) {
          throw new TypeError("Client Enrollment reuses a Client Credential identity");
        }
        await verifyClientCredentialEnrollmentPossession(enrollment);
        if (enrollment.authorizationKind === 2) {
          await verifyRecoveryClientCredentialEnrollment(enrollment, parentState);
        }
        validateClientCredentialEnrollmentSlots(enrollment, parentState);
        this.#clientEnrollments.set(key(event.recordId), enrollment);
      } else if (event.type === 11) {
        const replacement = parseRecoveryCredentialReplacement(event);
        if (!bytesEqual(replacement.memberId, signer.memberId)) {
          throw new TypeError("Recovery Credential Replacement signer is not the target Member");
        }
        const effectiveCredentials = parentState.recoveryCredentials.filter(
          ({ memberId, effective }) => effective && bytesEqual(memberId, replacement.memberId),
        );
        if (
          !sameIdSet(
            replacement.replacedRecoveryCredentialIds,
            effectiveCredentials.map(({ recoveryCredentialId }) => recoveryCredentialId),
          )
        ) {
          throw new TypeError("Recovery Replacement does not name every effective Credential");
        }
        if (
          parentState.recoveryCredentials.some(({ recoveryCredentialId }) =>
            bytesEqual(recoveryCredentialId, replacement.recoveryCredential.recoveryCredentialId),
          )
        ) {
          throw new TypeError("Recovery Replacement reuses a Recovery Credential identity");
        }
        const expectedRevision =
          effectiveCredentials.reduce((maximum, { revision }) => Math.max(maximum, revision), -1) +
          1;
        if (replacement.recoveryCredential.revision !== expectedRevision) {
          throw new TypeError("Recovery Replacement revision does not follow its effective heads");
        }
        await verifyRecoveryCredentialReplacement(replacement, event);
        validateRecoveryCredentialReplacementSlots(replacement, parentState);
        this.#recoveryReplacements.set(key(event.recordId), replacement);
      } else {
        throw new TypeError("This replay slice cannot yet reduce this Authority Event type");
      }
      this.#acceptAuthorityNode(event);
      return;
    }
    if (event.family === 3) {
      if (event.type !== 2) {
        throw new TypeError("This replay slice cannot yet reduce this Lifecycle Event type");
      }
      if (!containsId(parentState.administratorIds, signer.memberId)) {
        throw new TypeError("Explicit Closure signer is not an Administrator");
      }
      this.#acceptAuthorityNode(event);
    }
  }

  reachableRecordIds(
    frontier: readonly Identifier<"VaultRecord">[],
  ): readonly Identifier<"VaultRecord">[] {
    this.stateAt(frontier);
    return [
      this.#anchorRecordId,
      ...this.#events
        .filter((event) => this.#isIncluded(event.recordId, frontier))
        .map((event) => event.recordId),
    ].sort(compareIds);
  }

  #acceptAuthorityNode(event: AuthenticatedVaultEvent): void {
    this.#graph.add(event.recordId, event.authorityParentRecordIds);
    this.#events.push(event);
  }

  #isIncluded(
    recordId: Identifier<"VaultRecord">,
    frontier: readonly Identifier<"VaultRecord">[],
  ): boolean {
    return frontier.some(
      (root) => bytesEqual(recordId, root) || this.#graph.isAncestor(recordId, root),
    );
  }
}

function parseInvitationCancellation(event: AuthenticatedVaultEvent): CancelledInvitation {
  const body = exactMap(event.body, [0, 1], "Invitation Cancellation Event body");
  const request = exactMap(mapValue(body, 0), [0, 1, 2], "Invitation Cancellation Request");
  const receipt = exactMap(mapValue(body, 1), [...Array(6).keys()], "Cancelled Invitation receipt");
  return {
    invitationId: identifierValue(mapValue(request, 0), "Invitation", "Cancelled Invitation ID"),
    cancellationRequestId: byteString(mapValue(receipt, 2), 32, "Cancellation Request ID"),
    authorityReceiptId: byteString(mapValue(receipt, 4), 32, "Cancellation Authority receipt ID"),
    authorityChallenge: byteString(
      mapValue(request, 1),
      32,
      "Invitation Cancellation authority challenge",
    ),
    cancellationSignature: byteString(
      mapValue(request, 2),
      64,
      "Invitation Cancellation signature",
    ),
    receiptPrefixBytes: encodeCanonicalValue(canonicalNumericPrefix(receipt, 4)),
    receiptSignature: byteString(
      mapValue(receipt, 5),
      64,
      "Invitation Cancellation receipt signature",
    ),
  };
}

function parseInvitationResolution(
  event: AuthenticatedVaultEvent,
): Omit<ResolvedInvitation, "rejectedConsumedRecordIds"> {
  const body = exactMap(event.body, [0, 1, 2, 3, 4], "Invitation Conflict Resolution body");
  const outcome = oneOfCodes(mapValue(body, 3), [1, 2] as const, "Invitation resolution outcome");
  const selectedJoinRequestId = nullable(mapValue(body, 4), (value) =>
    byteString(value, 32, "Selected Invitation Join Request ID"),
  );
  if ((outcome === 1) !== (selectedJoinRequestId !== null)) {
    throw new TypeError("Invitation Resolution outcome does not match its selected request");
  }
  return {
    invitationId: identifierValue(mapValue(body, 0), "Invitation", "Resolved Invitation ID"),
    conflictingReceiptIds: canonicalSetValue(
      mapValue(body, 1),
      "Conflicting Invitation receipt IDs",
      (value) => byteString(value, 32, "Invitation receipt ID"),
      { nonempty: true },
    ),
    conflictingRecordIds: idSetValue(
      mapValue(body, 2),
      "VaultRecord",
      "Conflicting Invitation Record IDs",
      { nonempty: true },
    ),
    outcome,
    selectedJoinRequestId,
  };
}

function parseClientCredentialEnrollment(
  event: AuthenticatedVaultEvent,
): ClientCredentialEnrollment {
  const body = exactMap(event.body, [0, 1, 2, 3], "Client Credential Enrollment body");
  const proposalValue = mapValue(body, 0);
  const proposal = exactMap(
    proposalValue,
    [0, 1, 2, 3, 4, 5],
    "Client Credential Enrollment Proposal",
  );
  const memberId = identifierValue(mapValue(proposal, 1), "Member", "Enrollment Member ID");
  const certificate = exactMap(mapValue(proposal, 3), [0, 1, 2, 3], "Proposed Client Certificate");
  const envelopeSlots = parseEnvelopeSlots(
    mapValue(proposal, 4),
    "Client Credential Enrollment Envelope slots",
  );
  const authorizationKind = oneOfCodes(
    mapValue(body, 1),
    [1, 2] as const,
    "Enrollment authorization kind",
  );
  const recoveryCredentialId = nullable(mapValue(body, 2), (entry) =>
    identifierValue(entry, "RecoveryCredential", "Authorizing Recovery Credential ID"),
  );
  const recoveryAuthorization = nullable(mapValue(body, 3), (entry) =>
    byteString(entry, 64, "Recovery enrollment authorization"),
  );
  if (
    (authorizationKind === 2) !==
    (recoveryCredentialId !== null && recoveryAuthorization !== null)
  ) {
    throw new TypeError("Recovery authorization fields do not match enrollment kind");
  }
  return {
    memberId,
    clientCredential: {
      clientCredentialId: identifierValue(
        mapValue(certificate, 0),
        "ClientCredential",
        "Proposed Client Credential ID",
      ),
      memberId,
      signingPublicKey: byteString(
        mapValue(certificate, 2),
        32,
        "Proposed Client signing public key",
      ),
      wrappingPublicKey: byteString(
        mapValue(certificate, 3),
        32,
        "Proposed Client wrapping public key",
      ),
    },
    authorizationKind,
    recoveryCredentialId,
    recoveryAuthorization,
    proposalBytes: encodeCanonicalValue(proposalValue),
    proposalPrefixBytes: encodeCanonicalValue(canonicalNumericPrefix(proposal, 4)),
    possessionSignature: byteString(
      mapValue(proposal, 5),
      64,
      "Proposed Client possession signature",
    ),
    envelopeSlots,
  };
}

function parseEnvelopeSlots(
  value: CanonicalValue,
  field: string,
): readonly InvitationEnvelopeSlot[] {
  return canonicalSetValue(value, field, (entry) => entry, { nonempty: true }).map(
    (entry, index): InvitationEnvelopeSlot => {
      const slot = exactMap(entry, [0, 1, 2, 3, 4], `${field}[${index}]`);
      const targetKind = oneOfCodes(
        mapValue(slot, 1),
        [1, 2] as const,
        `${field}[${index}] target kind`,
      );
      return {
        keyEpochId: identifierValue(
          mapValue(slot, 0),
          "KeyEpoch",
          `${field}[${index}] Key Epoch ID`,
        ),
        targetKind,
        targetCredentialId: identifierValue(
          mapValue(slot, 2),
          targetKind === 1 ? "RecoveryCredential" : "ClientCredential",
          `${field}[${index}] target Credential ID`,
        ),
        targetRevision: nullable(mapValue(slot, 3), (targetRevision) =>
          nonnegativeInteger(targetRevision, `${field}[${index}] target revision`),
        ),
        keyEnvelopeId: identifierValue(
          mapValue(slot, 4),
          "KeyEnvelope",
          `${field}[${index}] Key Envelope ID`,
        ),
      };
    },
  );
}

function parseRecoveryCredentialReplacement(
  event: AuthenticatedVaultEvent,
): RecoveryCredentialReplacement {
  const body = exactMap(event.body, [0, 1, 2, 3, 4], "Recovery Credential Replacement body");
  const memberId = identifierValue(mapValue(body, 0), "Member", "Recovery Replacement Member ID");
  const descriptorValue = mapValue(body, 2);
  const descriptor = exactMap(descriptorValue, [0, 1, 2, 3, 4], "Replacement Recovery Credential");
  const envelopeSlotsValue = mapValue(body, 3);
  return {
    memberId,
    replacedRecoveryCredentialIds: idSetValue(
      mapValue(body, 1),
      "RecoveryCredential",
      "Replaced Recovery Credential IDs",
      { nonempty: true },
    ),
    recoveryCredential: {
      recoveryCredentialId: identifierValue(
        mapValue(descriptor, 0),
        "RecoveryCredential",
        "Replacement Recovery Credential ID",
      ),
      memberId,
      revision: nonnegativeInteger(mapValue(descriptor, 2), "Replacement Recovery revision"),
      signingPublicKey: byteString(
        mapValue(descriptor, 3),
        32,
        "Replacement Recovery signing public key",
      ),
      wrappingPublicKey: byteString(
        mapValue(descriptor, 4),
        32,
        "Replacement Recovery wrapping public key",
      ),
    },
    replacementCredentialBytes: encodeCanonicalValue(descriptorValue),
    envelopeSlotsBytes: encodeCanonicalValue(envelopeSlotsValue),
    envelopeSlots: parseEnvelopeSlots(envelopeSlotsValue, "Recovery Replacement Envelope slots"),
    possessionSignature: byteString(
      mapValue(body, 4),
      64,
      "Recovery replacement possession signature",
    ),
  };
}

async function verifyRecoveryCredentialReplacement(
  replacement: RecoveryCredentialReplacement,
  event: AuthenticatedVaultEvent,
): Promise<void> {
  const sodium = await readySodium();
  if (
    !sodium.crypto_sign_verify_detached(
      replacement.possessionSignature,
      transcript("awsm:recovery-replacement-possession:v1", [
        event.vaultId,
        replacement.memberId,
        encodeCanonicalValue(canonicalSet(event.authorityParentRecordIds)),
        replacement.replacementCredentialBytes,
        replacement.envelopeSlotsBytes,
      ]),
      replacement.recoveryCredential.signingPublicKey,
    )
  ) {
    throw new TypeError("Recovery Credential Replacement possession signature is invalid");
  }
}

function validateRecoveryCredentialReplacementSlots(
  replacement: RecoveryCredentialReplacement,
  authority: CanonicalAuthorityState,
): void {
  const expected = new Set(
    authority.keyEpochs.map(
      ({ keyEpochId }) =>
        `${key(keyEpochId)}:1:${key(replacement.recoveryCredential.recoveryCredentialId)}:${replacement.recoveryCredential.revision}`,
    ),
  );
  const actual = new Set(
    replacement.envelopeSlots.map(
      (slot) =>
        `${key(slot.keyEpochId)}:${slot.targetKind}:${key(slot.targetCredentialId)}:${slot.targetRevision === null ? "null" : slot.targetRevision}`,
    ),
  );
  if (actual.size !== expected.size || [...expected].some((slot) => !actual.has(slot))) {
    throw new TypeError("Recovery Replacement Envelope slots are not the complete set");
  }
}

async function verifyClientCredentialEnrollmentPossession(
  enrollment: ClientCredentialEnrollment,
): Promise<void> {
  const sodium = await readySodium();
  if (
    !sodium.crypto_sign_verify_detached(
      enrollment.possessionSignature,
      transcript("awsm:client-enrollment-proposal:v1", [enrollment.proposalPrefixBytes]),
      enrollment.clientCredential.signingPublicKey,
    )
  ) {
    throw new TypeError("Client Credential Enrollment possession signature is invalid");
  }
}

async function verifyRecoveryClientCredentialEnrollment(
  enrollment: ClientCredentialEnrollment,
  authority: CanonicalAuthorityState,
): Promise<void> {
  if (enrollment.recoveryCredentialId === null || enrollment.recoveryAuthorization === null) {
    throw new TypeError("Recovery-authorized Enrollment is missing its authorization");
  }
  const authorizingRecoveryCredentialId = enrollment.recoveryCredentialId;
  const recovery = authority.recoveryCredentials.find(({ recoveryCredentialId }) =>
    bytesEqual(recoveryCredentialId, authorizingRecoveryCredentialId),
  );
  if (
    recovery === undefined ||
    !recovery.effective ||
    !bytesEqual(recovery.memberId, enrollment.memberId)
  ) {
    throw new TypeError("Client Enrollment Recovery Credential is not effective for the Member");
  }
  const proposalId = sha256(
    transcript("awsm:client-enrollment-proposal-id:v1", [enrollment.proposalBytes]),
  );
  const sodium = await readySodium();
  if (
    !sodium.crypto_sign_verify_detached(
      enrollment.recoveryAuthorization,
      transcript("awsm:recovery-client-enrollment-authorization:v1", [proposalId]),
      recovery.signingPublicKey,
    )
  ) {
    throw new TypeError("Client Enrollment Recovery authorization is invalid");
  }
}

function validateClientCredentialEnrollmentSlots(
  enrollment: ClientCredentialEnrollment,
  authority: CanonicalAuthorityState,
): void {
  const expected = new Set(
    authority.keyEpochs.map(
      ({ keyEpochId }) =>
        `${key(keyEpochId)}:2:${key(enrollment.clientCredential.clientCredentialId)}:null`,
    ),
  );
  const actual = new Set(
    enrollment.envelopeSlots.map(
      (slot) =>
        `${key(slot.keyEpochId)}:${slot.targetKind}:${key(slot.targetCredentialId)}:${slot.targetRevision === null ? "null" : slot.targetRevision}`,
    ),
  );
  if (actual.size !== expected.size || [...expected].some((slot) => !actual.has(slot))) {
    throw new TypeError("Client Credential Enrollment Envelope slots are not the complete set");
  }
}

async function verifyInvitationCancellation(
  cancellation: CancelledInvitation,
  invitation: CanonicalAuthorityInvitation,
): Promise<void> {
  const sodium = await readySodium();
  if (
    !sodium.crypto_sign_verify_detached(
      cancellation.cancellationSignature,
      transcript("awsm:invitation-cancel-request:v1", [
        cancellation.invitationId,
        cancellation.authorityChallenge,
      ]),
      invitation.cancellationVerifier,
    ) ||
    !sodium.crypto_sign_verify_detached(
      cancellation.receiptSignature,
      transcript("awsm:invitation-receipt:v1", [cancellation.receiptPrefixBytes]),
      invitation.receiptVerificationKey,
    )
  ) {
    throw new TypeError("Invitation Cancellation request or receipt signature is invalid");
  }
}

function sameIdSet(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left.map(key));
  return right.every((value) => expected.has(key(value)));
}

function invitationCreation(event: AuthenticatedVaultEvent): CanonicalAuthorityInvitation {
  const body = exactMap(event.body, [0, 1, 2, 3, 4, 5], "Invitation Creation Event body");
  const capabilityValues = canonicalSetValue(
    mapValue(body, 1),
    "Invitation capabilities",
    (entry) => entry,
    { nonempty: true },
  );
  let issuerMemberId: Identifier<"Member"> | undefined;
  for (const [index, value] of capabilityValues.entries()) {
    const capability = exactMap(value, [0, 1, 2, 3, 4], `Invitation capability[${index}]`);
    const issuer = identifierValue(
      mapValue(capability, 1),
      "Member",
      `Invitation capability[${index}] issuer`,
    );
    if (issuerMemberId !== undefined && !bytesEqual(issuerMemberId, issuer)) {
      throw new TypeError("Invitation capabilities do not have one issuer Member");
    }
    issuerMemberId = issuer;
  }
  if (issuerMemberId === undefined) throw new TypeError("Invitation has no capability issuer");
  return {
    invitationId: identifierValue(mapValue(body, 0), "Invitation", "Invitation ID"),
    issuerMemberId,
    capabilities: mapValue(body, 1),
    redemptionVerifier: byteString(mapValue(body, 2), 32, "Invitation Redemption verifier"),
    cancellationVerifier: byteString(mapValue(body, 3), 32, "Invitation Cancellation verifier"),
    redemptionAuthorityId: byteString(mapValue(body, 4), 32, "Invitation Redemption Authority ID"),
    receiptVerificationKey: byteString(
      mapValue(body, 5),
      32,
      "Invitation receipt verification key",
    ),
    creationRecordId: event.recordId,
  };
}

function parseInvitationAcceptance(event: AuthenticatedVaultEvent): AcceptedInvitation {
  const body = exactMap(event.body, [0, 1, 2], "Invitation Acceptance Event body");
  const join = exactMap(mapValue(body, 0), [...Array(8).keys()], "Invitation Join Request");
  const proposal = exactMap(
    mapValue(body, 1),
    [...Array(8).keys()],
    "Invitation Acceptance Proposal",
  );
  const receipt = exactMap(mapValue(body, 2), [...Array(6).keys()], "Consumed Invitation receipt");
  const memberId = identifierValue(mapValue(join, 2), "Member", "Proposed Member ID");
  const certificate = exactMap(mapValue(join, 3), [0, 1, 2, 3], "Proposed Client Certificate");
  const recovery = exactMap(mapValue(join, 4), [0, 1, 2, 3, 4], "Proposed Recovery Credential");
  const capabilities = canonicalSetValue(
    mapValue(join, 1),
    "Granted portable capabilities",
    (entry) => entry,
    { nonempty: true },
  );
  const administrator = capabilities.some((value, index) => {
    const capability = exactMap(value, [0, 1, 2, 3, 4], `Granted capability[${index}]`);
    return mapValue(capability, 3) === "awsm.vault.administrator";
  });
  const envelopeSlots = parseEnvelopeSlots(
    mapValue(proposal, 7),
    "Invitation Acceptance Envelope slots",
  );
  return {
    invitationId: identifierValue(mapValue(join, 0), "Invitation", "Invitation ID"),
    memberId,
    clientCredential: {
      clientCredentialId: identifierValue(
        mapValue(certificate, 0),
        "ClientCredential",
        "Proposed Client Credential ID",
      ),
      memberId,
      signingPublicKey: byteString(
        mapValue(certificate, 2),
        32,
        "Proposed Client signing public key",
      ),
      wrappingPublicKey: byteString(
        mapValue(certificate, 3),
        32,
        "Proposed Client wrapping public key",
      ),
    },
    recoveryCredential: {
      recoveryCredentialId: identifierValue(
        mapValue(recovery, 0),
        "RecoveryCredential",
        "Proposed Recovery Credential ID",
      ),
      memberId,
      revision: nonnegativeInteger(mapValue(recovery, 2), "Proposed Recovery revision"),
      signingPublicKey: byteString(
        mapValue(recovery, 3),
        32,
        "Proposed Recovery signing public key",
      ),
      wrappingPublicKey: byteString(
        mapValue(recovery, 4),
        32,
        "Proposed Recovery wrapping public key",
      ),
    },
    administrator,
    joinRequestId: byteString(mapValue(proposal, 1), 32, "Invitation Join Request ID"),
    authorityReceiptId: byteString(mapValue(receipt, 4), 32, "Invitation Authority receipt ID"),
    capabilitiesBytes: encodeCanonicalValue(mapValue(join, 1)),
    joinRequestPrefixBytes: encodeCanonicalValue(canonicalNumericPrefix(join, 4)),
    clientPossessionSignature: byteString(
      mapValue(join, 5),
      64,
      "Invitation Client possession signature",
    ),
    recoveryPossessionSignature: byteString(
      mapValue(join, 6),
      64,
      "Invitation Recovery possession signature",
    ),
    redemptionSignature: byteString(mapValue(join, 7), 64, "Invitation Redemption signature"),
    receiptPrefixBytes: encodeCanonicalValue(canonicalNumericPrefix(receipt, 4)),
    receiptSignature: byteString(mapValue(receipt, 5), 64, "Invitation receipt signature"),
    envelopeSlots,
  };
}

export function canonicalAuthorityKeyEnvelopeRequirements(
  event: AuthenticatedVaultEvent,
): readonly {
  readonly keyEnvelopeId: Identifier<"KeyEnvelope">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
}[] {
  if (event.family !== 1) return [];
  const slots =
    event.type === 6
      ? parseInvitationAcceptance(event).envelopeSlots
      : event.type === 9
        ? parseClientCredentialEnrollment(event).envelopeSlots
        : event.type === 11
          ? parseRecoveryCredentialReplacement(event).envelopeSlots
          : [];
  return slots.map(({ keyEnvelopeId, keyEpochId }) => ({ keyEnvelopeId, keyEpochId }));
}

async function verifyInvitationAcceptance(
  acceptance: AcceptedInvitation,
  invitation: CanonicalAuthorityInvitation,
): Promise<void> {
  const sodium = await readySodium();
  const joinProof = transcript("awsm:invitation-join-request:v1", [
    acceptance.joinRequestPrefixBytes,
  ]);
  if (
    !sodium.crypto_sign_verify_detached(
      acceptance.clientPossessionSignature,
      joinProof,
      acceptance.clientCredential.signingPublicKey,
    ) ||
    !sodium.crypto_sign_verify_detached(
      acceptance.recoveryPossessionSignature,
      joinProof,
      acceptance.recoveryCredential.signingPublicKey,
    ) ||
    !sodium.crypto_sign_verify_detached(
      acceptance.redemptionSignature,
      joinProof,
      invitation.redemptionVerifier,
    ) ||
    !sodium.crypto_sign_verify_detached(
      acceptance.receiptSignature,
      transcript("awsm:invitation-receipt:v1", [acceptance.receiptPrefixBytes]),
      invitation.receiptVerificationKey,
    )
  ) {
    throw new TypeError("Invitation Acceptance possession or receipt signature is invalid");
  }
}

function validateInvitationAcceptanceSlots(
  acceptance: AcceptedInvitation,
  authority: CanonicalAuthorityState,
): void {
  const expected = new Set<string>();
  for (const epoch of authority.keyEpochs) {
    expected.add(
      `${key(epoch.keyEpochId)}:1:${key(acceptance.recoveryCredential.recoveryCredentialId)}:${acceptance.recoveryCredential.revision}`,
    );
    expected.add(
      `${key(epoch.keyEpochId)}:2:${key(acceptance.clientCredential.clientCredentialId)}:null`,
    );
  }
  const actual = new Set(
    acceptance.envelopeSlots.map(
      (slot) =>
        `${key(slot.keyEpochId)}:${slot.targetKind}:${key(slot.targetCredentialId)}:${slot.targetRevision === null ? "null" : slot.targetRevision}`,
    ),
  );
  if (actual.size !== expected.size || [...expected].some((slot) => !actual.has(slot))) {
    throw new TypeError("Invitation Acceptance Envelope slots are not the complete target set");
  }
}

function canonicalNumericPrefix(
  value: ReadonlyMap<CanonicalMapKey, CanonicalValue>,
  lastKey: number,
): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap(
    Array.from({ length: lastKey + 1 }, (_, field) => [field, mapValue(value, field)] as const),
  );
}
