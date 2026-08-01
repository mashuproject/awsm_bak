# Trust and Credential Management

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/04-security-model.md`
- `docs/specifications/vault/authority.md`

# Purpose

AWSM models portable authorship with Client Credentials rather than physical Devices. Credentials
belong to one member in one Vault; a Client Installation may manage several of them.

# Credential classes

- **Client Credential:** Ed25519 authoring key plus X25519 Key Epoch delivery key. It signs every
  ordinary Event for its member.
- **Recovery Credential:** phrase-derived signing and wrapping keys. It enrolls a fresh Client
  Credential when ordinary authoring keys are unavailable.
- **Channel Authenticator:** Host-local password, bearer token, SSH key, or similar access method.
  It never authors a Vault Event.

# Enrollment

Genesis creates the first member, Administrator, Client Credential, Recovery Credential, and Key
Epoch. A current member may enroll another own Client Credential through an existing active Client
Credential. Recovery can independently enroll one after complete Frontier, Continuity Proof, and
authority verification. Another existing Client need not approve.

An Invitation carries capabilities and a one-use bearer secret. A candidate presents a fresh
member identity, Client Credential, Recovery Credential, and proof of possession through a live
connection between Replicas. Acceptance is a signed Authority Event. Invitations do not expire by
untrusted time. A holder of the separate Cancellation Capability, or an independently delegated
Host-local management path, can cancel one; Administrator status alone cannot.

# Ending authority

A member can retire an own Credential without stopping other members. An Administrator can revoke
another member's Credential, which may require a new Key Epoch before protected writes continue.
Credential end does not erase prior signatures or copies.

Member resignation takes effect immediately in portable authority. Other members may keep working
until an Administrator performs any required Future Protection transition. The resigned Runtime
rejects new contributing Commands and presents former-member Historical Access. It may keep pulling
and displaying obtainable old-Epoch Records, but warns that delivery may stop at any time and offers
Fork or Export for independent retention.

# Recovery replacement and conflict

Recovery Phrase replacement creates a fresh Recovery Credential and invalidates the old one for
future authority. Concurrent replacements preserve all candidates as a Recovery Conflict. A phrase
matching an effective candidate may recover, but resolving the conflict requires a descendant that
observes every head. No revision number or timestamp chooses automatically.

# Key delivery

Independent Key Epoch Keys are HPKE-wrapped to every eligible Client and Recovery Credential. A
transition's recipient set is derived exactly from its post-transition authority state. Missing or
extra envelope slots are invalid.

# User interface

Management surfaces show member identity, Administrator role, Client Credential labels and status,
Recovery Phrase safety, invitations, and security consequences. Host Account and session/device
views are clearly separate because they control Channel access rather than Vault authority.

# References

- `docs/specifications/crypto/crypto.md`
- `docs/specifications/vault/replica.md`
- `docs/architecture/15-coordination-server.md`
