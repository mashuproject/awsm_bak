# Vault Authority Specification

**Document:** `docs/specifications/vault/authority.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/core/serialization.md`
- `docs/specifications/crypto/crypto.md`
- `docs/specifications/event/event-format.md`
- `docs/specifications/event/reducers.md`
- `docs/specifications/vault/vault.md`

---

# 1. Purpose

This specification defines portable Vault membership, administration, Client and Recovery
Credentials, Invitations, Key Epoch authority, feature activation, exact Authority Event bodies,
and deterministic Authority State derivation. Accounts and Replica Access Grants are outside this
contract.

# 2. Common authority structures

## 2.1 Client Credential Certificate

```text
{
  0: clientCredentialId, // 32 random bytes
  1: memberId,           // 32 bytes
  2: signingPublicKey,   // 32-byte Ed25519 key
  3: wrappingPublicKey   // 32-byte X25519 key
}
```

The Vault ID and Generation come from the containing Event or Baseline. A Certificate has no label,
role, Account, Host, or private key.

## 2.2 Recovery Credential descriptor

```text
{
  0: recoveryCredentialId, // 32 random bytes
  1: memberId,             // 32 bytes
  2: revision,             // nonnegative integer
  3: signingPublicKey,     // 32-byte Ed25519 key
  4: wrappingPublicKey     // 32-byte X25519 key
}
```

Concurrent candidates may have the same revision but MUST have distinct random IDs and public key
material. Identity and ancestry, not revision alone, determine the effective heads.

## 2.3 Key Envelope slot

```text
{
  0: keyEpochId,
  1: targetKind,       // 1 Recovery Credential, 2 Client Credential
  2: targetCredentialId,
  3: targetRevision,   // Recovery revision; null for Client Credential
  4: keyEnvelopeId     // Typed Dependency Reference type 7 MUST exist
}
```

Slot arrays are canonical sets ordered by their complete CBOR encoding. Duplicate exact slots are
invalid. For a Key Epoch transition, the set MUST exactly equal the targets derived from the
post-transition Authority State. Key Delivery contains only previously missing eligible slots.

## 2.4 Invitation Capability descriptor

```text
{
  0: authorityDomain, // canonical scoped key, e.g. "awsm.vault"
  1: issuerMemberId,  // 32-byte Vault Member ID
  2: targetVaultId,   // 32-byte Vault ID
  3: action,          // canonical scoped key
  4: parameters       // exact canonical byte string; empty when none
}
```

Capability arrays are sorted and duplicate-free. The initial portable actions are
`awsm.vault.join` and `awsm.vault.administrator`. A Host-local Replica Access Capability is never
placed in a Vault Invitation; an out-of-band invitation package MAY pair independently authorized
Host access with the portable Invitation without merging their authority domains.

# 3. Authority State

At one exact Vault Record Frontier, deterministic Authority State contains:

- Active Vault Members;
- the current Administrator member set;
- active Client Credential Certificates for each member;
- one or more effective Recovery Credential heads for each member;
- Active Invitations and verified terminal or conflicted outcomes required by the current
  Generation;
- the effective Key Epoch head or explicit Key Epoch Conflict;
- every usable Key Envelope slot for readable Epochs;
- the Required Vault Feature Set;
- derived write fences and type-scoped Authority Conflicts; and
- Open or Closed lifecycle state.

It contains no Account, username, session, Channel Principal, Replica Access Grant, quota, Host
cursor, or Host-local label.

State is derived from the authenticated Authority Parent subgraph or decoded from an authenticated
Baseline and then advanced by Authority and Lifecycle Events. The subgraph is a signed projection
of the one Vault Record DAG, not a second log. Implementations MUST NOT persist a second portable
eligibility or role source.

# 4. Genesis Event body

Authority family type `1` body:

```text
{
  0: initialBaselineId,       // 32-byte Vault Record ID; dependency type 2
  1: firstMemberId,           // 32 random bytes
  2: firstClientCertificate,  // section 2.1; member MUST match key 1
  3: firstRecoveryCredential, // section 2.2; member key 1, revision 0
  4: initialKeyEpochId,       // 32 bytes
  5: requiredFeatureSetId,    // MUST equal Event key 7 and Baseline
  6: creationProof            // section 4.1
}
```

The first member is implicitly and inseparably the first Administrator. The Event's dependency set
MUST contain only the Baseline. The Baseline authority checkpoint MUST contain exactly the initial
Recovery and Client Credential Envelope slots for key 4. Its exact dependency closure contains
those two Key Envelopes, retained Objects, and every Feature Manifest required by the initial set.

## 4.1 Genesis creation proof

```text
{
  0: clientProof,   // 64-byte first Client Credential Ed25519 signature
  1: recoveryProof  // 64-byte first Recovery Credential Ed25519 signature
}
```

Both signatures cover:

```text
Transcript(
  "awsm:genesis-possession-proof:v1",
  [
    vaultId,
    generationId,
    initialBaselineId,
    firstMemberId,
    canonicalClientCertificate,
    canonicalRecoveryCredential,
    initialKeyEpochId,
    requiredFeatureSetId
  ]
)
```

The Event signature itself is also made by the first Client Credential. The trusted creator MUST
locally prove both wrapping private keys by successfully opening challenge Key Envelopes before
commit. Wrapping-key challenge material is Prepared Data and is not portable authority.

A verifier checks all public signatures, envelope slots, Key Epoch commitment, Baseline summary,
Required Feature Set, identifiers, and dependency closure. Genesis is the sole self-authorizing
Event.

# 5. Membership End Event body

Authority family type `2` body:

```text
{ 0: targetMemberId }
```

It is valid when the signer represents the active target member or a different active member who
is an Administrator at the Authority Parents. The first case is resignation; the second is removal.

The derived effects are permanent member inactivity, ineligibility of all target Client
Credentials, ineligibility of the target Recovery Credential for continuing recovery, and loss of
Administrator role. A removal derives a protected-write fence until an excluding Key Epoch
Transition. Resignation alone does not. No replacement Epoch, reason, or status field is present.

# 6. Administrator role Event bodies

Authority family type `3`, Administrator Grant:

```text
{0: targetMemberId, 1: resolvedRecordIds}
```

The signer MUST be an unambiguous current Administrator. The target MUST be active and not already
an Administrator. `resolvedRecordIds` is empty. No target acceptance or Key Epoch change occurs.

Authority family type `4`, Administrator End, uses the same body. The target MUST be an active
Administrator and the signer MUST be an Administrator. A target signer steps down; another signer
revokes the role. Its `resolvedRecordIds` is empty. Ending the final Administrator derives Closure.

When the complete Authority Parents join an Administrator role Conflict for the target, these
ordinary already/not-yet preconditions are replaced by the resolution rule: an independently
unambiguous Administrator signs Grant to select Administrator or End to select non-Administrator.
The Authority Parents MUST descend from every current role candidate Event. `resolvedRecordIds`
MUST equal every current candidate Record ID.

# 7. Invitation capability keys

The Redemption and Cancellation Capability secrets are independent random 32-byte Ed25519 private
seeds. Their public verifiers are the corresponding 32-byte Ed25519 public keys. A holder proves
possession by signing the exact challenge/request transcript; the secret never leaves the holder.
Both public verifiers are portable Invitation state. The Cancellation secret is retained outside
Vault Records and is absent from the recipient link; its verifier is not bearer-equivalent.

The Invitation Redemption Authority has a 32-byte authority ID and a 32-byte Ed25519 receipt
verification key. Its private receipt key is operational state outside the Vault.

# 8. Invitation Creation Event body

Authority family type `5` body:

```text
{
  0: invitationId,             // 32 random bytes
  1: capabilities,             // canonical set, includes awsm.vault.join
  2: redemptionVerifier,       // 32-byte Ed25519 public key
  3: cancellationVerifier,     // 32-byte Ed25519 public key
  4: redemptionAuthorityId,    // 32 bytes
  5: receiptVerificationKey    // 32-byte Ed25519 public key
}
```

The signer MUST be a current Administrator. Every capability MUST name that signer as issuer,
target this Vault, and be portable Vault authority the signer may grant. Host-local access is
independently authorized and absent from this Event.

The derived portable state is Active. There is no expiry field.

# 9. Invitation Join Request

The joining Client Installation produces:

```text
{
  0: invitationId,
  1: capabilities,
  2: proposedMemberId,
  3: proposedClientCertificate,
  4: proposedRecoveryCredential, // revision 0
  5: clientPossessionSignature,
  6: recoveryPossessionSignature,
  7: redemptionSignature
}
```

The three Ed25519 signatures cover:

```text
Transcript(
  "awsm:invitation-join-request:v1",
  [canonical CBOR map containing exactly keys 0 through 4]
)
```

using the proposed Client Credential signing key, proposed Recovery signing key, and Redemption
Capability key respectively. The trusted servicing Replica MUST additionally complete live HPKE
challenge/opening checks for both proposed wrapping public keys before preparing acceptance.

The request is not a Vault Event. Its digest is:

```text
SHA-256(Transcript(
  "awsm:invitation-join-request-id:v1",
  [canonicalJoinRequestBytes]
))
```

# 10. Invitation Acceptance Proposal

```text
{
  0: invitationId,
  1: joinRequestId,
  2: authorityParentRecordIds,
  3: proposedMemberId,
  4: proposedClientCertificate,
  5: proposedRecoveryCredential,
  6: grantedPortableCapabilities,
  7: envelopeSlots
}
```

The slot set contains one Recovery and one Client Credential Key Envelope for every Key Epoch the
new member may read at the bound Authority Parents. The proposal excludes the receipt and final Event
signature.

Its digest is the `awsm:invitation-acceptance-proposal-id:v1` Transcript digest of exact canonical
bytes.

# 11. Redemption Authority receipts

For one Invitation, the authority atomically serializes `Active`, `Reserved`, `Consumed`, and
`Cancelled`. A valid Join Request moves Active to Reserved bound to its exact request ID. The same
request resumes idempotently; a different request cannot replace it. After receiving the exact
Acceptance Proposal ID, the authority moves that reservation to Consumed and issues its receipt. A
valid cancellation request may move Active or a cancellable Reserved state to Cancelled. Consumed
and Cancelled are terminal. Releasing an abandoned reservation is bounded authority-local policy
and MUST NOT race a still-live completion.

A cancellation request is:

```text
{
  0: invitationId,
  1: authorityChallenge, // fresh 32 random bytes supplied by the authority
  2: signature           // 64-byte Cancellation Capability signature
}
```

The signature covers
`Transcript("awsm:invitation-cancel-request:v1", [invitationId, authorityChallenge])`. Its request
ID is the SHA-256 Transcript digest under `awsm:invitation-cancel-request-id:v1` over the complete
canonical request. The authority accepts a challenge only for its exact Invitation and consumes or
expires it under bounded operational policy.

A consumed receipt is:

```text
{
  0: invitationId,
  1: 1,                  // outcome Consumed
  2: joinRequestId,
  3: acceptanceProposalId,
  4: authorityReceiptId, // 32 random Host-local receipt ID
  5: signature
}
```

A cancelled receipt is:

```text
{
  0: invitationId,
  1: 2,                  // outcome Cancelled
  2: cancellationRequestId,
  3: null,
  4: authorityReceiptId,
  5: signature
}
```

The signature is Ed25519 over
`Transcript("awsm:invitation-receipt:v1", [canonical CBOR map containing exactly keys 0..4])`.
For cancellation, the authority first verifies the exact request using the Cancellation Capability
verifier and binds that request ID into the receipt. Neither secret enters the request or receipt.

Receipt timestamps are absent. The authority's atomic local state supplies Invitation-scoped order.

# 12. Invitation Acceptance Event body

Authority family type `6` body:

```text
{
  0: joinRequest,
  1: acceptanceProposal,
  2: consumedReceipt
}
```

The Event Authority Parents MUST exactly equal the proposal Authority Parents. Its causal parents
are the complete current causal Frontier and MUST expose the same Authority Frontier. Its dependency
set MUST contain every proposal Key Envelope. The signer MUST be an already-active Client
Credential able to validate the current state and prepare the envelopes; Administrator authority
is unnecessary because Invitation Creation already supplied it.

The proposed credential MUST NOT sign this Event. Acceptance atomically creates the member,
activates the proposed Client Credential and Recovery Credential, and grants Administrator status
only when the immutable Invitation included and the Join Request acknowledged
`awsm.vault.administrator`.

# 13. Invitation Cancellation Event body

Authority family type `7` body:

```text
{0: cancellationRequest, 1: cancelledReceipt}
```

Any active Client Credential may record the verified terminal receipt. The signer need not possess
the Cancellation Capability because the embedded request and matching receipt prove the
already-authorized result. The Event creates no member and releases no keys.

# 14. Invitation Conflict Resolution Event body

Authority family type `8` body:

```text
{
  0: invitationId,
  1: conflictingReceiptIds, // complete canonical set
  2: conflictingRecordIds,  // complete current Acceptance/Cancellation heads
  3: outcome,               // 1 select consumed candidate, 2 cancel all
  4: selectedJoinRequestId  // required for outcome 1; null for outcome 2
}
```

The signer MUST be an unambiguous pre-existing Administrator independent of every disputed
candidate. The Authority Parent state MUST contain the Invitation Conflict with exactly the named
current Record IDs, and the Authority Parents MUST descend from every candidate Event. It returns
Invitation state to ordinary Consumed or Cancelled. Rejected consumed candidates require a later
excluding Key Epoch.

At a conflicted frontier, no disputed candidate supplies active membership, Client Credential
eligibility, effective Recovery, or Administrator authority. An Event the candidate validly
authored on an acceptance-only branch remains valid at those exact Authority Parents; after the
conflict is visible, that candidate cannot authorize another Event until selected. Selecting one
consumed candidate activates only that candidate. Cancelling all activates none. Every candidate
Credential remains available for Historical Attribution without becoming eligible authority.

# 15. Client Credential Enrollment Proposal

```text
{
  0: vaultId,
  1: memberId,
  2: authorityParentRecordIds,
  3: proposedClientCertificate,
  4: envelopeSlots,
  5: proposedPossessionSignature
}
```

The proposed signature covers
`Transcript("awsm:client-enrollment-proposal:v1", [canonical CBOR map containing exactly keys
0..4])`. A live HPKE challenge proves the proposed wrapping private key before commit. Proposal ID
is the SHA-256 Transcript digest under `awsm:client-enrollment-proposal-id:v1`.

# 16. Client Credential Enrollment Event body

Authority family type `9` body:

```text
{
  0: enrollmentProposal,
  1: authorizationKind, // 1 existing Client Credential, 2 Recovery Credential
  2: recoveryCredentialId,
  3: recoveryAuthorization
}
```

For kind `1`, keys 2 and 3 are null and the Event signer MUST be an active same-member Client
Credential at the proposal Authority Parents. The proposed Client Credential proves possession
only through the embedded proposal.

For kind `2`, key 2 identifies one effective unfenced same-member Recovery Credential and key 3 is
its 64-byte Ed25519 signature over:

```text
Transcript(
  "awsm:recovery-client-enrollment-authorization:v1",
  [enrollmentProposalId]
)
```

For kind `2`, the proposed Client Credential signs the Event. This is the only non-Genesis Event
whose signer need not already be active. At a recovery-conflicted complete frontier, any one
effective candidate may authorize Enrollment without becoming the winner. The next ceremony step
is a descendant all-head Recovery Credential Replacement.

Enrollment and Replacement remain two independently authenticated Events and two atomic local
commits. A Client SHOULD present Replacement immediately after recovery-authorized Enrollment. If
it stops between them, the enrolled Client Credential is active and the previously effective
Recovery head set remains effective; resumption creates an ordinary descendant Replacement.

The dependency set exactly contains the proposal's historical Client Credential Key Envelopes.

# 17. Client Credential End Event body

Authority family type `10` body:

```text
{ 0: targetClientCredentialId }
```

The signer MUST be the target, another active credential of the same member, or a different-member
Administrator. Same-member end derives no write fence; different-member Administrator end does.
Ending an inactive credential is invalid.

# 18. Recovery Credential Replacement Event body

Authority family type `11` body:

```text
{
  0: memberId,
  1: replacedRecoveryCredentialIds, // every effective head at Authority Parents
  2: replacementCredential,         // fresh ID, revision max + 1
  3: recoveryEnvelopeSlots,          // one for every readable Key Epoch
  4: recoveryPossessionSignature
}
```

The possession signature uses the replacement Recovery signing key over:

```text
Transcript(
  "awsm:recovery-replacement-possession:v1",
  [
    vaultId,
    memberId,
    canonicalAuthorityParentRecordIds,
    canonicalReplacementCredential,
    canonicalRecoveryEnvelopeSlots
  ]
)
```

The Event signer MUST be an active Client Credential belonging to `memberId`. The replaced ID set
MUST equal every effective recovery head. Its dependencies are exactly the new Recovery Envelopes.
Acceptance derives the new Recovery Fence.

The fresh phrase is Client-private ceremony input, not portable Event data. A Client MUST obtain
exact full-phrase confirmation before committing the Event. A mismatch changes no portable or
local persistent state and may be retried; cancellation or any attempted commit consumes the
prepared replacement so its secret-bearing material cannot be reused.

# 19. Key Epoch Transition Event body

Authority family type `12` body:

```text
{
  0: parentKeyEpochIds, // all effective heads; one when unconflicted
  1: newKeyEpochId,
  2: displayNumber,     // max parent number + 1
  3: envelopeSlots      // exact derived target set
}
```

The signer MUST be an unambiguous current Administrator. The client generates one fresh 32-byte
Key Epoch Key, computes the ID, and creates every required Recovery and Client Key Envelope. The
key itself appears only inside those Envelopes.

The Event dependency set exactly equals the slot Envelope IDs. It stores no reason, member list,
or Future Protection flag. One canonical Event may have one parent-key encrypted outer
representation per parent Epoch.

# 20. Key Delivery Event body

Authority family type `13` body:

```text
{ 0: envelopeSlots }
```

The set is non-empty and contains only missing eligible slots for already existing Key Epochs and
already authorized active targets at the Event Authority Parents. The signer may be any active
Client Credential whose trusted Runtime possesses and verifies the corresponding Epoch keys.
Administrator authority is unnecessary.

It changes no authority or Epoch identity. A malformed Envelope does not make its slot usable and
does not suppress a later correct delivery.

# 21. Feature Activation Event body

Authority family type `14` body:

```text
{
  0: previousFeatureSetId,
  1: addedFeatureManifests, // canonical set of complete Manifest bytes
  2: resultingFeatureSetId
}
```

The signer MUST be a current Administrator. Key 0 MUST equal Event envelope key 7. The validator
verifies every Manifest ID, requirement, incompatibility, and resulting set. The Event dependency
set contains each added Feature Manifest.

The first dependent operation is a separate descendant Event. Software installation never creates
this Event automatically.

# 22. Target-set derivation

For a new Key Epoch, derive the post-transition target set from the exact Authority State at the
Authority Parents after applying any causally prior authority facts but before activating the new
Epoch:

- every active Client Credential of every Active Member retained by the transition; and
- every effective unfenced Recovery Credential head of each retained member.

While one member has a recovery conflict, all effective candidates are targets. Inactive members
and ended or equivocating Client Credentials are excluded. The encoded slot set MUST equal this
derived set exactly; missing and extra slots invalidate activation.

# 23. Write fences

Authority State derives a protected-write fence from:

- Administrator removal of a member before its excluding Epoch;
- different-member Administrator revocation of a Client Credential before exclusion;
- Client Credential Authority equivocation before exclusion;
- a Key Epoch Conflict;
- an Invitation Conflict involving a consumed candidate before safe resolution and exclusion; or
- another Required Feature that explicitly owns an equivalent security condition.

Self-resignation, same-member Client Credential retirement, Administrator-role change, recovery-
only Conflict, missing delivery for another target, and Host-local Grant loss do not globally fence
protected writes.

The portable Baseline `fenceKind` registry is:

```text
1 Member removal
2 Client Credential removal
3 Invitation Conflict
4 Key Epoch Conflict
```

Kinds 1 through 4 use the removed Member ID, revoked Client Credential ID, conflicted Invitation
ID, and Vault ID respectively as `subjectId`. A Required Feature Set incompatibility is a semantic
runtime fence, not a portable kind in this base registry: it must be resolved before Vacuum can
create a continuing Baseline.

# 24. Recovery discovery and completeness

Recovery uses ordinary authorized opaque Compact inventory. A fresh client:

1. derives its Recovery key pair from the phrase;
2. attempts Recovery HPKE opening locally over bounded pages;
3. treats every opened Key Epoch Key as an untrusted candidate;
4. decrypts candidate Records and Objects;
5. locates and verifies the matching effective Recovery Credential;
6. verifies the Continuity Proof from Genesis through the current Baseline's authenticating Vacuum
   Event, if any;
7. derives every expected readable Epoch and Envelope from the authenticated Authority Frontier and
   Baseline;
8. verifies the complete current causal and dependency closure; and
9. enrolls a fresh Client Credential only after completion.

The Continuity Proof prevents a Host or non-Administrator member from substituting a self-asserted
post-Vacuum Baseline without retaining discarded Content history. These checks prove completeness
relative to the observed frontier. A source may still hide an internally complete later branch;
without another Replica, trusted sequencer, trusted time, or retained newer checkpoint, the client
cannot prove global freshness and MUST NOT claim it.

# 25. Continuity Proof

For one selected causal Frontier, `continuityProofRoots` is its exact Authority Frontier. The
Continuity Proof contains every canonical Genesis, Authority, and Lifecycle Event reached by
following `authorityParentRecordIds` from those roots, plus the exact authority-semantic typed
dependencies required below. It is a canonical immutable Record set, not a new signed package or
Event family.

A fresh verifier MUST:

1. recompute every proof Record ID and verify exact envelope encoding;
2. verify Genesis's self-authorizing signatures and bootstrap authority directly from its body,
   without requiring the Initial Baseline or that Baseline's content dependencies;
3. follow only signed Authority Parent edges for proof ancestry and reject a missing, extra,
   cross-Vault, or invalid edge;
4. derive Authority State and validate each Authority or Lifecycle Event at its exact Authority
   Parents, including its signature, body, Required Feature Set, and authority-semantic dependency;
5. retain and validate Key Envelopes, Feature Manifests, and other compact dependencies whose
   contents affect authority, while leaving unrelated causal Content parents unresolved;
6. treat an earlier Vacuum Event's successor Baseline reference as a signed continuity commitment,
   not a retained state dependency;
7. identify the current Generation anchor as Genesis for its Initial Baseline or the latest
   applicable predecessor Vacuum Event, and verify that it binds the exact current Baseline ID,
   Generation, predecessor Frontier where applicable, and state digests; and
8. require the current Baseline authority and lifecycle checkpoints to equal Authority State at
   that anchor, then apply every descendant proof Event to derive the selected Authority Frontier.

Genesis bootstrap reconstructs only facts that Genesis proves directly: the first Member and
Administrator, first Client and Recovery Credentials, initial Key Epoch, and initial Required
Feature Set. It does not trust the rest of the current Baseline checkpoint as initial state. The
current checkpoint supplies candidate IDs for the two Genesis Key Envelope slots; they MUST name
exactly that Epoch, Client Credential, and revision-zero Recovery Credential. Full replay and the
Generation anchor comparison subsequently authenticate those candidates.

The initial Feature Manifest closure is the current Baseline's Manifest dependency set excluding
every Manifest introduced by a retained Feature Activation Event. Its exact Required Feature Set
ID MUST equal Genesis. Complete Manifest bytes introduced by Feature Activation come from the
signed Event for semantic replay. After the complete proof and current Baseline anchor validate,
the verifier MUST independently resolve every distinct initial, checkpointed, or Event-introduced
Feature Manifest and compare its derived ID and exact bytes. It performs the analogous resolved
identity and Epoch check for every distinct retained Key Envelope requirement. An invalid proof
Event MUST fail before any dependency ID introduced by that Event is resolved.

The proof roots and Record set are canonical sets. Extra proof Records are invalid in Complete
Export and Backup and ignored as unselected candidates during opaque synchronization. Missing proof
Records or required authority-semantic dependencies block Recovery, Import, Restore, Adoption, and
authoring from that Baseline.

After an adopted successor is independently established, Genesis remains permanent but its Initial
Baseline does not. Genesis's signed Baseline ID remains historical evidence; the Initial Baseline
and its unrelated dependency closure may be reclaimed when no other preservation root retains
them.

This proof authenticates authority continuity and the Administrator's destructive Vacuum decision.
It does not reconstruct discarded Content state or prove global freshness. Existing Replicas still
verify full predecessor replay equivalence before first Adoption.

# 26. Baseline authority codec

The `authorityCheckpoint` in `vault.md` is:

```text
{
  0: 1,                   // authorityCheckpointFormat
  1: activeMemberIds,
  2: administratorIds,
  3: clientCertificates,
  4: recoveryCredentials,
  5: activeInvitations,
  6: keyEpochs,
  7: envelopeSlots,
  8: activeConflicts,
  9: activeFences
}
```

Every collection is a canonical set. `clientCertificates` and `recoveryCredentials` use section 2. `activeInvitations` uses:

```text
{
  0: invitationId,
  1: redemptionVerifier,
  2: cancellationVerifier,
  3: capabilities,
  4: creationRecordId,
  5: redemptionAuthorityId,
  6: receiptVerificationKey
}
```

`keyEpochs` uses:

```text
{
  0: keyEpochId,
  1: displayNumber,
  2: isCurrent
}
```

Exactly one Epoch is current unless an explicit Key Epoch Conflict exists. Every retained Object's
Epoch and every current or recovery-readable Epoch appears. `envelopeSlots` uses section 2.3 and
MUST exactly cover the delivery required by the checkpointed eligibility state.

An active conflict entry is:

```text
{
  0: conflictKind, // registry below
  1: subjectId,
  2: candidates
}
```

The exact conflict kinds and candidate codecs are:

```text
// kind 1 Invitation; subjectId = Invitation ID
{
  0: headRecordId,
  1: outcome,           // 1 Consumed, 2 Cancelled
  2: authorityReceiptId,
  3: joinRequestId,     // 32 bytes for Consumed; null for Cancelled
  4: candidateMemberId  // 32 bytes for Consumed; null for Cancelled
}

// kind 2 Recovery; subjectId = member ID
{0: headRecordId, 1: recoveryCredentialId}

// kind 3 Key Epoch; subjectId = Vault ID
{0: headRecordId, 1: keyEpochId}

// kind 4 Administrator role; subjectId = member ID
{0: headRecordId, 1: administratorState} // false or true
```

Every candidate collection is a canonical set and contains every current head. Invitation receipt
and request IDs let a descendant Invitation Conflict Resolution select the exact checkpointed
choice, while `headRecordId` lets it resolve every candidate. Recovery descriptors and Epoch
summaries remain in their ordinary checkpoint arrays. Every named Record remains in the compact
Continuity Proof; the Baseline does not invent replacement authority causes.

An active fence entry is:

```text
{
  0: fenceKind, // registry owned by section 23
  1: subjectId,
  2: causeRecordIds
}
```

The Continuity Proof retains Genesis and every Authority or Lifecycle Event needed to authenticate
the current Baseline, including the typed dependencies needed to validate those Events. It may omit
ordinary Content parents even though their IDs remain signed into exact Event bytes. The successor
Generation boundary makes ended members, ended credentials, inactive Invitations,
superseded Recovery Credentials, resolved conflicts, and discharged Fences unable to authorize new
Events. Their transition history is not copied merely for compatibility or audit convenience.

# 27. Invariants

- Every Vault Member uses the same recovery class.
- Administrator authority never changes decryption class.
- Every Event body stores exact causes and targets, not duplicate reasons or statuses.
- Account and Host policy never enter Authority State.
- Key Epoch activation has an exact complete derived recipient set.
- Recovery and invitation conflicts preserve every authenticated candidate.
- No timestamp, Host receipt order, revision count, or identifier chooses authority.
- Closure is derived when no Administrator remains.

# References

- `docs/specifications/event/reducers.md`
- `docs/specifications/vault/vault.md`
- `docs/specifications/crypto/crypto.md`
