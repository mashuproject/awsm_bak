# Install the Signed Firefox Extension on Desktop Linux

AWSM is distributed as an unlisted Mozilla-signed beta for desktop Linux Firefox Stable and ESR 140
or newer. It is available from the project's GitHub Release rather than a public or searchable AMO
listing. AWSM does not currently claim AMO-managed automatic updates.

## Verify the download

Open the [latest GitHub Release](https://github.com/mashuproject/awsm_bak/releases/latest).
Download the matching `awsm-firefox-v<version>.xpi` and
`awsm-firefox-v<version>.xpi.sha256` files from that same Release. In a terminal opened in the
download directory, run:

```bash
sha256sum --check awsm-firefox-v<version>.xpi.sha256
```

Continue only when the command reports `OK`.

## Install

1. Open the downloaded XPI in Firefox.
2. Review Firefox's installation prompt.
3. Select **Add**.
4. Open AWSM from the toolbar, name and create a local Vault, and write down its Recovery Phrase.

The signed add-on persists across Firefox restarts. Use a normal browsing window; Firefox Private
Browsing is not a supported Capture or storage environment.

## Synchronization permission

Local Vault creation, Capture, and locally available Library content do not require data-transmission
permission. When you choose a Replica Host, Firefox asks in one native prompt for the selected Host
origin and these optional data categories:

- website content;
- browsing activity;
- authentication information; and
- personally identifying information.

AWSM requests them because encrypted Vault data can contain those data classes. Denying or later
revoking the permission prevents that Host channel from operating while local features remain
available. Reapprove the selected Host from the popup to resume.

## MHTML

Firefox can download the inert MHTML derivative produced from an AWSM page snapshot. AWSM does not
claim Firefox can render MHTML natively; use a compatible offline viewer when needed.

## Upgrade or remove

AWSM does not currently provide AMO-managed automatic updates. Check the
[latest GitHub Release](https://github.com/mashuproject/awsm_bak/releases/latest), verify its
checksum, and install the newer signed XPI with the same extension ID to upgrade. Firefox ordinarily
preserves extension storage during an upgrade, but do not rely on an interrupted install or a removed
browser profile to preserve local data. Keep the Recovery Phrase safe and retain any Replica Host
access you rely on.

Remove AWSM from `about:addons` under **Extensions**. Removing the extension can remove its local
browser storage. A Recovery Phrase can recover a Vault only where an accessible Replica still has
the required encrypted items.

## Troubleshooting

- A checksum failure means the XPI is incomplete or does not match the Release. Delete both files
  and download them again from the same Release.
- An unsigned or corrupt-add-on warning means the file is not the published Mozilla-signed XPI.
- If synchronization says permission is required, use **Allow synchronization** and approve the
  native Firefox prompt.
- If a downloaded MHTML file does not open in Firefox, use a compatible offline MHTML viewer; the
  download itself remains valid.
