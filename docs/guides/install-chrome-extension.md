# Install the Chrome Extension

## Before You Install

AWSM is pre-release software. It is not available from the Chrome Web Store and does not update
automatically. Installation requires Chrome 116 or newer. While the AWSM repository is private, you
also need access to it on GitHub to download a Release.

Install and use AWSM in a normal Chrome profile. Incognito is not supported; do not enable
**Allow in Incognito** for the extension.

Vault content and browser-local state remain on your device unless you configure encrypted
synchronization with a compatible Coordination Server. The server receives opaque encrypted data,
not plaintext Vault content.

## Download a Release

1. Open the applicable [AWSM GitHub Release](https://github.com/mashuproject/awsm_bak/releases).
2. In **Assets**, download the matching `.zip` and `.zip.sha256` files. For example, download both
   `awsm-chrome-v0.1.0.zip` and `awsm-chrome-v0.1.0.zip.sha256` for version 0.1.0.

Do not download GitHub's automatically generated **Source code** archives. They contain repository
source, not the built Chrome extension.

## Verify the Checksum

Keep the ZIP and checksum file in the same directory. Use the command for your operating system,
replacing `<checksumName>` with the downloaded checksum filename.

### Linux

```bash
sha256sum --check <checksumName>
```

For version 0.1.0:

```bash
sha256sum --check awsm-chrome-v0.1.0.zip.sha256
```

### macOS

```bash
shasum -a 256 -c <checksumName>
```

For version 0.1.0:

```bash
shasum -a 256 -c awsm-chrome-v0.1.0.zip.sha256
```

### Windows PowerShell

```powershell
$checksumName = "awsm-chrome-v0.1.0.zip.sha256"
$archiveName = "awsm-chrome-v0.1.0.zip"
$expected = (Get-Content $checksumName -Raw).Trim().Split()[0]
$actual = (Get-FileHash $archiveName -Algorithm SHA256).Hash
if (-not $actual.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Checksum mismatch"
}
```

A successful Linux or macOS check reports `OK`; the PowerShell command returns without an error.
If verification fails, stop and delete both downloaded files. Download them again from the Release;
never install an archive whose checksum does not match.

## Extract and Load in Chrome

1. Extract the verified ZIP into a permanent directory owned by your user account.
2. Confirm that `manifest.json` is directly inside that directory, not inside another nested folder.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode**.
5. Select **Load unpacked**.
6. Choose the extracted directory containing `manifest.json`.
7. Optionally pin AWSM from Chrome's Extensions menu.

Keep the directory in place. Chrome loads the extension from that path rather than copying it into
Chrome-managed storage.

## First Launch

Open AWSM from its toolbar icon. Choose a compatible self-hosted Coordination Server if you want
synchronization while keeping Vault content end-to-end encrypted, or continue without
synchronization. AWSM does not currently advertise a hosted service.

## Upgrade Safely

1. Create an encrypted Complete Export before replacing the installed extension files.
2. Download and verify the new Release, then extract it into a separate temporary directory.
3. Preserve the original permanent installation path. Changing the path may create a different
   extension identity with separate browser storage.
4. Replace the contents of the original installation directory with the newly extracted contents.
5. Confirm that `manifest.json` remains at the root of that directory.
6. Open `chrome://extensions` and select **Reload** on AWSM.

AWSM is pre-release software. Do not assume that downgrades or data created by a different
pre-release version are compatible.

## Troubleshooting

- **Checksum mismatch:** Delete both assets and download them again. Do not bypass verification.
- **Chrome reports a missing manifest:** Select the extracted directory that directly contains
  `manifest.json`, not its parent.
- **The package contains no root manifest:** Confirm that you downloaded the named AWSM ZIP asset,
  not a GitHub **Source code** archive.
- **Chrome shows a developer-mode warning:** This is expected for an unpacked extension that is not
  installed from the Chrome Web Store.
- **AWSM does not work correctly in Incognito:** Incognito is not supported. Disable **Allow in
  Incognito** on `chrome://extensions` and use AWSM in a normal Chrome profile.
- **The extension became disabled:** Restore the permanent installation directory if its files were
  moved or deleted, then reload AWSM from `chrome://extensions`.
- **AWSM appears as a separate installation:** Loading from a different path can produce a different
  extension identity and separate browser storage. Return to the original path when possible.
- **A newer Release did not install automatically:** Updates are manual. Follow the upgrade steps
  for each new Release.

## Build From Source

Install Node.js 22 and enable Corepack. From the repository root, run:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

In `chrome://extensions`, select **Load unpacked** and choose:

```text
apps/browser-extension/.output/chrome-mv3
```

To create a local distributable ZIP when needed, run:

```bash
corepack pnpm zip
```
