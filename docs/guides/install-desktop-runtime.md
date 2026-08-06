# Install the AWSM desktop Runtime

The desktop Runtime is the AWSM Client for Vault management. It stores and operates on its own
Vaults, opens a local management window, and exposes a loopback API that a paired browser
extension can use. It does not capture web pages yet. Page capture remains an extension feature
for extension-owned Vaults.

## Download and verify

Open the [latest AWSM Release](https://github.com/mashuproject/awsm_bak/releases/latest) and download
the desktop package for your platform together with its matching `.sha256` file:

- Linux x86_64: `awsm-desktop-linux-x86_64-v<version>.AppImage`.
- Windows x86_64: `awsm-desktop-windows-x86_64-v<version>-setup.exe`.
- macOS universal: `awsm-desktop-macos-universal-v<version>.dmg`.

The Linux package is the only desktop package natively started and smoke-tested for this release.
Windows and macOS packages are build-only and are not claimed to be tested. They are unsigned and
the macOS package is not notarized.

On Linux, verify the downloaded file before opening it:

```bash
sha256sum --check awsm-desktop-linux-x86_64-v<version>.AppImage.sha256
```

On macOS, verify the DMG with `shasum -a 256 -c` and its matching checksum file. On Windows, use
the platform's SHA-256 file verification tool and compare the result with the published checksum.

## Install

### Linux

Make the AppImage executable, then launch it:

```bash
chmod +x awsm-desktop-linux-x86_64-v<version>.AppImage
./awsm-desktop-linux-x86_64-v<version>.AppImage
```

The desktop window opens by default. The AppImage carries the Runtime's GTK/WebKit libraries; the
desktop environment still needs a working graphical session.

### Windows

Run the NSIS installer. The installer uses the standard WebView2 download strategy, so Windows may
download the WebView2 Runtime during installation. This package is unsigned and untested in this
release; review the publisher and checksum before running it.

### macOS

Open the DMG and move AWSM to Applications. This package is unsigned and not notarized. macOS may
show a Gatekeeper warning; only approve it after verifying the checksum and confirming that the
DMG came from the AWSM Release.

## Pair the browser extension

1. Install the AWSM browser extension using the [Chrome guide](install-chrome-extension.md) or
   [Firefox guide](install-firefox-extension.md).
2. Start the desktop Runtime and leave its window open.
3. In the extension, open the Runtime or Vault connection settings.
4. Select **Connect Desktop Runtime**.
5. Allow the loopback connection when the browser asks for permission.
6. Approve the pending pairing request in the desktop Runtime window.
7. Select a Vault. The extension now manages the desktop Runtime's Vault through its local API.

The pairing grant is local to this Runtime and browser installation. Revoking it in the desktop
Runtime stops that extension from using the API. The Runtime API remains on loopback and is not a
public web service.

## Start modes and data location

Packaged desktop builds start the Wails window by default. The Runtime still accepts these command
line options:

```text
--mode desktop   open the desktop window
--mode serve     run only the loopback HTTP API
--data-dir PATH  choose the PocketBase data directory
--listen ADDR    choose the API bind address (desktop mode requires the default loopback address)
```

The default data directory is the operating system's user configuration directory followed by
`awsm/runtime`. Use `--data-dir` when running a headless process or when you need an explicit backup
location. Do not put a Runtime data directory on a shared network filesystem unless the filesystem
provides the locking and durability guarantees you need.

The headless mode is intended for a trusted local service or a separately secured host adapter. It
does not make the Runtime a public server, and an HTTP reverse proxy does not add the missing Vault
semantics or authentication by itself.

## Current boundary

The desktop Runtime currently supports Vault management, authenticated Event/DAG replay and
cryptographic conformance, Library projection, pull synchronization, hydration, Storage Relief,
Garbage Collection, Hosted Replica operations, and single-Key-Epoch browser-compatible Complete
Export/Import with authenticated Streamable Artifact wrappers. The following remain outside this
release:

- page capture from the desktop window;
- the extension-to-desktop Capture Bundle bridge;
- multi-Key-Epoch, Feature Manifest, and adopted-Vacuum Complete Export closures;
- Bundle Descriptor, Note, and other dependency-bearing Content Fork re-authoring and broader Authority/Key-Epoch events;
- conflict/rebase and sparse-Replica projections; and
- complete Wails workflow coverage.

The desktop Runtime is therefore a Vault-management surface, not a second web host or a replacement
for the browser extension's page-capture surface.
