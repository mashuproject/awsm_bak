# Deployment and Operations Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/15-coordination-server.md`
- `docs/architecture/19-testing-strategy.md`

# Purpose

AWSM deploys Clients and optional Replica Hosts independently. Core architecture remains provider-
neutral; concrete reference infrastructure is an adapter and never an application default.

# Client releases

Browser packages are reproducible from an immutable tagged source revision, validate manifests and
bundled code, and receive real-browser proof before publication. Desktop, mobile, and headless
Clients must prove the same codec, cryptographic, storage, and synchronization vectors. Required
Feature support is declared by implementation, not inferred from package version.

The reference Client process is one Go executable with desktop and headless launch modes. Desktop
mode uses a Wails shell and a loopback Runtime API. Its current Vault-management slice uses the
same tagged Command boundary as the browser Client; extension page capture remains available for
extension-owned local Vaults, while desktop-owned Capture Bundles are not bridged yet. Full Go
Event/DAG, cryptographic, synchronization, hydration, and Export/Import semantics converge.
Headless mode is reserved for a deployment-selected listener for the opaque Replica Host protocol
once its Host adapter is enabled; network TLS and ingress are deployment responsibilities. Both
modes use the same Runtime, the PocketBase Collection adapter, the streaming encrypted Artifact
Driver, and the conformance vectors. PocketBase's generic dashboard, record API, authentication,
and file API are not deployed surfaces.

The process adapter's standalone smoke lane uses an atomic ready file and an ephemeral loopback
port; the browser transport uses the canonical desktop port `127.0.0.1:37373`. Native Wails startup
is verified under Xvfb where GTK/WebKitGTK are installed. The Wails management panel and browser
extension use the same loopback API, while the extension's installation-wrapped grant and the
management summaries keep bearer tokens out of UI and logs.

# Replica Host service

A reference Host deploys an HTTP application, relational Host Policy State, optional ephemeral
coordination, and opaque byte storage. Health proves process liveness; readiness proves required
database and storage dependencies. Neither endpoint decrypts or semantically validates a Vault.

Database transactions protect Accounts, sessions, Grants, quotas, item promotion, hint cursors, and
reaping. Backups and restoration of Host Policy State and opaque bytes are operational concerns and
must preserve their referential integrity without treating the Host as the only Vault copy.

# Public and private web surfaces

Static landing, privacy, security, and glossary pages can be publicly cached. Account signup,
login, dashboard, sessions, Hosted Replica management, API, and authenticated status are private
and `no-store`. Public responses cannot vary secretly on Account state. The canonical glossary page
renders a small, source-checked set of canonical terms with plain-language summaries. The full
tracked glossary remains the source of the exact technical definitions.

# Privacy and observability

Logs exclude passwords, session and bearer tokens, transfer capabilities, Recovery Phrases, key
material, opaque inventories, item bytes, and protected identifiers. Metrics aggregate operational
counts without semantic labels. Support request IDs are Host-local and disclose no cross-Account
existence.

# Deployment change discipline

Schema, API, storage, and cryptographic changes deploy as one canonical pre-release design with
destructive development and authorized staging resets where required. No compatibility reader,
dual write, old client negotiation, or staging-data translation is added. Production changes,
shared ingress changes, remote purge, and destructive environment operations remain separately
authorized operational acts.

# Verification

Each deployment records exact source revision and artifact digest, runs migrations or destructive
schema establishment, checks health/readiness, exercises black-box Account and opaque item flows,
and compares public pages with intended source. A successful CI job, deployment command, or CDN API
response alone is not proof of served behavior.

# Current reference status

The repository Rails Host has converged on the opaque schema and executable transport foundation;
the Go process provides the reference desktop/headless process, persistence, API, and
artifact-driver boundary plus a partial Vault-management service set. This repository state proves
nothing about a named deployment. Reference staging and production facts must be freshly inspected
before every operational claim or mutation.

# References

- `docs/specifications/protocol/protocol.md`
- `docs/specifications/runtime/storage.md`
- `docs/architecture/03-zero-knowledge.md`
