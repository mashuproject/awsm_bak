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

The desktop development build uses the same executable and starts the Wails v2 shell. Run it from
the Wails project directory:

```bash
cd cmd/awsm
go run github.com/wailsapp/wails/v2/cmd/wails@v2.13.0 build -tags desktop,production,webkit2_41 -s -m -nosyncgomod -skipbindings -skipembedcreate
./build/bin/awsm-desktop --data-dir ../../pb_data
```

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

The current Go Runtime implements a persistent Vault-management slice behind the
canonical tagged Command contract: Vault creation and selection, Recovery Phrase
confirmation and replacement, same-member recovery, Fork, Closure, Vacuum, and
Hosted Replica metadata configuration. The Wails surface presents those operations and
the loopback API exposes them to the paired extension under the single
`runtime.vault` grant.

Hosted Replica attachment, materialization, and synchronization commands fail closed
until the Go Runtime has the authenticated Host and Event/DAG services they require.

This slice does not claim full semantic parity with the browser Runtime. The Go
implementation still needs the authenticated Event/DAG and cryptographic
services, authoritative Record/Object replay, Capture and Library projections,
pull synchronization, hydration, Storage Relief, and complete Export/Import.
Capture is intentionally unavailable in the desktop window for this release;
extension page acquisition remains available for extension-owned local Vaults, but
the extension-to-desktop Capture Bundle bridge is not implemented. Remaining work is tracked in
`ROADMAP.md` and owned by the living Runtime specifications.

The move boundary is deliberately separate from Vault synchronization. A source
Client seals a transfer package with a one-use secret, stages it in the desktop
process, and verifies the returned digest and byte length. The destination UI
must explicitly accept the staged package before the source retires its Vault;
the transfer is never a Vault Event. The current acceptance path understands the
Go Runtime's internal transfer snapshot; wiring the browser Complete Export
format and sealed local credential into this ceremony remains semantic parity
work, so this boundary is not advertised as a complete cross-runtime move yet.

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

These proofs cover the process boundary, Runtime API grant lifecycle, canonical
Vault Command envelope, and transfer staging. They do not claim that the Go
process yet implements Vault Capture, authenticated replay, search,
synchronization, hydration, or Storage Relief semantics.
