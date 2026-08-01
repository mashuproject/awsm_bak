import { sha256 } from "@noble/hashes/sha2.js";

import { bytesEqual } from "../hash";
import { DEPENDENCY_TYPES, type TypedDependency } from "./dependencies";
import { decodeRequiredFeatureSet, encodeFeatureManifest, featureManifestId } from "./features";
import type { Identifier } from "./identifiers";
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
} from "./schema";
import { transcript } from "./transcript";
import { assertCanonicalScopedKey, type CanonicalValue, encodeCanonicalValue } from "./value";

export const AUTHORITY_EVENT_NAMES = [
  "Genesis",
  "Membership End",
  "Administrator Grant",
  "Administrator End",
  "Invitation Creation",
  "Invitation Acceptance",
  "Invitation Cancellation",
  "Invitation Conflict Resolution",
  "Client Credential Enrollment",
  "Client Credential End",
  "Recovery Credential Replacement",
  "Key Epoch Transition",
  "Key Delivery",
  "Feature Activation",
] as const;

export interface AuthorityBodyContext {
  readonly vaultId: Identifier<"Vault">;
  readonly requiredFeatureSetId: Identifier<"RequiredFeatureSet">;
  readonly authorityParentRecordIds: readonly Identifier<"VaultRecord">[];
}

interface CertificateSummary {
  readonly clientCredentialId: Uint8Array;
  readonly memberId: Uint8Array;
  readonly bytes: Uint8Array;
}

interface RecoverySummary {
  readonly recoveryCredentialId: Uint8Array;
  readonly memberId: Uint8Array;
  readonly revision: number;
  readonly bytes: Uint8Array;
}

interface SlotSummary {
  readonly keyEpochId: Uint8Array;
  readonly targetKind: 1 | 2;
  readonly targetCredentialId: Uint8Array;
  readonly targetRevision: number | null;
  readonly keyEnvelopeId: Uint8Array;
}

interface CapabilitySummary {
  readonly issuerMemberId: Uint8Array;
  readonly targetVaultId: Uint8Array;
  readonly action: string;
}

interface JoinRequestSummary {
  readonly invitationId: Uint8Array;
  readonly proposedMemberId: Uint8Array;
  readonly clientCertificate: CertificateSummary;
  readonly recoveryCredential: RecoverySummary;
  readonly capabilitiesBytes: Uint8Array;
  readonly requestId: Uint8Array;
}

interface ProposalSummary {
  readonly invitationId: Uint8Array;
  readonly joinRequestId: Uint8Array;
  readonly authorityParentRecordIds: readonly Identifier<"VaultRecord">[];
  readonly proposedMemberId: Uint8Array;
  readonly clientCertificate: CertificateSummary;
  readonly recoveryCredential: RecoverySummary;
  readonly capabilitiesBytes: Uint8Array;
  readonly slots: readonly SlotSummary[];
  readonly proposalId: Uint8Array;
}

interface ReceiptSummary {
  readonly invitationId: Uint8Array;
  readonly outcome: 1 | 2;
  readonly requestId: Uint8Array;
  readonly acceptanceProposalId: Uint8Array | null;
  readonly authorityReceiptId: Uint8Array;
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function sameCanonical(left: CanonicalValue, right: CanonicalValue, field: string): void {
  if (!bytesEqual(encodeCanonicalValue(left), encodeCanonicalValue(right))) {
    throw new TypeError(`${field} does not match`);
  }
}

function dependency(type: TypedDependency["type"], id: Uint8Array): TypedDependency {
  return { type, id: Uint8Array.from(id) };
}

function certificate(value: CanonicalValue, field: string): CertificateSummary {
  const map = exactMap(value, [0, 1, 2, 3], field);
  byteString(mapValue(map, 2), 32, `${field} signing public key`);
  byteString(mapValue(map, 3), 32, `${field} wrapping public key`);
  return {
    clientCredentialId: identifierValue(
      mapValue(map, 0),
      "ClientCredential",
      `${field} Client Credential ID`,
    ),
    memberId: identifierValue(mapValue(map, 1), "Member", `${field} Member ID`),
    bytes: encodeCanonicalValue(value),
  };
}

function recoveryCredential(value: CanonicalValue, field: string): RecoverySummary {
  const map = exactMap(value, [0, 1, 2, 3, 4], field);
  byteString(mapValue(map, 3), 32, `${field} signing public key`);
  byteString(mapValue(map, 4), 32, `${field} wrapping public key`);
  return {
    recoveryCredentialId: identifierValue(
      mapValue(map, 0),
      "RecoveryCredential",
      `${field} Recovery Credential ID`,
    ),
    memberId: identifierValue(mapValue(map, 1), "Member", `${field} Member ID`),
    revision: nonnegativeInteger(mapValue(map, 2), `${field} revision`),
    bytes: encodeCanonicalValue(value),
  };
}

function slot(value: CanonicalValue, field: string): SlotSummary {
  const map = exactMap(value, [0, 1, 2, 3, 4], field);
  const targetKind = oneOfCodes(mapValue(map, 1), [1, 2] as const, `${field} target kind`);
  const targetRevision = nullable(mapValue(map, 3), (entry) =>
    nonnegativeInteger(entry, `${field} target revision`),
  );
  if ((targetKind === 1) !== (targetRevision !== null)) {
    throw new TypeError(`${field} must include a revision only for a Recovery Credential`);
  }
  return {
    keyEpochId: identifierValue(mapValue(map, 0), "KeyEpoch", `${field} Key Epoch ID`),
    targetKind,
    targetCredentialId: identifierValue(
      mapValue(map, 2),
      targetKind === 1 ? "RecoveryCredential" : "ClientCredential",
      `${field} target Credential ID`,
    ),
    targetRevision,
    keyEnvelopeId: identifierValue(mapValue(map, 4), "KeyEnvelope", `${field} Key Envelope ID`),
  };
}

function slots(value: CanonicalValue, field: string, nonempty = false): readonly SlotSummary[] {
  return canonicalSetValue(
    value,
    field,
    (entry, index) => {
      slot(entry, `${field}[${index}]`);
      return entry;
    },
    { nonempty },
  ).map((entry, index) => slot(entry, `${field}[${index}]`));
}

export function validateClientCredentialCertificate(
  value: CanonicalValue,
  field = "Client Credential Certificate",
): void {
  certificate(value, field);
}

export function validateRecoveryCredentialDescriptor(
  value: CanonicalValue,
  field = "Recovery Credential descriptor",
): void {
  recoveryCredential(value, field);
}

export function validateKeyEnvelopeSlots(
  value: CanonicalValue,
  field = "Key Envelope slots",
  nonempty = false,
): readonly Uint8Array[] {
  return slots(value, field, nonempty).map(({ keyEnvelopeId }) => keyEnvelopeId);
}

export function validateInvitationCapabilities(
  value: CanonicalValue,
  field = "Invitation capabilities",
): void {
  capabilities(value, field);
}

function capability(value: CanonicalValue, field: string): CapabilitySummary {
  const map = exactMap(value, [0, 1, 2, 3, 4], field);
  const authorityDomain = mapValue(map, 0);
  const action = mapValue(map, 3);
  if (typeof authorityDomain !== "string" || typeof action !== "string") {
    throw new TypeError(`${field} domain and action must be scoped text keys`);
  }
  assertCanonicalScopedKey(authorityDomain);
  assertCanonicalScopedKey(action);
  if (authorityDomain !== "awsm.vault") {
    throw new TypeError(`${field} authority domain must be awsm.vault`);
  }
  if (action !== "awsm.vault.join" && action !== "awsm.vault.administrator") {
    throw new TypeError(`${field} contains an unknown base portable action`);
  }
  byteStringValue(mapValue(map, 4), `${field} parameters`);
  return {
    issuerMemberId: identifierValue(mapValue(map, 1), "Member", `${field} issuer Member ID`),
    targetVaultId: identifierValue(mapValue(map, 2), "Vault", `${field} target Vault ID`),
    action,
  };
}

function capabilities(value: CanonicalValue, field: string): readonly CapabilitySummary[] {
  return canonicalSetValue(
    value,
    field,
    (entry, index) => {
      capability(entry, `${field}[${index}]`);
      return entry;
    },
    { nonempty: true },
  ).map((entry, index) => capability(entry, `${field}[${index}]`));
}

function byteStringValue(value: CanonicalValue, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${field} must be bytes`);
  return Uint8Array.from(value);
}

function joinRequest(value: CanonicalValue, field: string): JoinRequestSummary {
  const map = exactMap(value, [0, 1, 2, 3, 4, 5, 6, 7], field);
  const proposedMemberId = identifierValue(
    mapValue(map, 2),
    "Member",
    `${field} proposed Member ID`,
  );
  const client = certificate(mapValue(map, 3), `${field} proposed Client Certificate`);
  const recovery = recoveryCredential(mapValue(map, 4), `${field} proposed Recovery Credential`);
  same(client.memberId, proposedMemberId, `${field} Client Certificate member`);
  same(recovery.memberId, proposedMemberId, `${field} Recovery Credential member`);
  if (recovery.revision !== 0)
    throw new TypeError(`${field} Recovery Credential revision must be 0`);
  capabilities(mapValue(map, 1), `${field} capabilities`);
  byteString(mapValue(map, 5), 64, `${field} Client possession signature`);
  byteString(mapValue(map, 6), 64, `${field} Recovery possession signature`);
  byteString(mapValue(map, 7), 64, `${field} Redemption signature`);
  return {
    invitationId: identifierValue(mapValue(map, 0), "Invitation", `${field} Invitation ID`),
    proposedMemberId,
    clientCertificate: client,
    recoveryCredential: recovery,
    capabilitiesBytes: encodeCanonicalValue(mapValue(map, 1)),
    requestId: sha256(
      transcript("awsm:invitation-join-request-id:v1", [encodeCanonicalValue(value)]),
    ),
  };
}

function proposal(value: CanonicalValue, field: string): ProposalSummary {
  const map = exactMap(value, [0, 1, 2, 3, 4, 5, 6, 7], field);
  const proposedMemberId = identifierValue(
    mapValue(map, 3),
    "Member",
    `${field} proposed Member ID`,
  );
  const client = certificate(mapValue(map, 4), `${field} proposed Client Certificate`);
  const recovery = recoveryCredential(mapValue(map, 5), `${field} proposed Recovery Credential`);
  same(client.memberId, proposedMemberId, `${field} Client Certificate member`);
  same(recovery.memberId, proposedMemberId, `${field} Recovery Credential member`);
  if (recovery.revision !== 0)
    throw new TypeError(`${field} Recovery Credential revision must be 0`);
  capabilities(mapValue(map, 6), `${field} granted portable capabilities`);
  return {
    invitationId: identifierValue(mapValue(map, 0), "Invitation", `${field} Invitation ID`),
    joinRequestId: byteString(mapValue(map, 1), 32, `${field} Join Request ID`),
    authorityParentRecordIds: idSetValue(
      mapValue(map, 2),
      "VaultRecord",
      `${field} Authority Parent Record IDs`,
      { nonempty: true },
    ),
    proposedMemberId,
    clientCertificate: client,
    recoveryCredential: recovery,
    capabilitiesBytes: encodeCanonicalValue(mapValue(map, 6)),
    slots: slots(mapValue(map, 7), `${field} Envelope slots`, true),
    proposalId: sha256(
      transcript("awsm:invitation-acceptance-proposal-id:v1", [encodeCanonicalValue(value)]),
    ),
  };
}

function receipt(value: CanonicalValue, field: string): ReceiptSummary {
  const map = exactMap(value, [0, 1, 2, 3, 4, 5], field);
  const outcome = oneOfCodes(mapValue(map, 1), [1, 2] as const, `${field} outcome`);
  const proposalId = nullable(mapValue(map, 3), (entry) =>
    byteString(entry, 32, `${field} Acceptance Proposal ID`),
  );
  if ((outcome === 1) !== (proposalId !== null)) {
    throw new TypeError(`${field} proposal ID presence does not match its outcome`);
  }
  byteString(mapValue(map, 5), 64, `${field} signature`);
  return {
    invitationId: identifierValue(mapValue(map, 0), "Invitation", `${field} Invitation ID`),
    outcome,
    requestId: byteString(
      mapValue(map, 2),
      32,
      outcome === 1 ? `${field} Join Request ID` : `${field} Cancellation Request ID`,
    ),
    acceptanceProposalId: proposalId,
    authorityReceiptId: byteString(mapValue(map, 4), 32, `${field} Authority Receipt ID`),
  };
}

function cancellationRequest(value: CanonicalValue, field: string): Uint8Array {
  const map = exactMap(value, [0, 1, 2], field);
  const invitationId = identifierValue(mapValue(map, 0), "Invitation", `${field} Invitation ID`);
  byteString(mapValue(map, 1), 32, `${field} authority challenge`);
  byteString(mapValue(map, 2), 64, `${field} signature`);
  return invitationId;
}

function enrollmentProposal(value: CanonicalValue, field: string, context: AuthorityBodyContext) {
  const map = exactMap(value, [0, 1, 2, 3, 4, 5], field);
  const vaultId = identifierValue(mapValue(map, 0), "Vault", `${field} Vault ID`);
  same(vaultId, context.vaultId, `${field} Vault ID`);
  const memberId = identifierValue(mapValue(map, 1), "Member", `${field} Member ID`);
  const parents = idSetValue(
    mapValue(map, 2),
    "VaultRecord",
    `${field} Authority Parent Record IDs`,
    { nonempty: true },
  );
  sameCanonical(parents, context.authorityParentRecordIds, `${field} Authority Parent frontier`);
  const client = certificate(mapValue(map, 3), `${field} proposed Client Certificate`);
  same(client.memberId, memberId, `${field} Client Certificate member`);
  const envelopeSlots = slots(mapValue(map, 4), `${field} Envelope slots`, true);
  byteString(mapValue(map, 5), 64, `${field} proposed possession signature`);
  return { memberId, client, envelopeSlots };
}

export function validateAuthorityEventBody(
  type: number,
  value: CanonicalValue,
  context: AuthorityBodyContext,
): readonly TypedDependency[] {
  const name = AUTHORITY_EVENT_NAMES[type - 1];
  if (name === undefined) throw new TypeError("Unknown Authority Event type");
  const body = exactMap(value, bodyKeys(type), `${name} Event body`);

  switch (type) {
    case 1: {
      const baselineId = identifierValue(mapValue(body, 0), "VaultRecord", "Initial Baseline ID");
      const firstMemberId = identifierValue(mapValue(body, 1), "Member", "First Member ID");
      const client = certificate(mapValue(body, 2), "First Client Certificate");
      const recovery = recoveryCredential(mapValue(body, 3), "First Recovery Credential");
      same(client.memberId, firstMemberId, "First Client Certificate member");
      same(recovery.memberId, firstMemberId, "First Recovery Credential member");
      if (recovery.revision !== 0)
        throw new TypeError("First Recovery Credential revision must be 0");
      identifierValue(mapValue(body, 4), "KeyEpoch", "Initial Key Epoch ID");
      same(
        identifierValue(mapValue(body, 5), "RequiredFeatureSet", "Genesis feature set ID"),
        context.requiredFeatureSetId,
        "Genesis feature set ID",
      );
      const proof = exactMap(mapValue(body, 6), [0, 1], "Genesis creation proof");
      byteString(mapValue(proof, 0), 64, "Genesis Client proof");
      byteString(mapValue(proof, 1), 64, "Genesis Recovery proof");
      return [dependency(DEPENDENCY_TYPES.VaultBaseline, baselineId)];
    }
    case 2:
      identifierValue(mapValue(body, 0), "Member", "Target Member ID");
      return [];
    case 3:
    case 4:
      identifierValue(mapValue(body, 0), "Member", "Target Member ID");
      idSetValue(mapValue(body, 1), "VaultRecord", "Resolved Administrator Record IDs");
      return [];
    case 5: {
      identifierValue(mapValue(body, 0), "Invitation", "Invitation ID");
      const parsedCapabilities = capabilities(mapValue(body, 1), "Invitation capabilities");
      if (!parsedCapabilities.some(({ action }) => action === "awsm.vault.join")) {
        throw new TypeError("Invitation capabilities must include awsm.vault.join");
      }
      for (const item of parsedCapabilities) {
        same(item.targetVaultId, context.vaultId, "Invitation capability target Vault ID");
      }
      byteString(mapValue(body, 2), 32, "Invitation Redemption verifier");
      byteString(mapValue(body, 3), 32, "Invitation Cancellation verifier");
      byteString(mapValue(body, 4), 32, "Invitation Redemption Authority ID");
      byteString(mapValue(body, 5), 32, "Invitation receipt verification key");
      return [];
    }
    case 6: {
      const join = joinRequest(mapValue(body, 0), "Invitation Join Request");
      const acceptance = proposal(mapValue(body, 1), "Invitation Acceptance Proposal");
      const consumed = receipt(mapValue(body, 2), "Consumed Invitation receipt");
      if (consumed.outcome !== 1)
        throw new TypeError("Invitation Acceptance requires a consumed receipt");
      same(join.invitationId, acceptance.invitationId, "Acceptance Invitation ID");
      same(join.invitationId, consumed.invitationId, "Consumed receipt Invitation ID");
      same(join.proposedMemberId, acceptance.proposedMemberId, "Proposed Member ID");
      same(
        join.clientCertificate.clientCredentialId,
        acceptance.clientCertificate.clientCredentialId,
        "Proposed Client Credential ID",
      );
      same(
        join.clientCertificate.bytes,
        acceptance.clientCertificate.bytes,
        "Proposed Client Certificate",
      );
      same(
        join.recoveryCredential.recoveryCredentialId,
        acceptance.recoveryCredential.recoveryCredentialId,
        "Proposed Recovery Credential ID",
      );
      same(
        join.recoveryCredential.bytes,
        acceptance.recoveryCredential.bytes,
        "Proposed Recovery Credential",
      );
      if (!bytesEqual(join.capabilitiesBytes, acceptance.capabilitiesBytes)) {
        throw new TypeError("Granted portable capabilities do not match the Join Request");
      }
      sameCanonical(
        acceptance.authorityParentRecordIds,
        context.authorityParentRecordIds,
        "Acceptance Authority Parent frontier",
      );
      same(join.requestId, acceptance.joinRequestId, "Acceptance Join Request ID");
      same(join.requestId, consumed.requestId, "Consumed receipt Join Request ID");
      if (consumed.acceptanceProposalId === null) {
        throw new TypeError("Consumed receipt is missing its Acceptance Proposal ID");
      }
      same(
        acceptance.proposalId,
        consumed.acceptanceProposalId,
        "Consumed receipt Acceptance Proposal ID",
      );
      return acceptance.slots.map(({ keyEnvelopeId }) =>
        dependency(DEPENDENCY_TYPES.KeyEnvelope, keyEnvelopeId),
      );
    }
    case 7: {
      const requestValue = mapValue(body, 0);
      const invitationId = cancellationRequest(requestValue, "Invitation Cancellation Request");
      const cancelled = receipt(mapValue(body, 1), "Cancelled Invitation receipt");
      if (cancelled.outcome !== 2)
        throw new TypeError("Invitation Cancellation requires a cancelled receipt");
      same(invitationId, cancelled.invitationId, "Cancellation receipt Invitation ID");
      const cancellationRequestId = sha256(
        transcript("awsm:invitation-cancel-request-id:v1", [encodeCanonicalValue(requestValue)]),
      );
      same(cancellationRequestId, cancelled.requestId, "Cancelled receipt Cancellation Request ID");
      return [];
    }
    case 8: {
      identifierValue(mapValue(body, 0), "Invitation", "Invitation ID");
      canonicalSetValue(
        mapValue(body, 1),
        "Conflicting receipt IDs",
        (entry) => byteString(entry, 32, "Invitation receipt ID"),
        { nonempty: true },
      );
      idSetValue(mapValue(body, 2), "VaultRecord", "Conflicting Invitation Record IDs", {
        nonempty: true,
      });
      const outcome = oneOfCodes(
        mapValue(body, 3),
        [1, 2] as const,
        "Invitation resolution outcome",
      );
      const selected = nullable(mapValue(body, 4), (entry) =>
        byteString(entry, 32, "Selected Join Request ID"),
      );
      if ((outcome === 1) !== (selected !== null)) {
        throw new TypeError("Selected Join Request ID presence does not match resolution outcome");
      }
      return [];
    }
    case 9: {
      const enrollment = enrollmentProposal(
        mapValue(body, 0),
        "Client Credential Enrollment Proposal",
        context,
      );
      const kind = oneOfCodes(mapValue(body, 1), [1, 2] as const, "Enrollment authorization kind");
      const recoveryId = nullable(mapValue(body, 2), (entry) =>
        identifierValue(entry, "RecoveryCredential", "Authorizing Recovery Credential ID"),
      );
      const recoveryAuthorization = nullable(mapValue(body, 3), (entry) =>
        byteString(entry, 64, "Recovery enrollment authorization"),
      );
      if ((kind === 2) !== (recoveryId !== null && recoveryAuthorization !== null)) {
        throw new TypeError("Recovery authorization fields do not match enrollment kind");
      }
      return enrollment.envelopeSlots.map(({ keyEnvelopeId }) =>
        dependency(DEPENDENCY_TYPES.KeyEnvelope, keyEnvelopeId),
      );
    }
    case 10:
      identifierValue(mapValue(body, 0), "ClientCredential", "Target Client Credential ID");
      return [];
    case 11: {
      const memberId = identifierValue(mapValue(body, 0), "Member", "Recovery member ID");
      idSetValue(mapValue(body, 1), "RecoveryCredential", "Replaced Recovery Credential IDs", {
        nonempty: true,
      });
      const replacement = recoveryCredential(mapValue(body, 2), "Replacement Recovery Credential");
      same(memberId, replacement.memberId, "Replacement Recovery Credential member");
      const envelopeSlots = slots(mapValue(body, 3), "Recovery Envelope slots", true);
      if (
        envelopeSlots.some(
          (entry) =>
            entry.targetKind !== 1 ||
            !bytesEqual(entry.targetCredentialId, replacement.recoveryCredentialId),
        )
      ) {
        throw new TypeError(
          "Recovery Envelope slots must target the replacement Recovery Credential",
        );
      }
      byteString(mapValue(body, 4), 64, "Recovery replacement possession signature");
      return envelopeSlots.map(({ keyEnvelopeId }) =>
        dependency(DEPENDENCY_TYPES.KeyEnvelope, keyEnvelopeId),
      );
    }
    case 12: {
      idSetValue(mapValue(body, 0), "KeyEpoch", "Parent Key Epoch IDs", { nonempty: true });
      identifierValue(mapValue(body, 1), "KeyEpoch", "New Key Epoch ID");
      nonnegativeInteger(mapValue(body, 2), "Key Epoch display number");
      const envelopeSlots = slots(mapValue(body, 3), "Key Epoch Envelope slots", true);
      return envelopeSlots.map(({ keyEnvelopeId }) =>
        dependency(DEPENDENCY_TYPES.KeyEnvelope, keyEnvelopeId),
      );
    }
    case 13: {
      const envelopeSlots = slots(mapValue(body, 0), "Key Delivery Envelope slots", true);
      return envelopeSlots.map(({ keyEnvelopeId }) =>
        dependency(DEPENDENCY_TYPES.KeyEnvelope, keyEnvelopeId),
      );
    }
    case 14: {
      same(
        identifierValue(mapValue(body, 0), "RequiredFeatureSet", "Previous Feature Set ID"),
        context.requiredFeatureSetId,
        "Previous Feature Set ID",
      );
      const manifestValue = mapValue(body, 1);
      const manifests = decodeRequiredFeatureSet(encodeCanonicalValue(manifestValue));
      if (manifests.length === 0) throw new TypeError("Feature Activation must add a Manifest");
      const manifestIds = manifests.map((manifest) =>
        featureManifestId(encodeFeatureManifest(manifest)),
      );
      identifierValue(mapValue(body, 2), "RequiredFeatureSet", "Resulting Feature Set ID");
      return manifestIds.map((id) => dependency(DEPENDENCY_TYPES.FeatureManifest, id));
    }
    default:
      throw new TypeError("Unknown Authority Event type");
  }
}

function bodyKeys(type: number): readonly number[] {
  switch (type) {
    case 1:
      return [0, 1, 2, 3, 4, 5, 6];
    case 2:
    case 10:
    case 13:
      return [0];
    case 3:
    case 4:
    case 7:
      return [0, 1];
    case 5:
      return [0, 1, 2, 3, 4, 5];
    case 6:
      return [0, 1, 2];
    case 8:
    case 11:
      return [0, 1, 2, 3, 4];
    case 9:
    case 12:
      return [0, 1, 2, 3];
    case 14:
      return [0, 1, 2];
    default:
      throw new TypeError("Unknown Authority Event type");
  }
}
