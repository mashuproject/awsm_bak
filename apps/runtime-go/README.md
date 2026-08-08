# Go Runtime

This module is the reference AWSM desktop/headless process boundary. The same
process serves a Wails desktop Client and a loopback HTTP API for paired API
Clients. The browser extension can select Vaults owned by this process without
copying their protected data into extension storage. Packaged desktop builds
are published with the browser extension in the [latest Release](https://github.com/mashuproject/awsm_bak/releases/latest).

For user installation, checksums, pairing, and platform limitations, read the
[desktop Runtime installation guide](../../docs/guides/install-desktop-runtime.md).

## Modes

The development command starts the loopback Runtime API:

```bash
go run ./cmd/awsm --mode serve --data-dir ./pb_data
```

The desktop development build uses the same executable and starts the Wails v2 shell. Build the
frontend from the repository root, then run the Wails command from its project directory:

```bash
corepack pnpm build:runtime:frontend
cd cmd/awsm
go run github.com/wailsapp/wails/v2/cmd/wails@v2.13.0 build -tags desktop,production,webkit2_41 -s -m -nosyncgomod -skipbindings -skipembedcreate
./build/bin/awsm-desktop --data-dir ../../pb_data
```

The Wails window embeds the React frontend from `cmd/awsm/frontend/dist`. The frontend uses the
shared `@awsm/ui` package and supports system, light, and dark appearance per Client Installation.
Inspect the shared primitives and states independently with `corepack pnpm ui:storybook`.

Packaged desktop builds default to the desktop window. A source build without the `desktop` build
tag defaults to the loopback API. `--mode serve` remains available for a headless process.

The HTTP API is fixed to `127.0.0.1:37373` unless `--listen` is supplied. The
desktop UI and browser-extension transport adapter target the AWSM routes under
`/api/awsm/runtime/`; PocketBase's generic Collections, dashboard, auth, and
file routes are not mounted.

The server mode is intended to sit behind a TLS reverse proxy when the opaque
Replica Host adapter is enabled. The current Host routes are fail-closed, so
keep the Runtime API on loopback and do not publish this scaffold as a public
network service.

## Boundaries

- `internal/grants` owns local API pairing and revocable Runtime API grants.
- `internal/store` maps AWSM state to a PocketBase Collection without leaking
  PocketBase models into domain code.
- `internal/artifactstore` streams already-encrypted wrappers atomically.
- `internal/securestore` defines the required operating-system secret boundary;
  its memory implementation is test-only.
- `internal/httpapi` exposes only AWSM routes and keeps Host grants separate
  from Runtime API grants.

The reserved `/api/awsm/host/` route group is fail-closed until the opaque Host
adapter supplies its own Channel Authenticator and Replica Access Grant
verification. A Runtime API bearer token never authorizes that surface.

The Go Runtime implements the canonical tagged Command contract for persistent Vault management:
creation and selection, Recovery Phrase confirmation/replacement and same-member recovery, state-only
Fork for the authenticated Library checkpoint and referenced Artifact/Bundle/Note object closure,
Closure, authenticated Membership and Administrator role changes, Client Credential ending, Key Envelope delivery, Feature Activation, and Administrator Key Epoch rotation, Vacuum adoption, Library projection, authenticated Event/Object replay,
Storage Relief, Garbage Collection, Hosted Replica creation and attachment, Compact materialization,
phrase-authenticated Hosted recovery into a Sparse Replica, receiver-initiated pull, and explicit
Artifact hydration. The Wails surface and loopback API also
expose the read-only `GetAuthorityState` projection derived from authenticated Authority and
Lifecycle Events, including active Invitation and Invitation conflict state. They use this same
Runtime; a paired extension reaches it under the single
`runtime.vault` grant.

Receiver pull keeps raw Key Envelopes in Quarantine until the local Client Credential can open the
recipient envelope and match its logical ID to an authenticated Authority slot. A Host locator or
outer-envelope digest alone never promotes a recipient-only Key Envelope.

The Wails Hosted Replica panel manages the local Remote binding: it can create or attach an
existing Host Replica, inspect opaque Replica candidates during attachment, rename, pause or
resume, materialize, pull, and retire a binding. Retirement is local metadata cleanup and does
not contact or delete the Hosted Replica.

The `internal/canonical` package provides strict canonical CBOR values, transcript framing,
authenticated Event and Baseline codecs, Record IDs, Object IDs, and causal DAG validation.
`internal/crypto` provides browser-compatible BIP39, Credential, Key Epoch, compact encryption,
HPKE, and Key Envelope services. `internal/storage` provides the opaque Compact/Streamable envelope
codec. Focused vectors are generated from the browser implementation, and Runtime integration tests
prove restartable authenticated replay, remote sync boundaries, and destination rewrapping.

The desktop window does not acquire pages; Capture remains an extension-only surface and the
extension-to-desktop Capture Bundle bridge is intentionally out of scope for this release. The
one-use move boundary now carries the authenticated opaque closure and trusted local secrets inside
its encrypted transfer envelope, so an accepted package reopens the Replica on the destination.
The Runtime command boundary also produces and accepts the browser-compatible Complete Export
container for authenticated multi-Key-Epoch and adopted-Vacuum closures, including Feature
Manifest and Streamable Artifact wrappers. Imported Replicas are readable but have no selected
authoring Credential or private key. The Runtime command boundary implements Membership and
Administrator role changes, Invitation creation/Acceptance recording/cancellation/conflict
resolution, Client Credential ending, Key Envelope delivery, Feature Activation, Administrator
rotation, and same-Vault Event Re-authoring for eligible stale Bundle Registered Capture Events.
The external Redemption Authority and joining Client exchange the Join Request and receipts outside
the Runtime; `AcceptInvitation` commits their exact result. Conflict/rebase authoring and remaining
cross-surface journeys are unresolved. Runtime
projections expose Complete, Sparse, and Unavailable Replica state; on-demand hydration remains
the user action for Sparse content.

The move boundary is deliberately separate from Vault synchronization. A source Client seals the
canonical opaque closure and trusted local secrets with a one-use secret, stages it in the desktop
process, and verifies the returned digest and byte length. The destination UI must explicitly accept
the staged package before the source retires its Vault; the transfer is never a Vault Event. The Go
path is complete for Go-to-Go closures. Direct browser Complete Export stream/container
export/import is implemented for the currently supported closure and fails closed for unsupported
historical or feature-rich closures.

## Process and browser proofs

The standalone process smoke test binds the server to an ephemeral loopback port,
writes an atomic ready file, serves the health route, and removes the ready file
on shutdown:

```bash
corepack pnpm test:runtime:smoke
```

The browser proof starts the real Runtime fixture on the canonical `37373` loopback
port. It pairs the Chrome or Firefox extension through the real HTTP transport,
approves the pending request through the trusted control seam, verifies encrypted
installation grant state, and revokes the grant. The Wails management panel has a
separate Playwright bridge proof because native Wails bindings are not exposed to a
headless browser:

```bash
corepack pnpm test:e2e:desktop-runtime
corepack pnpm test:e2e:desktop-runtime:firefox
```

Native Wails startup is a separate local smoke lane and requires GTK 3, WebKitGTK
4, and `xvfb-run` on Linux:

```bash
corepack pnpm test:runtime:wails
```

The release packaging lane builds a Linux AppImage, a Windows x86_64 NSIS installer, and a
universal macOS DMG. Only the Linux package is natively started and smoke-tested; Windows and
macOS are explicitly build-only for the current release. The AppImage helper and packaged smoke
test are `script/package-linux-appimage.sh` and `script/packaged-desktop-smoke.mjs`.

These proofs cover the process boundary, Runtime API grant lifecycle, canonical Vault Command
envelope, authenticated replay, Hosted Replica sync boundaries, Library Storage Relief and
hydration, and encrypted transfer staging. They do not claim desktop page Capture, the
extension-to-desktop Capture Bundle bridge, unresolved Authority authoring families, or user-facing
search/AI semantics.
