# Client Runtime Specification

**Document:** `docs/specifications/runtime/runtime.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/event/commands.md`
- `docs/specifications/runtime/storage.md`
- `docs/specifications/vault/authority.md`
- `docs/specifications/vault/replica.md`

# 1. Purpose

The Runtime is the trusted execution boundary inside a Client Installation. It owns plaintext,
private keys, Event authoring, validation, replay, Commands, Jobs, projections, and adapters. A
Replica Host that only stores opaque bytes is outside this trust boundary.

# 2. Installation composition

One Client Installation may manage zero or more Vault Replicas and zero or more Client Credentials
per Vault, including separate Vault contexts in one browser profile. Browser, desktop, mobile,
headless, and API-driven clients use the same semantic contracts.

An installation may additionally expose one or more Replicas as a Host. Client and Host are
composable capabilities, not mutually exclusive product types. A thin Client may operate without
hosting, and an opaque Host may operate without Vault keys.

The reference Go process may run as a desktop Client or as a headless/server installation. Desktop
mode serves one loopback Runtime API for its Wails UI and paired API Clients. A paired API Client
receives a local API Grant that limits Runtime operations; it never creates portable membership.
Headless network mode may expose the opaque Replica Host protocol, but it does not expose a public
plaintext Runtime API by default.

The browser extension requests loopback permission from the explicit Connect action, then sends a
pairing request over `http://127.0.0.1:37373`. The Wails management surface approves pending requests
and revokes grants. The persisted grant token is installation-wrapped Trusted Secret state and is
never rendered in the extension or management summary. The Go process implements the same tagged
Command names as the extension for persistent Vault management and authenticated synchronization.
Its desktop window deliberately does not acquire pages. Extension page capture
continues for extension-owned local Vaults, while the extension-to-desktop Capture Bundle bridge is
not implemented. The Go `internal/canonical` package provides strict canonical CBOR values,
transcript framing, authenticated Event/Baseline codecs, Record IDs, and causal DAG primitives.
The Go Runtime now provides browser-compatible BIP39, Credential, Key Epoch, compact-encryption,
HPKE, Key Envelope, opaque Compact/Streamable envelopes, authenticated Event/DAG replay, Library
projection, state-only Fork checkpointing, Membership and Administrator role changes, Client Credential ending, Key Envelope delivery, Feature Activation, Storage Relief, Garbage Collection, Hosted Replica
creation/attachment/materialization, phrase-authenticated Hosted recovery into an authoring-capable
Sparse Replica, receiver pull, Artifact hydration, the read-only
`GetAuthorityState` projection (including Invitation state), and encrypted Go-to-Go
transfer import/export. Focused tests use browser-derived vectors and restart/Host-boundary proofs.
The Go Runtime also exposes browser-compatible Complete Export/Import for authenticated
multi-Key-Epoch and adopted-Vacuum closures, including Feature Manifest and Streamable Artifact
wrappers. Complete Import remains authoring-free. The Go Runtime implements Membership and
Administrator role changes, Invitation creation and Acceptance recording, cancellation, Client
Credential ending, Key Envelope delivery, Feature Activation, Administrator rotation, Invitation
conflict resolution, authenticated Collection, Folder, Capture, Tag, and Note Content authoring
with scoped conflict resolution, and same-Vault Event Re-authoring for eligible stale Bundle
Registered Capture Events. The external Redemption Authority and joining Client exchange the Join
Request and receipts outside the Runtime; `AcceptInvitation` is the authenticated servicing-Client
boundary that commits their exact result. The extension-to-desktop Capture Bundle bridge remains
out of scope.
Runtime projections expose Complete, Sparse, and Unavailable Replica state, with on-demand
hydration as the Sparse action. Capture remains extension-only, and Fork itself copies
authenticated state into a fresh Initial Baseline without re-authoring source Content Events.
Unsupported desktop page Capture remains intentional.

## 2.1 Desktop Command and move boundary

The paired extension uses `POST /api/awsm/runtime/command` with a bearer Grant scoped to
`runtime.vault`. The JSON request is one member of `CanonicalApplicationRequest`, including the
same Vault-management names used by the browser Runtime. Successful responses are
`{"ok":true,"value":...}`. A Runtime Command failure is an application result with
`{"ok":false,"error":{"id":...,"message":...}}`; transport and authorization failures remain
HTTP failures. The Wails UI calls the same Runtime boundary in-process rather than inventing a
second Vault model.

The extension may merge local and desktop-owned Vault summaries for selection. A selected Vault ID
chooses exactly one backend for later Commands; the router never copies protected Vault bytes into
the other backend. A shared Vault ID across the two backends is rejected as an identity collision.

Moving a Vault is separate from synchronization. The source Client creates a one-use transfer with
`POST /api/awsm/runtime/transfers`, seals its transfer package using an `AWSMTR1` XChaCha20-
Poly1305 envelope, and stages it with `PUT /api/awsm/runtime/transfers/{id}` and the secret in the
`Awsm-Transfer-Secret` header. The desktop verifies the envelope and stores the authenticated
package as a transfer artifact. Wails management lists staged moves and explicitly accepts or
rejects them. Acceptance imports the package before the source may run its separate retirement
action. Transfer artifacts are not Vault Events, are not synchronized, and are not included in
ordinary Vault Export or Backup.

# 3. Vault selection and opening

The Runtime has one explicit selected Vault context per user-facing session. Selecting another
Vault makes its local Credential and key material available through the ordinary open flow and
clears prior plaintext state. The interface may display an internal sealed state, but routine use
speaks in terms of selecting or opening a Vault rather than repeatedly demanding an `unlock`
ceremony.

Private keys remain protected at rest by platform facilities and installation wrapping. The
Runtime keeps decrypted key material only while required and never persists a plaintext Key Epoch
Key or Recovery Phrase.

A Replica may be readable without any local Client Credential, including immediately after
Complete Import. Its directory selection and Replica Safety State carry no invented Credential or
member identity. Opening still authenticates the Vault and makes package-carried Key Epoch keys
available for reading, but the Runtime exposes no authoring capability until ordinary Recovery or
Invitation enrollment installs an accepted Client Credential.

# 4. Event authoring and validation

Only an active Client Credential authors Vault Events on behalf of a member. The Runtime derives
authority from the exact Authority Frontier, prepares dependencies, signs canonical bytes, and
commits against causal- and Authority-Frontier compare-and-swap. It fully validates imported or
synchronized input in Quarantine before promotion.

Absence of a local authoring Credential is an ordinary readable state, not a synthetic member or
Credential. Authoring Commands fail before preparing authoritative bytes while historical views,
authenticated content, and synchronization remain available within the accepted authority and
feature boundary.

Unsupported Required Features stop semantic processing at the last fully understood Frontier.
Exact outer bytes may be retained in Quarantine, but the Runtime does not author descendants,
Vacuum, render, or collect unknown authoritative state.

Feature Activation advances the current Required Feature Set through an authenticated type-14
Authority Event and stores each complete Feature Manifest as a typed dependency. The persisted
Replica state keeps the Baseline/Genesis Required Feature Set identity separate from the current
set, so later Feature Activation does not rewrite the authenticated Initial Baseline or Genesis.

## 4.1 Joining a locally known Vault

Ordinary Invitation Acceptance always creates a fresh member, Client Credential, and Recovery
Credential. It never revives ended authority. If the Installation already retains the invited
Vault ID, the Runtime classifies a Vault Identity Collision before activation:

- an ancestor in the same Generation may fast-forward after complete validation and key delivery;
- a valid successor Generation follows ordinary Vacuum Adoption and preservation rules; and
- divergent or unpublished work requires eligible Capture recovery, Fork, Complete Export, or
  postponement.

The Runtime retires a historical local context only after accounting for every retained Record and
unpublished result. It never overwrites that work or creates two active entries for one Vault ID.

# 5. Services

The Runtime provides:

- Vault creation, selection, recovery, Fork, Closure, Vacuum, Export, and Import;
- Capture acquisition and Bundle construction;
- Authority, membership, invitation, Credential, and Key Epoch ceremonies;
- Event replay and deterministic projections;
- search and other replaceable Materializations;
- pull synchronization, hydration, Storage Relief, and Garbage Collection;
- durable Job execution, cancellation, retry, and crash recovery; and
- capability-scoped adapters and extensions.

# 6. Transactions and Jobs

One logical operation declares its authoritative writes, Replica Safety State, Prepared Data,
Execution State, and Materialization effects. A single physical transaction is preferred. When
large-byte or remote systems cannot join it, a durable Job uses prepared immutable output,
idempotent promotion, verified checkpoints, and resumable cleanup. No partial result becomes Vault
authority.

# 7. Security boundary

Untrusted page content, imports, synchronized bytes, model output, Host responses, and extension
messages enter through bounded parsers and capability checks. Rendering preserved content is inert
by default. Network access, external navigation, clipboard, downloads, and host calls require an
explicit owning action.

# 8. Observability

Logs and metrics exclude plaintext content, Recovery Phrases, private keys, key material, session
secrets, opaque inventories, and identifiers unless a narrowly scoped diagnostic explicitly needs
a pseudonymous value. Observability never becomes Vault authority.

# 9. Invariants

- A Runtime may manage many Vaults without combining their keys or authority.
- A physical device is not a portable authority identity.
- No Host response substitutes for cryptographic validation.
- Derived state can be discarded and rebuilt.
- Unsupported authority fails closed; ordinary availability failure remains recoverable.

# References

- `docs/specifications/runtime/desktop-command.md`
- `docs/specifications/runtime/jobs.md`
- `docs/specifications/runtime/synchronization.md`
- `docs/specifications/runtime/capture.md`
