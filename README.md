# AWSM — Archive What Should Matter

AWSM is a local-first webpage archival platform with optional zero-knowledge synchronization. It
captures, stores, and presents a Vault in a trusted browser extension; optional synchronization
services receive encrypted data rather than plaintext archive content.

AWSM was created for the OpenAI Devpost hackathon from a concern with conventional clipping
services: an archive should not become inaccessible because a provider shuts down, changes
direction, or restricts access, and sensitive captures should not require giving a service provider
plaintext content.

The implementation is a public preview. It is not currently available from the Chrome Web Store.
Every Coordination Server serves the same product landing and Account pages; availability of new
Account registration remains deployment-specific.

## Download and try AWSM

### Download AWSM for Chrome or Firefox

> **[Download the Chrome ZIP (v0.3.1)](https://github.com/mashuproject/awsm_bak/releases/download/v0.3.1/awsm-chrome-v0.3.1.zip)**
>
> [Chrome SHA-256 checksum](https://github.com/mashuproject/awsm_bak/releases/download/v0.3.1/awsm-chrome-v0.3.1.zip.sha256) ·
> **[Download the Mozilla-signed Firefox XPI (v0.3.1)](https://github.com/mashuproject/awsm_bak/releases/download/v0.3.1/awsm-firefox-v0.3.1.xpi)**
> ·
> [Firefox SHA-256 checksum](https://github.com/mashuproject/awsm_bak/releases/download/v0.3.1/awsm-firefox-v0.3.1.xpi.sha256) ·
> [View the latest Release](https://github.com/mashuproject/awsm_bak/releases/latest) ·
> [Chrome guide](docs/guides/install-chrome-extension.md) ·
> [Firefox guide](docs/guides/install-firefox-extension.md)

The latest Release contains a Chrome ZIP, a Mozilla-signed Firefox XPI, and their SHA-256 checksums.
No source build, Account, server, test credentials, or seeded sample data is required to try the
core local archive.

1. Download the Chrome ZIP and matching `.sha256` file using the links above.
2. Verify and install the ZIP using the
   [Chrome extension installation guide](docs/guides/install-chrome-extension.md).
3. Open AWSM, create a local Vault, and write down its Recovery Phrase.
4. Open any HTTP or HTTPS page and select **Archive this page**.

For a guided walkthrough, continue with [Try a Capture](#try-a-capture) and
[Verify offline behavior](#verify-offline-behavior). To review the hackathon development process,
see [How OpenAI tools were used](#how-openai-tools-were-used).

**Released test platforms:** Chrome 116 or newer on a desktop operating system supported by Chrome,
and the repository-pinned Firefox Stable and ESR versions on desktop Linux. AWSM must be used in a
normal browser profile; Incognito and Firefox Private Browsing are not supported. Firefox is an
unlisted Mozilla-signed Linux beta distributed through the GitHub Release, not a public AMO listing,
and AWSM does not claim AMO-managed automatic updates. Safari and standalone web applications are
not currently packaged or tested. Firefox for Android 142 or newer can accept the signed manifest,
but AWSM is not currently tested or supported there.

## What works today

The browser extension currently supports:

- local-only Vault creation with a client-held Recovery Phrase;
- Capture of an active HTTP or HTTPS page into encrypted local Vault storage;
- multiple local Vaults, selection, recent-Capture browsing, Closure, Vacuum, and Fork workflows;
- Recovery Phrase replacement and same-member recovery on a fresh Client Credential;
- encrypted, browser-local Vault Records, Objects, and large Capture Artifacts;
- optional username-based Account sign-in to a compatible opaque Replica Host, with no email
  address required;
- creation or local attachment of a Hosted Replica, explicit Compact-closure materialization, and
  receiver-initiated checks of enabled Hosted Replicas; and
- explicit hydration of an available large Capture Artifact after a configured Hosted Replica
  supplies and the Client verifies it.

The trusted extension validates all Vault semantics locally. A Replica Host stores opaque encrypted
bytes and Host-local Account, Grant, quota, and operational data; it does not receive Vault IDs,
decryption keys, page titles, or Capture content. Hosted recovery creates a Sparse Replica from the
authenticated Compact closure, so Capture metadata can be available before a large Artifact wrapper
is retrieved.

The Mozilla-signed Firefox Linux beta is distributed through the GitHub Release, not a public AMO
listing, and AWSM does not claim AMO-managed automatic updates. The release proof covers the
repository-pinned Firefox Stable and ESR versions on desktop Linux. Chrome and Firefox each request
only the permissions needed for Capture and an explicitly selected Host origin; denying optional
Host permission leaves local Vault work available and prevents that Host channel call.

Current limits are intentional: direct peer and headless transports, complete Authority-branch
synchronization, global freshness claims, automatic redundancy tracking, and user-facing AI
features are not shipped in this release. See the living specifications for the broader canonical
model and its currently unimplemented branches.

The Coordination Server root is the public AWSM product and installation guide on hosted and
self-hosted deployments. Its privacy, security, setup, and Account pages are evergreen product
documentation. They contain no analytics, third-party scripts, remote fonts, pricing, or waitlist
collection. Account signup remains a separate optional-synchronization page and is shown only when
the current server permits registration. The public landing, privacy, security, and glossary
responses are safe for a shared CDN cache. They render one anonymous representation without
Account data, session cookies, or CSRF tokens. A signed-in browser privately restores its Account
presentation through a no-store session-status request; anonymous browsers do not make that
request.

## Architecture direction

The living architecture and formal specifications describe the canonical foundation implemented by
the current extension and Replica Host. A Vault is location-independent and may have zero or more
local, peer, headless, or Hosted Replicas; trusted Clients pull and validate opaque immutable items
without one privileged origin.

Portable Vault membership uses per-member Recovery Phrases and Client Credentials. Administrator
roles govern shared Vault coordination but do not create a different decryption class. Host
Accounts remain username-based local access identities with no email and no intrinsic relationship
to a Vault Member. The Account dashboard manages the Host channel and storage, not a duplicate web
Vault.

The release carries one canonical pre-release design. It has no compatibility readers, migrations,
or fallback paths for discarded experiments. See the [living PRD](docs/plans/01-mvp-prd.md),
[system overview](docs/architecture/01-system-overview.md), and
[consistency review](docs/architecture/consistency-review.md).

## Quick start: local-only Chrome extension

### Requirements

- Chrome 116 or newer
- Node.js 22
- Corepack

Use a normal Chrome profile. Do not enable **Allow in Incognito** for AWSM; Incognito is not a
supported storage or capture environment.

Clone the repository, install the pinned dependencies, and build the extension:

```bash
git clone https://github.com/mashuproject/awsm_bak.git
cd awsm_bak
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Load the build in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `apps/browser-extension/.output/chrome-mv3`.
5. Pin AWSM from Chrome's Extensions menu.
6. Open AWSM, name and create a local Vault, and write down its Recovery Phrase.

AWSM is now ready to capture without an Account or Coordination Server. For installation from a
[GitHub Release](https://github.com/mashuproject/awsm_bak/releases/latest), download the latest Chrome ZIP
and its SHA-256 checksum. See the
[Chrome extension installation guide](docs/guides/install-chrome-extension.md) for checksum
verification, unpacked installation, upgrades, and troubleshooting.

For local Firefox Host development, build explicitly with:

```bash
corepack pnpm --filter @awsm/browser-extension build:firefox
```

Load `apps/browser-extension/.output/firefox-mv3/manifest.json` as a temporary add-on from
`about:debugging#/runtime/this-firefox`. Temporary installation is intended for development and
ends when Firefox restarts. Local use needs no data-transmission permission; selecting
synchronization presents Firefox's native consent prompt. Ordinary users should install the
Mozilla-signed XPI using the
[Firefox extension installation guide](docs/guides/install-firefox-extension.md).

## Try a Capture

No seeded sample data is required. AWSM creates its sample data by capturing a live HTTP or HTTPS
page.

1. Open a webpage in Chrome.
2. Open the AWSM toolbar popup.
3. Select **Archive this page**.
4. Wait for the **Archived:** preview card.
5. Open that card or select **Open library**.
6. Open the Capture to view its full-page screenshot and Artifact list.
7. Select **Inspect** for extracted text or structured content, or **Download** for MHTML.

The Devpost demonstration uses this CNN article:

<https://edition.cnn.com/2026/07/20/science/pompeii-survivors-docuseries>

If that page is unavailable or does not capture reliably, use the equivalent Science News article:

<https://www.sciencenews.org/article/pompeii-documentary-tom-hiddleston>

These links are demonstration inputs, not repository fixtures, and may change independently of
AWSM.

### Verify offline behavior

After a successful Capture:

1. Disconnect Chrome or the machine from the network.
2. Close or reload the original webpage to confirm it is unavailable.
3. Open the AWSM Library.
4. Open the saved Capture.
5. View and scroll the full-page screenshot.
6. Inspect the extracted text or structured content.
7. Download the locally stored MHTML if desired.

Core archive functionality remains available because the Capture and its local Artifacts do not
depend on a server. In the current implementation, a user who explicitly applies synchronized
storage relief can remove selected local heavy wrappers after AWSM verifies their encrypted server
copies. Those remote-only Artifacts require the configured Account and a network connection until
retrieved again; compact Library data remains local. The target architecture instead always warns
without claiming global redundancy, because no decentralized Client can know every surviving copy.

## Optional synchronization

The local client is the primary application. Synchronization is an optional coordination layer for
encrypted data between devices.

The extension offers the pre-release hosted Coordination Server at <https://awsm.foo> and supports
compatible self-hosted Coordination Servers. The hosted origin is a synchronization API, not a web
client: browsing, Capture, Search, Export, and Import remain trusted client behavior. The hosted
service is not advertised as a production-ready public service.

To run a self-hosted development server, start the Coordination Server, PostgreSQL, and disposable
Redis ephemeral coordination with Docker Compose:

```bash
docker compose up --build
```

The server is then available at <http://localhost:3000>. In AWSM, choose self-hosted
synchronization and follow its signup link to create the Account on the Rails web page. Then return
to the extension, enter the server origin, grant browser access, and log in. See the [Coordination
Server development guide](apps/coordination-server/README.md) for operations and troubleshooting.

The client encrypts Vault content before transmission. The current server stores encrypted items
plus pre-release semantic coordination metadata; it does not receive the keys needed to decrypt
Vault plaintext. Fresh Chrome and Firefox installations recover the synchronized Vault with the
current 12-word Recovery Phrase, establish fresh local synchronization authority, and download the
active encrypted state. Rails password changes revoke sessions without changing Vault keys.
Production quotas, billing, shared object storage, and production deployment hardening remain
future work.

## Development

Use the repository-pinned pnpm through Corepack:

```bash
corepack pnpm build
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:e2e
```

Create a distributable Chrome ZIP with:

```bash
corepack pnpm zip
```

The repository is organized as follows:

```text
apps/browser-extension/     Chrome Host, Runtime, local storage, and user interface
apps/coordination-server/   Rails coordination service for opaque encrypted data
docs/architecture/          architectural intent and system boundaries
docs/specifications/        formal formats, protocols, and Runtime contracts
docs/plans/                 living PRD plus historical implementation plans and TDD evidence
```

Product intent begins in [VISION.md](VISION.md). Architectural constraints are defined by the
[design principles](docs/architecture/00-design-principles.md), and canonical terminology is in the
[glossary](docs/architecture/glossary.md).

## How OpenAI tools were used

AWSM was developed as a human-directed, AI-assisted project. The product problem, privacy goals,
local-first requirements, architectural decisions, and acceptance of the resulting behavior were
provided and reviewed by the project author. OpenAI tools supported the work end to end:

- **Planning and design:** GPT-5.6 in ChatGPT helped turn the initial product idea into requirements,
  implementation plans, architecture documents, specifications, threat boundaries, and explicit
  acceptance criteria.
- **Implementation:** Codex implemented the browser extension, local Runtime and storage Drivers,
  cryptographic workflows, Coordination Server, synchronization protocol, and user-facing flows
  under the author's direction and review.
- **Testing and debugging:** Codex developed unit, browser integration, packaged-extension
  end-to-end, multi-replica synchronization, failure-injection, and recovery tests; investigated
  failures; and iterated on implementations until the required behavior was demonstrated.
- **Privacy and consistency review:** GPT-5.6 and Codex helped trace changes across architecture,
  formal contracts, implementation, tests, and operations so that plaintext remained inside trusted
  clients and superseded pre-release behavior was not retained as compatibility code.
- **Product and UI refinement:** Codex iterated on onboarding, capture feedback, Library and Artifact
  presentation, responsive layouts, accessibility, error states, and rendered visual checks based on
  author guidance.
- **Delivery:** Codex helped build the development environment, packaging and release validation,
  GitHub Actions CI/CD, installation documentation, and the Devpost demo narrative.

The tools accelerated design, implementation, review, and iteration; they did not replace human
product direction or responsibility for the project's decisions and claims.

## Design principles

- **Local first:** Captures are created, encrypted, stored, and viewed on the client.
- **Replicas optional:** Local use needs no Host; authorized local, peer, or hosted Replicas may
  synchronize opaque encrypted data.
- **Preserve first, interpret later:** Original source Artifacts are retained independently from
  future derived interpretations.
- **Immutable originals:** Captures and their authoritative Objects are not edited in place.
- **No plaintext server dependency:** The server must not require plaintext user content or
  unwrapped Vault keys.

AWSM treats a web Capture as one immutable Bundle graph. Its canonical page snapshot, screenshot,
thumbnail, normalized text, and structured content are independently encrypted Artifacts. MHTML is
derived on demand. This preserves the source while supporting bounded-memory storage, integrity
verification, portable Complete Export and Import, and future locally derived capabilities.

## Release process

Maintainers publish validated Chrome artifacts from version tags:

1. Update `version` in `apps/browser-extension/package.json`.
2. Run `corepack pnpm --filter @awsm/browser-extension test:e2e:cross-browser` locally.
3. Commit and push the change to `main`.
4. Create and push the matching `v<version>` tag.
5. Wait for the Chrome Extension Release workflow to lint, typecheck, run unit tests, validate
   both production builds, and publish the checksummed Release.

Real-browser release proof runs locally to avoid consuming hosted CI minutes. Do not create the tag
unless that local gate passes on the exact commit being tagged.

Versions ending in `-alpha.N`, `-beta.N`, or `-rc.N` create prereleases. Plain versions create
stable Releases. The workflow does not move or overwrite an existing tag or Release.

## License

AWSM is free software licensed under the GNU Affero General Public License, version 3 or later. See
[LICENSE](LICENSE) for the complete license text.
