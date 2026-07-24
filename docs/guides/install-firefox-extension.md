# Install a Future Signed Firefox Extension on Desktop Linux

This guide applies after AWSM's deferred AMO signing initiative publishes an unlisted
Mozilla-signed beta for desktop Linux Firefox Stable and ESR 140 or newer. Today, Firefox is
available only as the temporary development installation described in the project README; no
signed XPI is currently distributed.

## Verify the download

Download the matching `awsm-firefox-v<version>.xpi` and
`awsm-firefox-v<version>.xpi.sha256` files from the same Release. In a terminal opened in the
download directory, run:

```bash
sha256sum --check awsm-firefox-v<version>.xpi.sha256
```

Continue only when the command reports `OK`.

## Install

1. Open the downloaded XPI in Firefox.
2. Review Firefox's installation prompt.
3. Select **Add**.
4. Open AWSM from the toolbar and either continue without synchronization or connect a compatible
   Coordination Server.

The signed add-on persists across Firefox restarts. Use a normal browsing window; Firefox Private
Browsing is not a supported Capture or storage environment.

## Synchronization permission

Local Vault creation, Capture, Library, MHTML download, Export, and Import do not require
data-transmission permission. When you choose synchronization, Firefox asks in one native prompt
for the selected server origin and these optional data categories:

- website content;
- browsing activity;
- authentication information; and
- personally identifying information.

AWSM requests them because an encrypted synchronized Vault can contain those data classes. Denying
or later revoking the permission prevents Coordination Server traffic while local features remain
available. Reapprove synchronization from the popup or Library settings to resume.

## MHTML

Firefox can download the inert MHTML derivative produced from an AWSM page snapshot. AWSM does not
claim Firefox can render MHTML natively; use a compatible offline viewer when needed.

## Upgrade or remove

Install a newer signed XPI with the same extension ID to upgrade. Firefox preserves extension
storage during an ordinary upgrade, but creating a Complete Vault Export first is recommended.

Remove AWSM from `about:addons` under **Extensions**. Removing the extension can remove its local
browser storage; export any Vault you need before uninstalling.

## Troubleshooting

- A checksum failure means the XPI is incomplete or does not match the Release. Delete both files
  and download them again from the same Release.
- An unsigned or corrupt-add-on warning means the file is not the published Mozilla-signed XPI.
- If synchronization says permission is required, use **Allow synchronization** and approve the
  native Firefox prompt.
- If a downloaded MHTML file does not open in Firefox, use a compatible offline MHTML viewer; the
  download itself remains valid.
