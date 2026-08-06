# Client Runtime Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/01-system-overview.md`
- `docs/architecture/04-security-model.md`

# Purpose

The Client Runtime is the trusted, user-interface-independent execution environment for Vault
plaintext and authority. Browser extension, desktop, mobile, headless HTTP, and future thin-client
surfaces provide adapters around the same semantic responsibilities.

# Modules

```text
surface and platform adapters
             |
trusted Runtime
  Command and authority validation
  Capture and Bundle construction
  cryptography and secure key access
  Record/Object validation and replay
  projection, search, and optional AI
  pull synchronization and hydration
  import, export, Fork, Vacuum, and GC
             |
Storage Drivers and optional Channels
```

The Runtime owns business semantics. Adapters provide tabs, files, screenshots, secure storage,
network connections, notifications, and presentation without independently authoring Events.

# Multiple Vaults and Credentials

One installation may manage several Vault Replicas and several Client Credentials, including
different members or Vaults in one browser profile. Selecting a Vault is the ordinary way to make
its protected context available. Switching clears prior plaintext and never creates a Vault Event.

# Local-first execution

Commands validate against exact accepted causal and Authority Frontiers. Valid local work commits
without a Remote. Synchronization later pulls and validates immutable items. When a security fence
prevents valid Event authoring, Capture may finish into explicit Prepared Data for later safe
handling rather than blocking acquisition or pretending it is committed.

# Extension and API boundary

First-party and extension code submits capability-scoped Commands. A headless installation may
offer an HTTP API for operating its local Replica; API credentials authorize that Client surface,
not portable Vault membership. The selected Client Credential still signs every resulting Event.

# Reference process adapter

The reference desktop/headless Runtime process is `apps/runtime-go`. One executable provides a
Wails desktop shell and a headless/server mode around the same trusted Runtime boundary. Its
default desktop transport is one loopback HTTP Runtime API available to the Wails UI and a paired
browser extension transport adapter. The extension is an API Client and does not become a Vault
Member merely by using that API. Pairing issues a local revocable API Grant that remains valid
until explicit revocation.

The current process implements the canonical tagged Command contract for persistent Vault management,
authenticated Event/Object replay, Library projection, Storage Relief, Garbage Collection, Hosted
Replica creation/attachment/materialization, receiver pull, Artifact hydration, and encrypted
Go-to-Go transfer import/export. It also exposes browser-compatible Complete Export/Import for the
supported single-Key-Epoch closure, including authenticated Feature Manifest and Streamable Artifact
closures; Complete Import creates a readable Replica without a local authoring Credential. The
extension's backend router merges local and desktop Vault
summaries, then routes Commands by Vault ID; it does not copy desktop Vault bytes into the browser.
Desktop page acquisition is intentionally unavailable. Capture remains available for extension-owned
local Vaults; the extension-to-desktop Capture Bundle bridge is not implemented. Multi-Key-Epoch and
adopted-Vacuum Complete Export semantics, remaining organization and other
dependency-bearing Content Fork re-authoring, broader Authority and Key-Epoch event families,
conflict/rebase projections, and the remaining Wails workflow coverage beyond the current
Vault-management controls and cross-surface journeys remain explicit parity boundaries.
The Go Runtime re-authors Note Content Objects and Note Created/Revised/Deleted/Restored/Conflict
Resolution Events with fresh destination identities and authenticated object/cause dependencies.

The move boundary is an explicit one-use transfer ceremony, not synchronization. The source
Client seals a transfer package with the transfer secret, the desktop process authenticates and
stages it, and the user must accept the staged package before a separate source-retirement action.
The staged payload is not a Vault Event and is not included in Vault synchronization.

The process may also expose the Replica Host role, but Host Accounts, Channel Principals, and
Replica Access Grants remain separate from Runtime API Grants. PocketBase is a replaceable local
Collection and schema adapter for AWSM-owned state; its generic Collections API, dashboard,
built-in authentication, and file routes are not part of the AWSM surface. Large Artifact wrappers
remain behind an AWSM streaming Storage Driver and are stored only as already-encrypted bytes.
Once its Host adapter is enabled, headless network deployment exposes the opaque Replica Host
protocol through deployment-managed TLS. The current reserved Host routes are fail-closed, and
the plaintext Runtime API remains a loopback surface.

The extension's explicit Desktop Runtime mode requests loopback permission from its Connect click,
creates a one-use local pairing with the `runtime.vault` scope, waits for trusted desktop approval,
and stores the resulting grant only as installation-wrapped state. Disconnect deletes that local
grant; a later health or grant check that receives revocation clears the state and reports the
consequence without exposing the bearer token. The transfer endpoints use the same scope and an
`AWSMTR1` XChaCha20-Poly1305 envelope with the secret in the `Awsm-Transfer-Secret` header. The
process proofs cover this transport, authorization, and staging boundary; they do not substitute
for the formal semantic Vault vectors.

# State boundaries

The Runtime uses the eleven logical storage families in the storage specification. It keeps
Replica Safety State distinct from preferences, Quarantine distinct from trusted Prepared Data,
and Materializations disposable. Durable Jobs bridge operations that span databases, wrapper
stores, and Channels.

# Invariants

- Platform adapters do not own Vault semantics.
- One installation can be both Client and Replica Host.
- No routine workflow requires a particular coordination service.
- Plaintext and secrets stay inside the trusted Runtime by default.
- Every accepted remote byte passes the same validation as an import.

# References

- `docs/specifications/runtime/runtime.md`
- `docs/specifications/runtime/desktop-command.md`
- `docs/specifications/runtime/storage.md`
- `docs/architecture/17-extension-framework.md`
