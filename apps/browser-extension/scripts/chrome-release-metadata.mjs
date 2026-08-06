import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function releaseMetadata({ version, eventName, refName, repository }) {
  const versionMatch = VERSION_PATTERN.exec(version);
  if (!versionMatch) {
    throw new Error("invalid version: expected SemVer without build metadata");
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("invalid repository: expected owner/name");
  }
  if (eventName !== "push" && eventName !== "workflow_dispatch") {
    throw new Error(`unsupported event: ${eventName}`);
  }

  const tag = `v${version}`;
  if (eventName === "push" && refName !== tag) {
    throw new Error(`tag mismatch: expected ${tag}`);
  }

  return {
    version,
    tag,
    prerelease: versionMatch[4] !== undefined,
    archiveName: `awsm-chrome-v${version}.zip`,
    checksumName: `awsm-chrome-v${version}.zip.sha256`,
    firefoxXpiName: `awsm-firefox-v${version}.xpi`,
    firefoxChecksumName: `awsm-firefox-v${version}.xpi.sha256`,
    firefoxSourceName: `awsm-firefox-source-v${version}.zip`,
    desktopLinuxName: `awsm-desktop-linux-x86_64-v${version}.AppImage`,
    desktopLinuxChecksumName: `awsm-desktop-linux-x86_64-v${version}.AppImage.sha256`,
    desktopWindowsName: `awsm-desktop-windows-x86_64-v${version}-setup.exe`,
    desktopWindowsChecksumName: `awsm-desktop-windows-x86_64-v${version}-setup.exe.sha256`,
    desktopMacosName: `awsm-desktop-macos-universal-v${version}.dmg`,
    desktopMacosChecksumName: `awsm-desktop-macos-universal-v${version}.dmg.sha256`,
    guideUrl: `https://github.com/${repository}/blob/${tag}/docs/guides/install-chrome-extension.md`,
    firefoxGuideUrl: `https://github.com/${repository}/blob/${tag}/docs/guides/install-firefox-extension.md`,
    desktopGuideUrl: `https://github.com/${repository}/blob/${tag}/docs/guides/install-desktop-runtime.md`,
  };
}

export function renderDesktopReleaseNotes(metadata) {
  return `## Install the desktop Runtime

### Linux x86_64

1. Download \`${metadata.desktopLinuxName}\` and \`${metadata.desktopLinuxChecksumName}\`.
2. Verify the AppImage against its SHA-256 checksum.
3. Make the AppImage executable and launch it. The desktop window opens by default.

### Windows x86_64 (build-only, untested)

1. Download \`${metadata.desktopWindowsName}\` and \`${metadata.desktopWindowsChecksumName}\`.
2. Verify the installer against its SHA-256 checksum.
3. Run the installer. Windows WebView2 is required; the installer uses its standard download strategy.

### macOS universal (build-only, untested)

1. Download \`${metadata.desktopMacosName}\` and \`${metadata.desktopMacosChecksumName}\`.
2. Verify the disk image against its SHA-256 checksum.
3. Open the disk image and launch AWSM. macOS may require an explicit Gatekeeper approval because this build is not notarized.

The Linux package is the only desktop platform natively started and smoke-tested for this release.
The desktop packages are unsigned; the macOS package is not notarized.
The desktop Runtime manages Vaults and exposes a loopback API for a paired extension; page capture
and the extension-to-desktop Capture Bundle bridge are not included.

[Read the desktop Runtime installation and pairing guide](${metadata.desktopGuideUrl}).
`;
}

export function renderChromeReleaseNotes(metadata) {
  return `## Install the Chrome extension

1. Download \`${metadata.archiveName}\` and \`${metadata.checksumName}\` from this Release.
2. Verify the ZIP against the checksum using the full installation guide.
3. Extract the ZIP into a permanent directory.
4. Open \`chrome://extensions\` in Chrome.
5. Enable **Developer mode**.
6. Select **Load unpacked** and choose the extracted directory containing \`manifest.json\`.
7. Keep that directory in place. For an upgrade, replace its contents and reload the extension from the same path.

[Read the full installation, checksum, upgrade, and troubleshooting guide](${metadata.guideUrl}).

${renderDesktopReleaseNotes(metadata)}`;
}

export function renderReleaseNotes(metadata) {
  return `${renderChromeReleaseNotes(metadata)}
## Install the Firefox beta on desktop Linux

1. Download \`${metadata.firefoxXpiName}\` and \`${metadata.firefoxChecksumName}\`.
2. Verify the XPI against its checksum.
3. Open the XPI in Firefox Stable or ESR and approve the ordinary signed-add-on installation.

Firefox synchronization remains optional. Enabling it asks for Firefox's native data-collection and
server-origin permissions; local Capture, Library, MHTML, Export, and Import remain available
without them. Firefox can download MHTML but does not promise to render it natively.

[Read the Linux Firefox beta installation and privacy guide](${metadata.firefoxGuideUrl}).
`;
}

async function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageJson = JSON.parse(
    await readFile(path.join(scriptDirectory, "..", "package.json"), "utf8"),
  );
  const metadata = releaseMetadata({
    version: packageJson.version,
    eventName: process.env.GITHUB_EVENT_NAME,
    refName: process.env.GITHUB_REF_NAME,
    repository: process.env.GITHUB_REPOSITORY,
  });
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required");
  }

  const outputs = [
    ["version", metadata.version],
    ["tag", metadata.tag],
    ["prerelease", String(metadata.prerelease)],
    ["archive_name", metadata.archiveName],
    ["checksum_name", metadata.checksumName],
    ["firefox_xpi_name", metadata.firefoxXpiName],
    ["firefox_checksum_name", metadata.firefoxChecksumName],
    ["firefox_source_name", metadata.firefoxSourceName],
    ["desktop_linux_name", metadata.desktopLinuxName],
    ["desktop_linux_checksum_name", metadata.desktopLinuxChecksumName],
    ["desktop_windows_name", metadata.desktopWindowsName],
    ["desktop_windows_checksum_name", metadata.desktopWindowsChecksumName],
    ["desktop_macos_name", metadata.desktopMacosName],
    ["desktop_macos_checksum_name", metadata.desktopMacosChecksumName],
    ["guide_url", metadata.guideUrl],
    ["firefox_guide_url", metadata.firefoxGuideUrl],
    ["desktop_guide_url", metadata.desktopGuideUrl],
  ];
  await appendFile(outputPath, `${outputs.map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  await mkdir("dist", { recursive: true });
  await writeFile("dist/chrome-release-notes.md", renderChromeReleaseNotes(metadata));
  await writeFile("dist/release-notes.md", renderReleaseNotes(metadata));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
