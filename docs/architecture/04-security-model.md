# Security Model

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/03-zero-knowledge.md`
- `docs/architecture/18-cryptography.md`

# Goals

AWSM protects Vault confidentiality and integrity from opaque Hosts, network attackers, malformed
imports, and unauthorized authors while retaining useful offline operation. It cannot retract data
or keys already possessed by an authorized or compromised member.

# Trust principals

- A Vault Member is portable authority and receives the same cryptographic access class as every
  other member.
- A Vault Administrator independently governs invitations, removal, role changes, security
  transitions, Vacuum, and Closure. No quorum is implied.
- A Client Credential signs Events for one member. It is the immediate portable author.
- A Recovery Credential derives from that member's Recovery Phrase and can enroll a replacement
  Client Credential without another online client.
- A Channel Principal and Replica Access Grant authorize one Host interface only.

# Key model

AWSM has no Vault Root Key. Each Key Epoch has an independent random symmetric key. Content and
outer-item keys are domain-separated from the applicable Epoch Key. HPKE envelopes deliver each
Epoch Key to every eligible Client and Recovery Credential.

The Recovery Phrase is 12-word English BIP39 for 128 bits of fresh client entropy. Possession is
possession of that member's recovery authority and must be treated like a sensitive private key.

# Revocation and future protection

Membership or Credential end is an immutable Authority Event. It cannot make already obtained
plaintext, keys, Replicas, exports, or Forks disappear. Administrator removal and adversarial
Credential revocation create a narrow protected-write fence until a new Key Epoch excludes the
target. Self-resignation and voluntary own-Credential retirement do not globally stop other
members from capturing.

A resigned member loses portable authority and any promise of later Events or keys but may retain a
readable historical Replica. Obtainable old-Epoch updates may remain decryptable on a best-effort
basis until an excluding transition. Joining again uses a new Invitation and fresh member identity;
it never revives old authority.

# Conflicts and hostile behavior

All Vault Events are signed and hash-linked. Timestamps are audit assertions, not authorization or
ordering authority. Equivocation and incompatible authority heads are retained, surfaced, and
scoped. Deterministic rules resolve only classes where automatic composition is safe; security-
sensitive conflicts require explicit authorized resolution.

# Threat limitations

The model does not prevent an authorized member from copying plaintext, an Administrator from
using their disclosed independent powers, a compromised Client from acting with its keys, a Host
from withholding opaque items, or loss of the final surviving wrapper. Cryptography detects
mutation but does not guarantee availability or good judgment.

# Invariants

- Account passwords never derive Vault keys.
- Administrator status never grants another member's Recovery Phrase or private key.
- A Host cannot author a Vault Event.
- Unknown Required Features fail closed.
- Destructive rewrites require precise consequences and verified source closure.

# References

- `docs/specifications/vault/authority.md`
- `docs/specifications/crypto/crypto.md`
- `docs/architecture/19-testing-strategy.md`
