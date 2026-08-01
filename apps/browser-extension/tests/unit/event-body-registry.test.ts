import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import { DEPENDENCY_TYPES, type TypedDependency } from "../../src/domain/canonical/dependencies";
import { validateEventBodyAndDependencies } from "../../src/domain/canonical/event-bodies";
import {
  EMPTY_REQUIRED_FEATURE_SET_ID,
  encodeFeatureManifest,
  featureManifestId,
} from "../../src/domain/canonical/features";
import {
  type Identifier,
  type IdentifierKind,
  identifier,
} from "../../src/domain/canonical/identifiers";
import { transcript } from "../../src/domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  encodeCanonicalValue,
} from "../../src/domain/canonical/value";

function id<Kind extends IdentifierKind>(kind: Kind, fill: number): Identifier<Kind> {
  return identifier(kind, new Uint8Array(32).fill(fill));
}

function map(...values: readonly CanonicalValue[]): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

function dependency(type: TypedDependency["type"], value: Uint8Array): TypedDependency {
  return { type, id: value };
}

const vaultId = id("Vault", 1);
const generationId = id("Generation", 2);
const parentId = id("VaultRecord", 3);
const authorityParentId = id("VaultRecord", 4);
const requiredFeatureSetId = EMPTY_REQUIRED_FEATURE_SET_ID;
const context = {
  vaultId,
  generationId,
  parentRecordIds: [parentId],
  authorityParentRecordIds: [authorityParentId],
  requiredFeatureSetId,
} as const;

const none: readonly TypedDependency[] = [];
const signature = new Uint8Array(64).fill(240);

interface BodyCase {
  readonly family: 1 | 2 | 3;
  readonly type: number;
  readonly body: CanonicalValue;
  readonly dependencies: readonly TypedDependency[];
}

function contentCases(): readonly BodyCase[] {
  const bundle = id("Bundle", 10);
  const collection = id("Collection", 11);
  const secondCollection = id("Collection", 12);
  const folder = id("Folder", 13);
  const secondFolder = id("Folder", 14);
  const tag = id("Tag", 15);
  const secondTag = id("Tag", 16);
  const note = id("Note", 17);
  const secondNote = id("Note", 18);
  const assignment = id("TagAssignment", 19);
  const cause = id("VaultRecord", 20);
  const descriptor = id("VaultObject", 21);
  const noteContent = id("VaultObject", 22);
  const secondNoteContent = id("VaultObject", 23);
  const organizationTarget = map(1, collection);
  const redirects = canonicalSet([map(collection, secondCollection)]);

  return [
    { family: 2, type: 1, body: map("Archive"), dependencies: none },
    { family: 2, type: 2, body: map(id("ClientCredential", 24), "Laptop"), dependencies: none },
    {
      family: 2,
      type: 3,
      body: map(bundle, descriptor, collection),
      dependencies: [dependency(DEPENDENCY_TYPES.BundleDescriptorObject, descriptor)],
    },
    { family: 2, type: 4, body: map(canonicalSet([bundle])), dependencies: none },
    { family: 2, type: 5, body: map(canonicalSet([bundle])), dependencies: none },
    {
      family: 2,
      type: 6,
      body: map([map(bundle, collection, secondCollection)], null),
      dependencies: none,
    },
    { family: 2, type: 7, body: map(collection, "Collection"), dependencies: none },
    {
      family: 2,
      type: 8,
      body: map(canonicalSet([collection]), secondCollection),
      dependencies: none,
    },
    { family: 2, type: 9, body: map(cause), dependencies: none },
    {
      family: 2,
      type: 10,
      body: map(canonicalSet([cause]), redirects),
      dependencies: none,
    },
    { family: 2, type: 11, body: map(collection, folder), dependencies: none },
    { family: 2, type: 12, body: map(folder, "Folder", null), dependencies: none },
    { family: 2, type: 13, body: map(folder, "Renamed"), dependencies: none },
    { family: 2, type: 14, body: map(folder, secondFolder), dependencies: none },
    { family: 2, type: 15, body: map(folder), dependencies: none },
    { family: 2, type: 16, body: map(folder), dependencies: none },
    {
      family: 2,
      type: 17,
      body: map(canonicalSet([cause]), [map(folder, null)]),
      dependencies: none,
    },
    { family: 2, type: 18, body: map(tag, "Tag"), dependencies: none },
    { family: 2, type: 19, body: map(tag, "Renamed"), dependencies: none },
    {
      family: 2,
      type: 20,
      body: map(assignment, tag, organizationTarget),
      dependencies: none,
    },
    { family: 2, type: 21, body: map(canonicalSet([cause])), dependencies: none },
    { family: 2, type: 22, body: map(tag), dependencies: none },
    { family: 2, type: 23, body: map(tag), dependencies: none },
    {
      family: 2,
      type: 24,
      body: map(canonicalSet([tag]), secondTag),
      dependencies: none,
    },
    { family: 2, type: 25, body: map(cause), dependencies: none },
    {
      family: 2,
      type: 26,
      body: map(canonicalSet([cause]), canonicalSet([map(tag, secondTag)])),
      dependencies: none,
    },
    {
      family: 2,
      type: 27,
      body: map(note, organizationTarget, noteContent),
      dependencies: [dependency(DEPENDENCY_TYPES.NoteContentObject, noteContent)],
    },
    {
      family: 2,
      type: 28,
      body: map(note, canonicalSet([cause]), noteContent),
      dependencies: [dependency(DEPENDENCY_TYPES.NoteContentObject, noteContent)],
    },
    { family: 2, type: 29, body: map(note, canonicalSet([cause])), dependencies: none },
    { family: 2, type: 30, body: map(note, canonicalSet([cause])), dependencies: none },
    {
      family: 2,
      type: 31,
      body: map(note, canonicalSet([cause]), noteContent, [map(secondNote, secondNoteContent)]),
      dependencies: [
        dependency(DEPENDENCY_TYPES.NoteContentObject, noteContent),
        dependency(DEPENDENCY_TYPES.NoteContentObject, secondNoteContent),
      ],
    },
  ];
}

function certificate(clientCredentialId: Uint8Array, memberId: Uint8Array) {
  return map(
    clientCredentialId,
    memberId,
    new Uint8Array(32).fill(31),
    new Uint8Array(32).fill(32),
  );
}

function recovery(recoveryCredentialId: Uint8Array, memberId: Uint8Array, revision: number) {
  return map(
    recoveryCredentialId,
    memberId,
    revision,
    new Uint8Array(32).fill(33),
    new Uint8Array(32).fill(34),
  );
}

function envelopeSlot(
  epochId: Uint8Array,
  targetKind: 1 | 2,
  targetId: Uint8Array,
  revision: number | null,
  envelopeId: Uint8Array,
) {
  return map(epochId, targetKind, targetId, revision, envelopeId);
}

function authorityCases(): readonly BodyCase[] {
  const member = id("Member", 40);
  const clientId = id("ClientCredential", 41);
  const recoveryId = id("RecoveryCredential", 42);
  const epochId = id("KeyEpoch", 43);
  const envelopeId = id("KeyEnvelope", 44);
  const secondEnvelopeId = id("KeyEnvelope", 45);
  const invitationId = id("Invitation", 46);
  const baselineId = id("VaultRecord", 47);
  const client = certificate(clientId, member);
  const recoveryCredential = recovery(recoveryId, member, 0);
  const recoverySlot = envelopeSlot(epochId, 1, recoveryId, 0, envelopeId);
  const clientSlot = envelopeSlot(epochId, 2, clientId, null, secondEnvelopeId);
  const capability = map("awsm.vault", member, vaultId, "awsm.vault.join", new Uint8Array());
  const capabilitySet = canonicalSet([capability]);
  const joinRequest = map(
    invitationId,
    capabilitySet,
    member,
    client,
    recoveryCredential,
    signature,
    signature,
    signature,
  );
  const joinRequestId = sha256(
    transcript("awsm:invitation-join-request-id:v1", [encodeCanonicalValue(joinRequest)]),
  );
  const acceptanceProposal = map(
    invitationId,
    joinRequestId,
    canonicalSet([authorityParentId]),
    member,
    client,
    recoveryCredential,
    capabilitySet,
    canonicalSet([recoverySlot, clientSlot]),
  );
  const proposalId = sha256(
    transcript("awsm:invitation-acceptance-proposal-id:v1", [
      encodeCanonicalValue(acceptanceProposal),
    ]),
  );
  const consumedReceipt = map(
    invitationId,
    1,
    joinRequestId,
    proposalId,
    new Uint8Array(32).fill(50),
    signature,
  );
  const cancellationRequest = map(invitationId, new Uint8Array(32).fill(52), signature);
  const cancellationRequestId = sha256(
    transcript("awsm:invitation-cancel-request-id:v1", [encodeCanonicalValue(cancellationRequest)]),
  );
  const cancelledReceipt = map(
    invitationId,
    2,
    cancellationRequestId,
    null,
    new Uint8Array(32).fill(53),
    signature,
  );
  const enrollmentProposal = map(
    vaultId,
    member,
    canonicalSet([authorityParentId]),
    client,
    canonicalSet([clientSlot]),
    signature,
  );
  const manifestBytes = encodeFeatureManifest({
    featureKey: "awsm.test-feature",
    revision: 1,
    parameters: new Uint8Array(),
    requiredManifestIds: [],
    incompatibleKeys: [],
  });

  return [
    {
      family: 1,
      type: 1,
      body: map(
        baselineId,
        member,
        client,
        recoveryCredential,
        epochId,
        requiredFeatureSetId,
        map(signature, signature),
      ),
      dependencies: [dependency(DEPENDENCY_TYPES.VaultBaseline, baselineId)],
    },
    { family: 1, type: 2, body: map(member), dependencies: none },
    { family: 1, type: 3, body: map(member, []), dependencies: none },
    { family: 1, type: 4, body: map(member, []), dependencies: none },
    {
      family: 1,
      type: 5,
      body: map(
        invitationId,
        capabilitySet,
        new Uint8Array(32).fill(54),
        new Uint8Array(32).fill(55),
        new Uint8Array(32).fill(56),
        new Uint8Array(32).fill(57),
      ),
      dependencies: none,
    },
    {
      family: 1,
      type: 6,
      body: map(joinRequest, acceptanceProposal, consumedReceipt),
      dependencies: [
        dependency(DEPENDENCY_TYPES.KeyEnvelope, envelopeId),
        dependency(DEPENDENCY_TYPES.KeyEnvelope, secondEnvelopeId),
      ],
    },
    {
      family: 1,
      type: 7,
      body: map(cancellationRequest, cancelledReceipt),
      dependencies: none,
    },
    {
      family: 1,
      type: 8,
      body: map(
        invitationId,
        canonicalSet([new Uint8Array(32).fill(58)]),
        canonicalSet([id("VaultRecord", 59)]),
        2,
        null,
      ),
      dependencies: none,
    },
    {
      family: 1,
      type: 9,
      body: map(enrollmentProposal, 1, null, null),
      dependencies: [dependency(DEPENDENCY_TYPES.KeyEnvelope, secondEnvelopeId)],
    },
    { family: 1, type: 10, body: map(clientId), dependencies: none },
    {
      family: 1,
      type: 11,
      body: map(
        member,
        canonicalSet([recoveryId]),
        recoveryCredential,
        canonicalSet([recoverySlot]),
        signature,
      ),
      dependencies: [dependency(DEPENDENCY_TYPES.KeyEnvelope, envelopeId)],
    },
    {
      family: 1,
      type: 12,
      body: map(
        canonicalSet([epochId]),
        id("KeyEpoch", 60),
        1,
        canonicalSet([recoverySlot, clientSlot]),
      ),
      dependencies: [
        dependency(DEPENDENCY_TYPES.KeyEnvelope, envelopeId),
        dependency(DEPENDENCY_TYPES.KeyEnvelope, secondEnvelopeId),
      ],
    },
    {
      family: 1,
      type: 13,
      body: map(canonicalSet([clientSlot])),
      dependencies: [dependency(DEPENDENCY_TYPES.KeyEnvelope, secondEnvelopeId)],
    },
    {
      family: 1,
      type: 14,
      body: map(requiredFeatureSetId, canonicalSet([manifestBytes]), id("RequiredFeatureSet", 61)),
      dependencies: [
        dependency(DEPENDENCY_TYPES.FeatureManifest, featureManifestId(manifestBytes)),
      ],
    },
  ];
}

function lifecycleCases(): readonly BodyCase[] {
  const baselineId = id("VaultRecord", 70);
  return [
    {
      family: 3,
      type: 1,
      body: map(
        generationId,
        canonicalSet([parentId]),
        id("Generation", 71),
        baselineId,
        new Uint8Array(32).fill(72),
        new Uint8Array(32).fill(73),
        new Uint8Array(32).fill(74),
      ),
      dependencies: [dependency(DEPENDENCY_TYPES.VaultBaseline, baselineId)],
    },
    { family: 3, type: 2, body: map(), dependencies: none },
  ];
}

const cases = [...authorityCases(), ...contentCases(), ...lifecycleCases()];

describe("exhaustive base Event body registry", () => {
  it("contains all 47 base Event types exactly once", () => {
    expect(cases).toHaveLength(47);
    expect(new Set(cases.map(({ family, type }) => `${family}:${type}`)).size).toBe(47);
  });

  it.each(cases)(
    "accepts canonical Event body $family:$type",
    ({ family, type, body, dependencies }) => {
      expect(() =>
        validateEventBodyAndDependencies(family, type, body, dependencies, context),
      ).not.toThrow();
    },
  );

  it.each(cases)(
    "rejects unknown fields in Event body $family:$type",
    ({ family, type, body, dependencies }) => {
      const malformed = new Map(body as ReadonlyMap<number, CanonicalValue>);
      malformed.set(99, 1);
      expect(() =>
        validateEventBodyAndDependencies(family, type, malformed, dependencies, context),
      ).toThrow(/unknown fields/u);
    },
  );

  it.each(cases)(
    "rejects body/dependency mismatch for Event $family:$type",
    ({ family, type, body, dependencies }) => {
      const wrong =
        dependencies.length === 0
          ? [dependency(DEPENDENCY_TYPES.VaultObject, id("VaultObject", 99))]
          : [];
      expect(() => validateEventBodyAndDependencies(family, type, body, wrong, context)).toThrow(
        /dependencies/u,
      );
    },
  );
});
