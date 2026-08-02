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
  readonly recoveryCredentials: readonly CanonicalAuthorityRecoveryCredential[];
  readonly keyEpochs: readonly CanonicalAuthorityKeyEpoch[];
  readonly writeFences: readonly CanonicalAuthorityWriteFence[];
  readonly clientCredentials: ReadonlyMap<string, CanonicalAuthorityClientCredential>;
  readonly lifecycle: 1 | 2;
}

export interface CanonicalAuthorityWriteFence {
  readonly kind: "member-removal" | "client-credential-removal";
  readonly subjectId: Uint8Array;
  readonly causeRecordIds: readonly Identifier<"VaultRecord">[];
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
  readonly capabilitiesBytes: Uint8Array;
  readonly joinRequestPrefixBytes: Uint8Array;
  readonly clientPossessionSignature: Uint8Array;
  readonly recoveryPossessionSignature: Uint8Array;
  readonly redemptionSignature: Uint8Array;
  readonly receiptPrefixBytes: Uint8Array;
  readonly receiptSignature: Uint8Array;
  readonly envelopeSlots: readonly InvitationEnvelopeSlot[];
}

interface InvitationEnvelopeSlot {
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly targetKind: 1 | 2;
  readonly targetCredentialId: Uint8Array;
  readonly targetRevision: number | null;
  readonly keyEnvelopeId: Identifier<"KeyEnvelope">;
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
    const activeMembers = new Map([[key(this.#firstMemberId), this.#firstMemberId]]);
    const permanentMemberIds = new Set([key(this.#firstMemberId)]);
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
        if (permanentMemberIds.has(key(acceptance.memberId))) {
          throw new TypeError("Invitation Acceptance reuses a permanent Member identity");
        }
        permanentMemberIds.add(key(acceptance.memberId));
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
      if (event.family === 1 && event.type === 6 && this.#isIncluded(event.recordId, frontier)) {
        const acceptance = this.#acceptedInvitations.get(key(event.recordId));
        if (acceptance === undefined) throw new TypeError("Invitation Acceptance state is missing");
        activeInvitations.delete(key(acceptance.invitationId));
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
    const clientCredentials = new Map<string, CanonicalAuthorityClientCredential>();
    const addClientCredential = (
      credential: Omit<CanonicalAuthorityClientCredential, "active">,
    ): void => {
      if (clientCredentials.has(key(credential.clientCredentialId))) {
        throw new TypeError("Authority State reuses a Client Credential identity");
      }
      clientCredentials.set(key(credential.clientCredentialId), {
        ...credential,
        active:
          activeMembers.has(key(credential.memberId)) &&
          !endedCredentialIds.has(key(credential.clientCredentialId)),
      });
    };
    addClientCredential(this.#initialCredential);
    const recoveryCredentials: CanonicalAuthorityRecoveryCredential[] = [
      {
        ...this.#initialRecoveryCredential,
        effective: activeMembers.has(key(this.#initialRecoveryCredential.memberId)),
      },
    ];
    for (const event of this.#events) {
      if (event.family !== 1 || event.type !== 6 || !this.#isIncluded(event.recordId, frontier)) {
        continue;
      }
      const acceptance = this.#acceptedInvitations.get(key(event.recordId));
      if (acceptance === undefined) throw new TypeError("Invitation Acceptance state is missing");
      addClientCredential(acceptance.clientCredential);
      if (
        recoveryCredentials.some(({ recoveryCredentialId }) =>
          bytesEqual(recoveryCredentialId, acceptance.recoveryCredential.recoveryCredentialId),
        )
      ) {
        throw new TypeError("Authority State reuses a Recovery Credential identity");
      }
      recoveryCredentials.push({
        ...acceptance.recoveryCredential,
        effective: activeMembers.has(key(acceptance.memberId)),
      });
    }
    const writeFences = new Map<string, CanonicalAuthorityWriteFence>();
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
      recoveryCredentials: recoveryCredentials.sort((left, right) =>
        compareIds(left.recoveryCredentialId, right.recoveryCredentialId),
      ),
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
    const signer = parentState.clientCredentials.get(key(event.signerCredentialId));
    if (signer === undefined || !signer.active) {
      throw new TypeError("Vault Event signer is not an active Client Credential");
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
  const envelopeSlots = canonicalSetValue(
    mapValue(proposal, 7),
    "Invitation Acceptance Envelope slots",
    (entry) => entry,
    { nonempty: true },
  ).map((value, index): InvitationEnvelopeSlot => {
    const slot = exactMap(value, [0, 1, 2, 3, 4], `Invitation Envelope slot[${index}]`);
    const targetKind = oneOfCodes(
      mapValue(slot, 1),
      [1, 2] as const,
      `Invitation Envelope slot[${index}] target kind`,
    );
    return {
      keyEpochId: identifierValue(
        mapValue(slot, 0),
        "KeyEpoch",
        `Invitation Envelope slot[${index}] Key Epoch ID`,
      ),
      targetKind,
      targetCredentialId: identifierValue(
        mapValue(slot, 2),
        targetKind === 1 ? "RecoveryCredential" : "ClientCredential",
        `Invitation Envelope slot[${index}] target Credential ID`,
      ),
      targetRevision: nullable(mapValue(slot, 3), (entry) =>
        nonnegativeInteger(entry, `Invitation Envelope slot[${index}] target revision`),
      ),
      keyEnvelopeId: identifierValue(
        mapValue(slot, 4),
        "KeyEnvelope",
        `Invitation Envelope slot[${index}] Key Envelope ID`,
      ),
    };
  });
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
  if (event.family !== 1 || event.type !== 6) return [];
  return parseInvitationAcceptance(event).envelopeSlots.map(({ keyEnvelopeId, keyEpochId }) => ({
    keyEnvelopeId,
    keyEpochId,
  }));
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
