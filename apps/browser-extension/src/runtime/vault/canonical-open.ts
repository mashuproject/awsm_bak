import { readySodium } from "../../crypto/sodium";
import { vaultBaselineDependencyRequirements } from "../../domain/canonical/baseline-body";
import { DEPENDENCY_TYPES, dependencySet } from "../../domain/canonical/dependencies";
import {
  decodeFeatureManifest,
  featureManifestId,
  requiredFeatureSetId,
} from "../../domain/canonical/features";
import type { Identifier } from "../../domain/canonical/identifiers";
import type { AuthenticatedVaultEvent, VaultBaseline } from "../../domain/canonical/record";
import { verifyVaultEventSignature } from "../../domain/canonical/record";
import {
  byteString,
  exactCode,
  exactMap,
  identifierValue,
  idSetValue,
  mapValue,
  nullable,
  oneOfCodes,
  textValue,
} from "../../domain/canonical/schema";
import { transcript } from "../../domain/canonical/transcript";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual, sha256 } from "../../domain/hash";
import {
  decodeCanonicalAuthorityCheckpoint,
  encodeCanonicalAuthorityCheckpoint,
} from "../projection/canonical-authority-checkpoint";
import {
  type CanonicalAuthorityFeatureManifest,
  CanonicalAuthorityReplay,
  type CanonicalAuthorityState,
  canonicalAuthorityFeatureManifestRequirements,
  canonicalAuthorityKeyEnvelopeRequirements,
} from "../projection/canonical-authority-replay";
import type {
  CanonicalReplicaState,
  ClientSecretState,
  EpochSecretState,
} from "./canonical-local-state";

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function identifierKey(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameCanonical(left: CanonicalValue, right: CanonicalValue, field: string): void {
  if (!bytesEqual(encodeCanonicalValue(left), encodeCanonicalValue(right))) {
    throw new TypeError(`${field} does not match`);
  }
}

export function baselineVaultLabel(baseline: VaultBaseline): string | null {
  const body = exactMap(baseline.body, [0, 1, 2, 3, 4, 5], "Vault Baseline body");
  const content = exactMap(mapValue(body, 2), [...Array(10).keys()], "Content checkpoint");
  const label = exactMap(mapValue(content, 1), [0, 1], "Vault label");
  return nullable(mapValue(label, 0), (value) =>
    textValue(value, "Vault label", { maxUtf8Bytes: 1024 }),
  );
}

export interface InitialVaultClientAuthority {
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly signingPublicKey: Uint8Array;
  readonly wrappingPublicKey: Uint8Array;
}

export function initialVaultClientAuthority(
  genesis: AuthenticatedVaultEvent,
): InitialVaultClientAuthority {
  const genesisBody = exactMap(genesis.body, [0, 1, 2, 3, 4, 5, 6], "Genesis body");
  const memberId = identifierValue(mapValue(genesisBody, 1), "Member", "Genesis first Member ID");
  const certificate = exactMap(
    mapValue(genesisBody, 2),
    [0, 1, 2, 3],
    "Genesis Client Certificate",
  );
  const certificateMemberId = identifierValue(
    mapValue(certificate, 1),
    "Member",
    "Certificate Member ID",
  );
  same(certificateMemberId, memberId, "Certificate Member ID");
  return {
    memberId,
    clientCredentialId: identifierValue(
      mapValue(certificate, 0),
      "ClientCredential",
      "Genesis Client Credential ID",
    ),
    signingPublicKey: byteString(mapValue(certificate, 2), 32, "Client signing public key"),
    wrappingPublicKey: byteString(mapValue(certificate, 3), 32, "Client wrapping public key"),
  };
}

export function validateLocalClientAuthority(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly authority: CanonicalAuthorityState;
  readonly replicaAuthority: Pick<
    CanonicalReplicaState,
    "authoringClientCredentialId" | "memberId"
  >;
  readonly clientSecret: ClientSecretState | null;
}): void {
  const { authoringClientCredentialId, memberId } = input.replicaAuthority;
  if ((authoringClientCredentialId === null) !== (memberId === null)) {
    throw new TypeError("Replica local Client authority is incomplete");
  }
  if (authoringClientCredentialId === null || memberId === null) return;
  const clientSecret = input.clientSecret;
  if (clientSecret === null) {
    throw new TypeError("Authoring Replica has no local Client Secret");
  }
  for (const [field, left, right] of [
    ["Client Secret Vault ID", clientSecret.vaultId, input.vaultId],
    ["Stored Client Credential", clientSecret.clientCredentialId, authoringClientCredentialId],
    ["Stored Client Member", clientSecret.memberId, memberId],
  ] as const) {
    same(left, right, field);
  }
  const credential = [...input.authority.clientCredentials.values()].find(
    ({ clientCredentialId }) => bytesEqual(clientCredentialId, authoringClientCredentialId),
  );
  if (
    credential === undefined ||
    !credential.active ||
    !bytesEqual(credential.memberId, memberId) ||
    !bytesEqual(credential.signingPublicKey, clientSecret.signingPublicKey) ||
    !bytesEqual(credential.wrappingPublicKey, clientSecret.wrappingPublicKey)
  ) {
    throw new TypeError("Local Client Secret does not match active Authority State");
  }
}

function sameSet(left: readonly Uint8Array[], right: readonly Uint8Array[], field: string): void {
  if (
    left.length !== right.length ||
    left.some((candidate) => !right.some((value) => bytesEqual(candidate, value)))
  ) {
    throw new TypeError(`${field} does not match`);
  }
}

async function genesisAuthorityState(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly genesis: AuthenticatedVaultEvent;
  readonly currentBaselineAuthority: CanonicalAuthorityState;
  readonly initialFeatureManifests: readonly CanonicalAuthorityFeatureManifest[];
}): Promise<CanonicalAuthorityState> {
  const { genesis } = input;
  if (genesis.family !== 1 || genesis.type !== 1) {
    throw new TypeError("Initial authority root is not Genesis");
  }
  if (genesis.parentRecordIds.length !== 0 || genesis.authorityParentRecordIds.length !== 0) {
    throw new TypeError("Genesis must be parentless");
  }
  same(genesis.vaultId, input.vaultId, "Genesis Vault ID");
  const body = exactMap(genesis.body, [0, 1, 2, 3, 4, 5, 6], "Genesis body");
  const baselineId = identifierValue(mapValue(body, 0), "VaultRecord", "Genesis Baseline ID");
  sameCanonical(
    dependencySet(genesis.dependencies),
    dependencySet([{ type: DEPENDENCY_TYPES.VaultBaseline, id: baselineId }]),
    "Genesis dependency",
  );
  const memberId = identifierValue(mapValue(body, 1), "Member", "Genesis first Member ID");
  const certificate = exactMap(mapValue(body, 2), [0, 1, 2, 3], "Genesis Client Certificate");
  const recovery = exactMap(mapValue(body, 3), [0, 1, 2, 3, 4], "Genesis Recovery Credential");
  const clientCredentialId = identifierValue(
    mapValue(certificate, 0),
    "ClientCredential",
    "Genesis Client Credential ID",
  );
  const certificateMemberId = identifierValue(
    mapValue(certificate, 1),
    "Member",
    "Genesis Client Member ID",
  );
  same(certificateMemberId, memberId, "Genesis Client Member ID");
  const clientSigningPublicKey = byteString(
    mapValue(certificate, 2),
    32,
    "Genesis Client signing public key",
  );
  const clientWrappingPublicKey = byteString(
    mapValue(certificate, 3),
    32,
    "Genesis Client wrapping public key",
  );
  const recoveryCredentialId = identifierValue(
    mapValue(recovery, 0),
    "RecoveryCredential",
    "Genesis Recovery Credential ID",
  );
  same(
    identifierValue(mapValue(recovery, 1), "Member", "Genesis Recovery Member ID"),
    memberId,
    "Genesis Recovery Member ID",
  );
  const recoveryRevision = exactCode(mapValue(recovery, 2), 0, "Genesis Recovery revision");
  const recoverySigningPublicKey = byteString(
    mapValue(recovery, 3),
    32,
    "Genesis Recovery signing public key",
  );
  const recoveryWrappingPublicKey = byteString(
    mapValue(recovery, 4),
    32,
    "Genesis Recovery wrapping public key",
  );
  const keyEpochId = identifierValue(mapValue(body, 4), "KeyEpoch", "Genesis Key Epoch ID");
  same(
    identifierValue(mapValue(body, 5), "RequiredFeatureSet", "Genesis Feature Set ID"),
    genesis.requiredFeatureSetId,
    "Genesis Feature Set ID",
  );
  same(
    genesis.requiredFeatureSetId,
    requiredFeatureSetId(input.initialFeatureManifests.map(({ manifest }) => manifest)),
    "Genesis base Required Feature Set",
  );
  same(clientCredentialId, genesis.signerCredentialId, "Genesis signer Credential");
  const proof = exactMap(mapValue(body, 6), [0, 1], "Genesis creation proof");
  const proofBytes = transcript("awsm:genesis-possession-proof:v1", [
    genesis.vaultId,
    genesis.generationId,
    baselineId,
    memberId,
    encodeCanonicalValue(certificate),
    encodeCanonicalValue(recovery),
    keyEpochId,
    genesis.requiredFeatureSetId,
  ]);
  const sodium = await readySodium();
  if (
    !sodium.crypto_sign_verify_detached(
      byteString(mapValue(proof, 0), 64, "Genesis Client proof"),
      proofBytes,
      clientSigningPublicKey,
    ) ||
    !sodium.crypto_sign_verify_detached(
      byteString(mapValue(proof, 1), 64, "Genesis Recovery proof"),
      proofBytes,
      recoverySigningPublicKey,
    ) ||
    !(await verifyVaultEventSignature(genesis, clientSigningPublicKey))
  ) {
    throw new TypeError("Genesis signatures are invalid");
  }
  const initialSlots = input.currentBaselineAuthority.keyEnvelopeSlots.filter(
    (slot) =>
      bytesEqual(slot.keyEpochId, keyEpochId) &&
      ((slot.targetKind === 1 &&
        bytesEqual(slot.targetCredentialId, recoveryCredentialId) &&
        slot.targetRevision === recoveryRevision) ||
        (slot.targetKind === 2 &&
          bytesEqual(slot.targetCredentialId, clientCredentialId) &&
          slot.targetRevision === null)),
  );
  if (
    initialSlots.length !== 2 ||
    !initialSlots.some(({ targetKind }) => targetKind === 1) ||
    !initialSlots.some(({ targetKind }) => targetKind === 2)
  ) {
    throw new TypeError("Current Baseline does not retain both Genesis Key Envelope slots");
  }
  return {
    activeMemberIds: [memberId],
    administratorIds: [memberId],
    administratorConflicts: [],
    activeInvitations: [],
    invitationConflicts: [],
    recoveryCredentials: [
      {
        recoveryCredentialId,
        memberId,
        revision: recoveryRevision,
        signingPublicKey: recoverySigningPublicKey,
        wrappingPublicKey: recoveryWrappingPublicKey,
        effective: true,
      },
    ],
    recoveryConflicts: [],
    keyEpochs: [{ keyEpochId, displayNumber: 0, current: true }],
    keyEpochConflicts: [],
    keyEnvelopeSlots: initialSlots,
    requiredFeatureSetId: genesis.requiredFeatureSetId,
    featureManifests: input.initialFeatureManifests,
    featureSetConflict: null,
    writeFences: [],
    clientCredentials: new Map([
      [
        identifierKey(clientCredentialId),
        {
          clientCredentialId,
          memberId,
          signingPublicKey: clientSigningPublicKey,
          wrappingPublicKey: clientWrappingPublicKey,
          active: true,
        },
      ],
    ]),
    lifecycle: 1,
  };
}

async function replayContinuityProof(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly initialAuthority: CanonicalAuthorityState;
  readonly genesis: AuthenticatedVaultEvent;
  readonly continuityEvents: readonly AuthenticatedVaultEvent[];
}): Promise<CanonicalAuthorityReplay> {
  const genesisEvents = input.continuityEvents.filter(
    (event) => event.family === 1 && event.type === 1,
  );
  if (
    genesisEvents.length !== 1 ||
    !bytesEqual(genesisEvents[0]?.recordId ?? new Uint8Array(), input.genesis.recordId) ||
    input.continuityEvents.some((event) => event.family === 2)
  ) {
    throw new TypeError("Continuity Proof must contain one Genesis and only authority semantics");
  }
  const supportedFeatureManifestIds = input.continuityEvents.flatMap((event) =>
    canonicalAuthorityFeatureManifestRequirements(event).map(({ id }) => id),
  );
  const authorityReplay = new CanonicalAuthorityReplay(
    input.genesis,
    input.genesis.recordId,
    input.initialAuthority,
    [
      ...input.initialAuthority.featureManifests.map(({ id }) => id),
      ...supportedFeatureManifestIds,
    ],
  );
  const pendingProofEvents = input.continuityEvents.filter(
    (event) => !bytesEqual(event.recordId, input.genesis.recordId),
  );
  while (pendingProofEvents.length > 0) {
    const ready = pendingProofEvents
      .filter(
        (event) =>
          event.authorityParentRecordIds.length > 0 &&
          event.authorityParentRecordIds.every((recordId) => authorityReplay.hasRecord(recordId)),
      )
      .sort((left, right) => compareBytes(left.recordId, right.recordId));
    if (ready.length === 0) {
      throw new TypeError("Continuity Proof has a missing or cyclic Authority Parent");
    }
    for (const event of ready) {
      await authorityReplay.validateAndAccept(event);
      pendingProofEvents.splice(pendingProofEvents.indexOf(event), 1);
    }
  }
  return authorityReplay;
}

export interface CanonicalAuthorityDependencyResolver {
  readonly resolveKeyEnvelope: (requirement: {
    readonly keyEnvelopeId: Identifier<"KeyEnvelope">;
    readonly keyEpochId: Identifier<"KeyEpoch">;
  }) => Promise<Uint8Array>;
  readonly resolveFeatureManifest: (requirement: {
    readonly featureManifestId: Identifier<"FeatureManifest">;
  }) => Promise<Uint8Array>;
}

async function resolveContinuityDependencies(input: {
  readonly initialAuthority: CanonicalAuthorityState;
  readonly baselineAuthority: CanonicalAuthorityState;
  readonly baselineFeatureManifests: readonly CanonicalAuthorityFeatureManifest[];
  readonly continuityEvents: readonly AuthenticatedVaultEvent[];
  readonly resolver: CanonicalAuthorityDependencyResolver;
  readonly resolvedFeatureManifestBytes: Map<string, Uint8Array>;
}): Promise<void> {
  const requirements = new Map<
    string,
    {
      readonly keyEnvelopeId: Identifier<"KeyEnvelope">;
      readonly keyEpochId: Identifier<"KeyEpoch">;
    }
  >();
  const retain = (requirement: {
    readonly keyEnvelopeId: Identifier<"KeyEnvelope">;
    readonly keyEpochId: Identifier<"KeyEpoch">;
  }): void => {
    const requirementKey = identifierKey(requirement.keyEnvelopeId);
    const prior = requirements.get(requirementKey);
    if (prior !== undefined) {
      same(prior.keyEpochId, requirement.keyEpochId, "Key Envelope requirement Epoch");
      return;
    }
    requirements.set(requirementKey, {
      keyEnvelopeId: requirement.keyEnvelopeId,
      keyEpochId: requirement.keyEpochId,
    });
  };
  for (const slot of input.initialAuthority.keyEnvelopeSlots) retain(slot);
  for (const slot of input.baselineAuthority.keyEnvelopeSlots) retain(slot);
  for (const event of input.continuityEvents) {
    for (const requirement of canonicalAuthorityKeyEnvelopeRequirements(event)) {
      retain(requirement);
    }
  }
  const ordered = [...requirements.values()].sort((left, right) =>
    compareBytes(left.keyEnvelopeId, right.keyEnvelopeId),
  );
  for (const requirement of ordered) {
    await input.resolver.resolveKeyEnvelope(requirement);
  }

  const featureRequirements = new Map<string, CanonicalAuthorityFeatureManifest>();
  const retainFeature = (requirement: CanonicalAuthorityFeatureManifest): void => {
    const requirementKey = identifierKey(requirement.id);
    const prior = featureRequirements.get(requirementKey);
    if (prior !== undefined) {
      same(prior.bytes, requirement.bytes, "Feature Manifest requirement bytes");
      return;
    }
    featureRequirements.set(requirementKey, requirement);
  };
  for (const requirement of input.baselineFeatureManifests) retainFeature(requirement);
  for (const event of input.continuityEvents) {
    for (const requirement of canonicalAuthorityFeatureManifestRequirements(event)) {
      retainFeature(requirement);
    }
  }
  const orderedFeatures = [...featureRequirements.values()].sort((left, right) =>
    compareBytes(left.id, right.id),
  );
  for (const requirement of orderedFeatures) {
    const requirementKey = identifierKey(requirement.id);
    let bytes = input.resolvedFeatureManifestBytes.get(requirementKey);
    if (bytes === undefined) {
      bytes = await input.resolver.resolveFeatureManifest({ featureManifestId: requirement.id });
      input.resolvedFeatureManifestBytes.set(requirementKey, bytes);
    }
    same(featureManifestId(bytes), requirement.id, "Resolved Feature Manifest ID");
    same(bytes, requirement.bytes, "Resolved Feature Manifest bytes");
    decodeFeatureManifest(bytes);
  }
}

export async function validateCurrentVaultAuthority(input: {
  readonly baseline: VaultBaseline;
  readonly genesis: AuthenticatedVaultEvent;
  readonly continuityEvents: readonly AuthenticatedVaultEvent[];
  readonly replicaState: CanonicalReplicaState;
  readonly clientSecret: ClientSecretState | null;
  readonly epochSecret: EpochSecretState;
  readonly dependencyResolver: CanonicalAuthorityDependencyResolver;
}): Promise<void> {
  const { baseline, genesis, replicaState, clientSecret, epochSecret } = input;
  same(epochSecret.vaultId, replicaState.vaultId, "Epoch Secret Vault ID");
  same(epochSecret.keyEpochId, replicaState.currentKeyEpochId, "Current Key Epoch ID");
  const genesisBody = exactMap(genesis.body, [0, 1, 2, 3, 4, 5, 6], "Genesis body");
  const initialKeyEpochId = identifierValue(
    mapValue(genesisBody, 4),
    "KeyEpoch",
    "Genesis Key Epoch ID",
  );
  const baselineBody = exactMap(baseline.body, [0, 1, 2, 3, 4, 5], "Current Baseline body");
  const proofFeatureManifests = new Map<string, CanonicalAuthorityFeatureManifest>();
  for (const event of input.continuityEvents) {
    for (const requirement of canonicalAuthorityFeatureManifestRequirements(event)) {
      const requirementKey = identifierKey(requirement.id);
      const prior = proofFeatureManifests.get(requirementKey);
      if (prior !== undefined) {
        same(prior.bytes, requirement.bytes, "Continuity Feature Manifest bytes");
      } else {
        proofFeatureManifests.set(requirementKey, requirement);
      }
    }
  }
  const resolvedFeatureManifestBytes = new Map<string, Uint8Array>();
  const baselineFeatureManifests: CanonicalAuthorityFeatureManifest[] = [];
  for (const dependency of baseline.dependencies) {
    if (dependency.type !== DEPENDENCY_TYPES.FeatureManifest) continue;
    const dependencyKey = identifierKey(dependency.id);
    const proofManifest = proofFeatureManifests.get(dependencyKey);
    if (proofManifest !== undefined) {
      baselineFeatureManifests.push(proofManifest);
      continue;
    }
    const bytes = await input.dependencyResolver.resolveFeatureManifest({
      featureManifestId: dependency.id as Identifier<"FeatureManifest">,
    });
    same(featureManifestId(bytes), dependency.id, "Baseline Feature Manifest ID");
    resolvedFeatureManifestBytes.set(dependencyKey, bytes);
    baselineFeatureManifests.push({
      id: dependency.id as Identifier<"FeatureManifest">,
      bytes,
      manifest: decodeFeatureManifest(bytes),
    });
  }
  const baselineAuthority = decodeCanonicalAuthorityCheckpoint({
    vaultId: replicaState.vaultId,
    checkpoint: mapValue(baselineBody, 3),
    requiredFeatureSetId: baseline.requiredFeatureSetId,
    featureManifests: baselineFeatureManifests,
    lifecycle: 1,
  });
  const initialFeatureManifests = baselineFeatureManifests.filter(
    ({ id }) => !proofFeatureManifests.has(identifierKey(id)),
  );
  const initialAuthority = await genesisAuthorityState({
    vaultId: replicaState.vaultId,
    genesis,
    currentBaselineAuthority: baselineAuthority,
    initialFeatureManifests,
  });
  const authorityReplay = await replayContinuityProof({
    vaultId: replicaState.vaultId,
    initialAuthority,
    genesis,
    continuityEvents: input.continuityEvents,
  });
  const currentAuthority = authorityReplay.stateAt(replicaState.authorityFrontier);
  same(
    currentAuthority.requiredFeatureSetId,
    replicaState.requiredFeatureSetId,
    "Replica Required Feature Set",
  );
  if (currentAuthority.lifecycle !== replicaState.lifecycle) {
    throw new TypeError("Replica lifecycle does not match current Authority State");
  }
  if (
    !currentAuthority.keyEpochs.some(
      ({ keyEpochId, current }) =>
        current && bytesEqual(keyEpochId, replicaState.currentKeyEpochId),
    )
  ) {
    throw new TypeError("Replica current Key Epoch is not an accepted Authority head");
  }
  validateLocalClientAuthority({
    vaultId: replicaState.vaultId,
    authority: currentAuthority,
    replicaAuthority: replicaState,
    clientSecret,
  });
  const reachableProofRecordIds = authorityReplay.reachableRecordIds(
    replicaState.authorityFrontier,
  );
  sameSet(
    input.continuityEvents.map(({ recordId }) => recordId),
    reachableProofRecordIds,
    "Continuity Proof reachable Record set",
  );
  sameSet(
    replicaState.continuityRecordIds,
    input.continuityEvents.map(({ recordId }) => recordId),
    "Continuity Proof Record set",
  );

  const adoption = replicaState.adoption;
  if (adoption === null) {
    await validateInitialVaultAuthority({
      baseline,
      genesis,
      replicaState: {
        ...replicaState,
        generationId: baseline.generationId,
        baselineId: baseline.recordId,
        currentKeyEpochId: initialKeyEpochId,
        requiredFeatureSetId: baseline.requiredFeatureSetId,
        authoringClientCredentialId: null,
        memberId: null,
        lifecycle: 1,
        adoption: null,
      },
      clientSecret: null,
      epochSecret: {
        ...epochSecret,
        keyEpochId: initialKeyEpochId,
        displayNumber: 0,
      },
      featureManifestIds: baselineFeatureManifests.map(({ id }) => id),
      requireInitialReplicaState: false,
    });
    if (
      input.continuityEvents.some((event) => event.family === 3 && event.type === 1) ||
      !bytesEqual(
        baseline.recordId,
        identifierValue(mapValue(genesisBody, 0), "VaultRecord", "Genesis Baseline ID"),
      )
    ) {
      throw new TypeError("Initial Vault authority has an unexpected Vacuum boundary");
    }
    await resolveContinuityDependencies({
      initialAuthority,
      baselineAuthority,
      baselineFeatureManifests,
      continuityEvents: input.continuityEvents,
      resolver: input.dependencyResolver,
      resolvedFeatureManifestBytes,
    });
    return;
  }
  const vacuumEvents = input.continuityEvents.filter(
    (event) => event.family === 3 && event.type === 1,
  );
  if (vacuumEvents.length === 0) {
    throw new TypeError("Vacuum Adoption has no authenticated boundary chain");
  }

  let predecessorGenerationId = genesis.generationId;
  const remaining = [...vacuumEvents];
  let latestBoundary:
    | {
        readonly event: AuthenticatedVaultEvent;
        readonly predecessorFrontier: readonly Uint8Array[];
        readonly predecessorStateDigest: Uint8Array;
        readonly successorStateDigest: Uint8Array;
        readonly successorBaselineId: Uint8Array;
      }
    | undefined;
  while (remaining.length > 0) {
    const candidates = remaining.filter((event) =>
      bytesEqual(event.generationId, predecessorGenerationId),
    );
    if (candidates.length !== 1) {
      throw new TypeError("Vacuum Continuity Proof is not one deterministic Generation chain");
    }
    const vacuumEvent = candidates[0] as (typeof candidates)[number];
    remaining.splice(remaining.indexOf(vacuumEvent), 1);
    for (const [field, left, right] of [
      ["Vacuum Vault ID", vacuumEvent.vaultId, replicaState.vaultId],
      ["Vacuum predecessor Generation", vacuumEvent.generationId, predecessorGenerationId],
    ] as const) {
      same(left, right, field);
    }
    const eventBody = exactMap(vacuumEvent.body, [...Array(7).keys()], "Vacuum Event body");
    const signedPredecessorGenerationId = identifierValue(
      mapValue(eventBody, 0),
      "Generation",
      "Vacuum predecessor Generation ID",
    );
    const predecessorFrontier = idSetValue(
      mapValue(eventBody, 1),
      "VaultRecord",
      "Vacuum predecessor Frontier",
      { nonempty: true },
    );
    same(
      signedPredecessorGenerationId,
      predecessorGenerationId,
      "Vacuum predecessor Generation ID",
    );
    sameSet(vacuumEvent.parentRecordIds, predecessorFrontier, "Vacuum causal parents");
    const successorGenerationId = identifierValue(
      mapValue(eventBody, 2),
      "Generation",
      "Vacuum successor Generation ID",
    );
    if (bytesEqual(predecessorGenerationId, successorGenerationId)) {
      throw new TypeError("Vacuum successor Generation ID is not fresh");
    }
    const successorBaselineId = identifierValue(
      mapValue(eventBody, 3),
      "VaultRecord",
      "Vacuum successor Baseline ID",
    );
    sameCanonical(
      dependencySet(vacuumEvent.dependencies),
      dependencySet([{ type: DEPENDENCY_TYPES.VaultBaseline, id: successorBaselineId }]),
      "Vacuum dependency",
    );
    const predecessorStateDigest = byteString(
      mapValue(eventBody, 4),
      32,
      "Vacuum predecessor state digest",
    );
    const successorStateDigest = byteString(
      mapValue(eventBody, 5),
      32,
      "Vacuum successor state digest",
    );
    byteString(mapValue(eventBody, 6), 32, "Vacuum omission digest");

    latestBoundary = {
      event: vacuumEvent,
      predecessorFrontier,
      predecessorStateDigest,
      successorStateDigest,
      successorBaselineId,
    };
    predecessorGenerationId = successorGenerationId;
  }
  if (latestBoundary === undefined) {
    throw new TypeError("Vacuum Adoption has no latest authenticated boundary");
  }
  same(predecessorGenerationId, baseline.generationId, "Current successor Generation");
  same(baseline.recordId, replicaState.baselineId, "Active successor Baseline ID");
  same(latestBoundary.event.recordId, adoption.vacuumEventRecordId, "Latest adopted Vacuum Event");
  same(latestBoundary.successorBaselineId, baseline.recordId, "Current successor Baseline");
  same(baseline.vaultId, replicaState.vaultId, "Successor Baseline Vault ID");
  same(
    baseline.requiredFeatureSetId,
    replicaState.requiredFeatureSetId,
    "Successor Required Feature Set",
  );

  const successorBody = exactMap(baseline.body, [0, 1, 2, 3, 4, 5], "Successor Baseline body");
  exactCode(mapValue(successorBody, 1), 2, "Successor Baseline kind");
  const boundaryAuthority = authorityReplay.stateAt([latestBoundary.event.recordId]);
  sameCanonical(
    mapValue(successorBody, 3),
    encodeCanonicalAuthorityCheckpoint({
      vaultId: replicaState.vaultId,
      authority: boundaryAuthority,
    }),
    "Successor authority state",
  );
  sameCanonical(
    mapValue(successorBody, 4),
    canonicalMap([[0, boundaryAuthority.lifecycle]]),
    "Successor lifecycle state",
  );
  const predecessor = exactMap(
    mapValue(successorBody, 5),
    [0, 1, 2],
    "Successor predecessor commitment",
  );
  same(
    identifierValue(mapValue(predecessor, 0), "Generation"),
    latestBoundary.event.generationId,
    "Committed predecessor Generation",
  );
  sameSet(
    idSetValue(mapValue(predecessor, 1), "VaultRecord", "Committed predecessor Frontier", {
      nonempty: true,
    }),
    latestBoundary.predecessorFrontier,
    "Committed predecessor Frontier",
  );
  same(
    byteString(mapValue(predecessor, 2), 32, "Committed predecessor state digest"),
    latestBoundary.predecessorStateDigest,
    "Committed predecessor state digest",
  );
  const selectedSuccessorState = canonicalMap([
    [0, mapValue(successorBody, 2)],
    [1, mapValue(successorBody, 3)],
    [2, mapValue(successorBody, 4)],
  ]);
  same(
    await sha256(
      transcript("awsm:vacuum-successor-state:v1", [encodeCanonicalValue(selectedSuccessorState)]),
    ),
    latestBoundary.successorStateDigest,
    "Vacuum successor state digest",
  );
  sameCanonical(
    dependencySet(baseline.dependencies),
    dependencySet([
      ...vaultBaselineDependencyRequirements(baseline.body),
      ...boundaryAuthority.featureManifests.map(({ id }) => ({
        type: DEPENDENCY_TYPES.FeatureManifest,
        id,
      })),
    ]),
    "Successor Baseline dependency closure",
  );
  await resolveContinuityDependencies({
    initialAuthority,
    baselineAuthority,
    baselineFeatureManifests,
    continuityEvents: input.continuityEvents,
    resolver: input.dependencyResolver,
    resolvedFeatureManifestBytes,
  });
}

export async function validateInitialVaultAuthority(input: {
  readonly baseline: VaultBaseline;
  readonly genesis: AuthenticatedVaultEvent;
  readonly replicaState: CanonicalReplicaState;
  readonly clientSecret: ClientSecretState | null;
  readonly epochSecret: EpochSecretState;
  readonly featureManifestIds: readonly Identifier<"FeatureManifest">[];
  readonly requireInitialReplicaState?: boolean;
}): Promise<void> {
  const { baseline, genesis, replicaState, clientSecret, epochSecret } = input;
  if (genesis.family !== 1 || genesis.type !== 1) {
    throw new TypeError("Initial authority root is not Genesis");
  }
  if (genesis.parentRecordIds.length !== 0 || genesis.authorityParentRecordIds.length !== 0) {
    throw new TypeError("Genesis must be parentless");
  }
  for (const [field, left, right] of [
    ["Baseline Vault ID", baseline.vaultId, replicaState.vaultId],
    ["Genesis Vault ID", genesis.vaultId, replicaState.vaultId],
    ["Baseline Generation ID", baseline.generationId, replicaState.generationId],
    ["Genesis Generation ID", genesis.generationId, replicaState.generationId],
    ["Active Baseline ID", baseline.recordId, replicaState.baselineId],
    ["Epoch Secret Vault ID", epochSecret.vaultId, replicaState.vaultId],
    ["Current Key Epoch ID", epochSecret.keyEpochId, replicaState.currentKeyEpochId],
  ] as const) {
    same(left, right, field);
  }
  if (input.requireInitialReplicaState ?? true) {
    if (
      replicaState.causalFrontier.length !== 1 ||
      replicaState.authorityFrontier.length !== 1 ||
      replicaState.continuityRecordIds.length !== 1
    ) {
      throw new TypeError("Initial Replica State must recognize exactly Genesis");
    }
    same(replicaState.causalFrontier[0] ?? new Uint8Array(), genesis.recordId, "Causal Frontier");
    same(
      replicaState.authorityFrontier[0] ?? new Uint8Array(),
      genesis.recordId,
      "Authority Frontier",
    );
  }
  if (
    !replicaState.continuityRecordIds.some((recordId) => bytesEqual(recordId, genesis.recordId))
  ) {
    throw new TypeError("The Continuity Proof does not retain Genesis");
  }
  same(genesis.requiredFeatureSetId, baseline.requiredFeatureSetId, "Genesis Required Feature Set");
  same(
    genesis.requiredFeatureSetId,
    replicaState.requiredFeatureSetId,
    "Replica Required Feature Set",
  );

  const genesisBody = exactMap(genesis.body, [0, 1, 2, 3, 4, 5, 6], "Genesis body");
  same(
    identifierValue(mapValue(genesisBody, 0), "VaultRecord", "Genesis Baseline ID"),
    baseline.recordId,
    "Genesis Baseline ID",
  );
  const firstMemberId = identifierValue(
    mapValue(genesisBody, 1),
    "Member",
    "Genesis first Member ID",
  );
  const clientCertificate = exactMap(
    mapValue(genesisBody, 2),
    [0, 1, 2, 3],
    "Genesis Client Certificate",
  );
  const recoveryCredential = exactMap(
    mapValue(genesisBody, 3),
    [0, 1, 2, 3, 4],
    "Genesis Recovery Credential",
  );
  const clientCredentialId = identifierValue(
    mapValue(clientCertificate, 0),
    "ClientCredential",
    "Genesis Client Credential ID",
  );
  const initialClient = initialVaultClientAuthority(genesis);
  same(clientCredentialId, genesis.signerCredentialId, "Genesis signer Credential");
  same(clientCredentialId, initialClient.clientCredentialId, "Genesis Client Credential");
  same(firstMemberId, initialClient.memberId, "Genesis first Member");
  if (clientSecret === null) {
    if (replicaState.authoringClientCredentialId !== null || replicaState.memberId !== null) {
      throw new TypeError("A Replica without a local Client Secret cannot claim local authority");
    }
  } else {
    same(clientSecret.vaultId, replicaState.vaultId, "Client Secret Vault ID");
    same(clientCredentialId, clientSecret.clientCredentialId, "Stored Client Credential");
    same(firstMemberId, clientSecret.memberId, "Stored Client member");
    if (replicaState.authoringClientCredentialId !== null) {
      same(clientCredentialId, replicaState.authoringClientCredentialId, "Authoring Credential");
    }
    if (replicaState.memberId !== null) {
      same(firstMemberId, replicaState.memberId, "Replica member");
    }
  }
  same(
    identifierValue(mapValue(clientCertificate, 1), "Member", "Certificate Member ID"),
    firstMemberId,
    "Certificate Member ID",
  );
  same(
    identifierValue(mapValue(recoveryCredential, 1), "Member", "Recovery Member ID"),
    firstMemberId,
    "Recovery Member ID",
  );
  exactCode(mapValue(recoveryCredential, 2), 0, "Initial Recovery Credential revision");
  same(
    byteString(mapValue(clientCertificate, 2), 32, "Client signing public key"),
    initialClient.signingPublicKey,
    "Client signing public key",
  );
  same(
    byteString(mapValue(clientCertificate, 3), 32, "Client wrapping public key"),
    initialClient.wrappingPublicKey,
    "Client wrapping public key",
  );
  const recoverySigningPublicKey = byteString(
    mapValue(recoveryCredential, 3),
    32,
    "Recovery signing public key",
  );
  const recoveryCredentialId = identifierValue(
    mapValue(recoveryCredential, 0),
    "RecoveryCredential",
    "Genesis Recovery Credential ID",
  );
  const initialEpochId = identifierValue(
    mapValue(genesisBody, 4),
    "KeyEpoch",
    "Genesis Key Epoch ID",
  );
  same(initialEpochId, epochSecret.keyEpochId, "Genesis Key Epoch ID");
  same(
    identifierValue(mapValue(genesisBody, 5), "RequiredFeatureSet", "Genesis Feature Set ID"),
    genesis.requiredFeatureSetId,
    "Genesis Feature Set ID",
  );

  const proof = exactMap(mapValue(genesisBody, 6), [0, 1], "Genesis creation proof");
  const proofTranscript = transcript("awsm:genesis-possession-proof:v1", [
    genesis.vaultId,
    genesis.generationId,
    baseline.recordId,
    firstMemberId,
    encodeCanonicalValue(clientCertificate),
    encodeCanonicalValue(recoveryCredential),
    initialEpochId,
    genesis.requiredFeatureSetId,
  ]);
  const sodium = await readySodium();
  if (
    !sodium.crypto_sign_verify_detached(
      byteString(mapValue(proof, 0), 64, "Genesis Client proof"),
      proofTranscript,
      initialClient.signingPublicKey,
    ) ||
    !sodium.crypto_sign_verify_detached(
      byteString(mapValue(proof, 1), 64, "Genesis Recovery proof"),
      proofTranscript,
      recoverySigningPublicKey,
    ) ||
    !(await verifyVaultEventSignature(genesis, initialClient.signingPublicKey))
  ) {
    throw new TypeError("Genesis signatures are invalid");
  }

  const baselineBody = exactMap(baseline.body, [0, 1, 2, 3, 4, 5], "Initial Baseline body");
  exactCode(mapValue(baselineBody, 0), 1, "Baseline body format");
  exactCode(mapValue(baselineBody, 1), 1, "Initial Baseline kind");
  const authority = exactMap(
    mapValue(baselineBody, 3),
    [...Array(10).keys()],
    "Initial authority checkpoint",
  );
  sameCanonical(mapValue(authority, 1), canonicalSet([firstMemberId]), "Initial members");
  sameCanonical(mapValue(authority, 2), canonicalSet([firstMemberId]), "Initial Administrators");
  sameCanonical(
    mapValue(authority, 3),
    canonicalSet([clientCertificate]),
    "Initial Client Certificates",
  );
  sameCanonical(
    mapValue(authority, 4),
    canonicalSet([recoveryCredential]),
    "Initial Recovery Credentials",
  );
  const epochs = mapValue(authority, 6);
  sameCanonical(epochs, canonicalSet([canonicalMapForEpoch(initialEpochId)]), "Initial Key Epoch");
  const slotValues = mapValue(authority, 7);
  if (!Array.isArray(slotValues) || slotValues.length !== 2) {
    throw new TypeError("Initial authority must contain exactly two Key Envelope slots");
  }
  let sawClient = false;
  let sawRecovery = false;
  for (const [index, slotValue] of slotValues.entries()) {
    const slot = exactMap(slotValue, [0, 1, 2, 3, 4], `Initial Key Envelope slot ${index}`);
    same(
      identifierValue(mapValue(slot, 0), "KeyEpoch", "Slot Key Epoch ID"),
      initialEpochId,
      "Slot Key Epoch ID",
    );
    const targetKind = oneOfCodes(mapValue(slot, 1), [1, 2] as const, "Slot target kind");
    const targetRevision = nullable(mapValue(slot, 3), (value) =>
      exactCode(value, 0, "Initial Recovery revision"),
    );
    if (targetKind === 1) {
      if (sawRecovery || targetRevision !== 0) {
        throw new TypeError("Initial Recovery Key Envelope slot is duplicated or malformed");
      }
      same(
        identifierValue(mapValue(slot, 2), "RecoveryCredential", "Slot Recovery Credential ID"),
        recoveryCredentialId,
        "Slot Recovery Credential ID",
      );
      sawRecovery = true;
    } else {
      if (sawClient || targetRevision !== null) {
        throw new TypeError("Initial Client Key Envelope slot is duplicated or malformed");
      }
      same(
        identifierValue(mapValue(slot, 2), "ClientCredential", "Slot Client Credential ID"),
        clientCredentialId,
        "Slot Client Credential ID",
      );
      sawClient = true;
    }
    identifierValue(mapValue(slot, 4), "KeyEnvelope", "Slot Key Envelope ID");
  }
  if (!sawClient || !sawRecovery) {
    throw new TypeError("Initial authority is missing a required Key Envelope slot");
  }
  sameCanonical(
    dependencySet(baseline.dependencies),
    dependencySet([
      ...vaultBaselineDependencyRequirements(baseline.body),
      ...input.featureManifestIds.map((id) => ({
        type: DEPENDENCY_TYPES.FeatureManifest,
        id,
      })),
    ]),
    "Initial Baseline dependency closure",
  );
}

function canonicalMapForEpoch(keyEpochId: Uint8Array): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap([
    [0, keyEpochId],
    [1, 0],
    [2, true],
  ]);
}
