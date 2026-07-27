# Two-Phase Firefox Signing and Distribution

**Document:** `docs/plans/19-two-phase-firefox-signing-and-distribution.md`

**Status:** Approved implementation plan

**Owner:** Engineering

**Last Updated:** 2026-07-27

**Depends On:** `AGENTS.md`, `DESIGN.md`, `README.md`, `ROADMAP.md`,
`docs/architecture/19-testing-strategy.md`,
`docs/architecture/20-deployment-and-operations.md`,
`docs/guides/install-firefox-extension.md`,
`docs/plans/12-automated-chrome-extension-releases-and-installation.md`,
`docs/plans/13-browser-independent-web-page-snapshot-and-firefox-host.md`,
`docs/plans/13-browser-independent-web-page-snapshot-and-firefox-host-tdd-evidence.md`,
`.github/workflows/chrome-extension-release.yml`, and
`.codex/skills/release-browser-extension/SKILL.md`

---

# 1. Purpose

This is the decision-complete implementation and execution plan for replacing the current
tag-time Firefox signing path with a two-phase release gate. The first real `v0.1.8` candidate
proved that AMO semantically reserializes `manifest.json`; the verifier correctly withheld
publication, and the source-changing correction advanced the joint Release to `v0.1.9`. Signed
retained-profile proof then withheld `v0.1.9`, while deterministic reproduction exposed
source-archive byte drift. Those source-changing corrections advance the joint Release to
`v0.1.10` under this plan's immutability rule.

It is written for an implementer starting from a cold checkout with no conversation context. Do
not reopen the fixed signing channel, release version, proof handoff, publication, browser support,
public-copy, or rollout decisions recorded here.

The completed work SHALL:

1. submit an exact, untagged release candidate to Mozilla Add-ons for unlisted signing;
2. create no Git tag or GitHub Release during candidate signing;
3. download and validate the Mozilla-signed XPI as a run-scoped candidate artifact;
4. run Firefox Stable, Firefox ESR, and Chrome/Firefox proof locally against those exact signed
   bytes;
5. record a non-secret GitHub commit status only after the local proof completes;
6. reject tag publication unless the tagged commit has the exact successful proof status;
7. publish the exact locally tested XPI rather than signing or selecting a new file at tag time;
8. retain the existing Chrome-only path when Firefox signing is explicitly disabled;
9. publish `v0.1.10` as one joint GitHub Release with Chrome and Firefox assets and checksums;
10. describe Firefox accurately as an unlisted Mozilla-signed desktop-Linux beta;
11. update the public product site, README, installation guidance, architecture/testing prose,
    Roadmap, and release skill to match the released behavior; and
12. deploy and verify the exact tagged public-site source in the separately authorized staging
    environment without changing production.

This plan changes release automation, release evidence, public distribution, and product copy. It
does not change the browser extension's Runtime, persisted formats, synchronization protocol,
Vault contents, or Coordination Server API.

# 2. Fixed Decisions, Scope, and Deferrals

## 2.1 Fixed decisions

| Concern                    | Decision                                                        |
| -------------------------- | --------------------------------------------------------------- |
| First joint version        | `0.1.10`, annotated tag `v0.1.10`                               |
| GitHub Release kind        | Public, non-draft, non-prerelease                               |
| Firefox channel            | AMO `unlisted`                                                  |
| User distribution          | Signed XPI and checksum attached to the GitHub Release          |
| AMO listing                | No public/searchable AMO listing                                |
| Automatic updates          | Not claimed or implemented                                      |
| Supported Firefox platform | Desktop Linux only                                              |
| Tested Firefox lanes       | Repository-pinned Stable and ESR                                |
| Candidate Git location     | Exact candidate commit pushed to `main`                         |
| Candidate trigger          | Explicit manual workflow dispatch                               |
| Publication authorization  | Explicit annotated tag after local proof                        |
| Proof handoff              | GitHub commit status on the exact candidate commit              |
| Status context             | `awsm/firefox-signed-local-proof`                               |
| Signed artifact provenance | Run-scoped artifact plus non-secret JSON manifest               |
| Tag-time AMO traffic       | Forbidden                                                       |
| Hosted real-browser tests  | Forbidden; signed browser proof remains local                   |
| Public-site rollout        | Tagged source to staging only                                   |
| Shared-cache invalidation  | Exact canonical staging public URLs only                        |
| Production                 | Out of scope and unchanged                                      |
| Public implementation      | Provider-neutral; reference details stay in the ignored overlay |

`0.1.10` remains a normal SemVer release because the project is already distributing public `0.x`
preview releases without SemVer prerelease suffixes. “Beta” describes the Firefox platform support
and unlisted distribution channel, not the GitHub Release's prerelease flag.

The user accepted that pushing the complete candidate to `main` can make repository copy describe
the Firefox beta while AMO review is still pending. Do not deploy that copy to staging until the
joint Release exists and its assets pass independent verification.

## 2.2 In scope

This plan includes:

- manual candidate-signing workflow inputs and conditions;
- deterministic candidate provenance;
- resumable exact-version AMO submission and retrieval;
- local signed-XPI verification orchestration;
- commit-status creation and tag-time status enforcement;
- cross-run candidate artifact retrieval;
- Chrome-only and joint publisher separation;
- workflow, signing, provenance, verifier, and failure regression tests;
- `v0.1.10` version and public download references;
- README, Firefox installation guide, release notes, public landing page, rendered assertions, and
  screenshots;
- Roadmap and superseded Plan 13 release-contract reconciliation;
- the tracked release skill and its UI metadata;
- local release gates, hosted candidate and tag runs, Release verification; and
- an isolated staging deployment, exact shared-cache purge, cache warm, and rendered verification.

## 2.3 Explicitly deferred

Do not implement or claim:

- a public or searchable AMO listing;
- AMO-managed automatic updates;
- Chrome Web Store publication;
- Firefox macOS, Windows, Android, or Private Browsing support;
- Safari, mobile, or standalone application packaging;
- hosted Playwright, Selenium, browser downloads, browser matrices, or scheduled browser jobs;
- production deployment, production cache purge, production ingress changes, or upstream
  repository promotion;
- a second GitHub Release publisher for the same tag;
- a general release-attestation service, GitHub App, or new credential broker; or
- any application default containing a reference domain, host alias, deployment path, CDN
  account, profile, container name, or repository fork.

The later browser-store Roadmap initiative owns public AMO and Chrome Web Store listings,
automatic-update policy, listing metadata, artwork, and additional operating-system proof.

## 2.4 Credential and licensing boundaries

The repository configuration uses:

```text
Repository variable: FIREFOX_AMO_SIGNING_ENABLED=true
Repository secret: AMO_JWT_ISSUER
Repository secret: AMO_JWT_SECRET
```

The implementer SHALL verify only the names and presence of this configuration. Never print,
retrieve, transform, persist, copy into a command argument, upload, or include either secret in an
artifact, status, log, plan, evidence file, or chat response.

The candidate job passes the secrets directly through its environment only to the repository-owned
signing script and `web-ext`. Pull-request validation, validate-only dispatches, tag publication,
local proof, and staging deployment receive no AMO credentials.

This plan adds no runtime dependency and authorizes no third-party source-code reuse. Existing
permissively licensed release tooling remains pinned. Do not copy or adapt AMO or `web-ext`
implementation code.

# 3. Release State Machine

## 3.1 States

One version moves through these states:

```text
Prepared
  |
  | manual sign-firefox-candidate dispatch
  v
Submitted ---------> Pending Review
  |                       |
  | signed                | rerun same candidate operation
  v                       |
Signed Candidate <--------'
  |
  | exact local Stable + ESR + cross-browser proof
  v
Locally Proven
  |
  | explicit annotated tag
  v
Publishing
  |
  | exact artifact and checksum verification
  v
Published
  |
  | exact tagged staging deployment and cache verification
  v
Staging Verified
```

`Rejected`, `Local Proof Failed`, `Tag Gate Failed`, and `Publication Failed` are not success
states and create no permission to bypass a gate.

## 3.2 Version immutability

Apply these rules:

1. Pending AMO review keeps the same version and resumes the exact submission.
2. A completed signed candidate may be downloaded again for the same permanent add-on ID and
   version.
3. If source or packaged extension bytes must change after AMO submission, increment to a new
   patch version. Never upload changed bytes as the same version.
4. If local signed-browser proof exposes an extension defect, do not tag that version. Fix it,
   choose the next patch version, and repeat every gate.
5. If AMO rejects the version and remediation changes bytes, choose the next patch version.
6. Never move, overwrite, delete, or recreate a published tag or Release.
7. If a tag exists without a Release after a failure, stop and obtain explicit recovery authority.
   Prefer a new version when an immutable audit trail is useful.

## 3.3 Evidence chain

Publication requires this exact chain:

```text
tag commit
  == successful proof-status commit
  == candidate workflow commit
  == provenance-manifest commit

package version
  == candidate provenance version
  == signed XPI manifest version
  == tag without leading "v"

published XPI bytes
  == candidate artifact XPI bytes
  == locally tested XPI bytes
```

The signed XPI payload, excluding Mozilla signature entries, must also equal the deterministic
unsigned Firefox archive reproduced from the tag.

# 4. Public Interfaces and Artifact Contracts

## 4.1 Workflow dispatch interface

Change the browser-extension release workflow's `workflow_dispatch` contract to:

```yaml
inputs:
  operation:
    description: Browser release operation
    required: true
    type: choice
    default: validate-only
    options:
      - validate-only
      - sign-firefox-candidate
  resume_run_id:
    description: Prior candidate run to resume when it preserved an AMO upload identity
    required: false
    type: string
```

Rules:

- `validate-only` performs build, static validation, packaging, and artifact validation. It makes
  no AMO request and publishes nothing even when signing is enabled.
- `sign-firefox-candidate` requires the signing variable to equal `true`, requires both secrets,
  builds the event's exact `github.sha`, proves that commit belongs to `main`, signs or resumes the
  package, and uploads candidate artifacts. It publishes nothing.
- `resume_run_id`, when non-empty, must contain decimal digits only. The workflow must prove that
  the referenced run belongs to the same repository, workflow, commit, and version before reading
  its non-secret upload-identity artifact.
- A tag push accepts no dispatch inputs and follows the tag publication path.
- A push to `main` alone continues to publish nothing.

Keep `cancel-in-progress: false`. Candidate dispatches for `main` remain serialized so two absent
version checks cannot race into simultaneous submissions.

## 4.2 Candidate artifact

The successful candidate job uploads:

```text
Artifact:
  firefox-candidate-v<version>-<full-commit-sha>

Files:
  awsm-firefox-v<version>.xpi
  awsm-firefox-v<version>.xpi.sha256
  firefox-candidate-v<version>.json
```

Retain it for 30 days with artifact compression disabled.

The provenance JSON contains exactly:

```json
{
  "repository": "owner/name",
  "commit": "40 lowercase hexadecimal characters",
  "version": "SemVer without build metadata",
  "tag": "v<version>",
  "operation": "sign-firefox-candidate",
  "addonId": "the permanent Firefox add-on ID",
  "candidateRunUrl": "https://github.com/owner/name/actions/runs/<run-id>",
  "unsignedArchive": {
    "name": "awsm-firefox-unsigned-v<version>.zip",
    "sha256": "64 lowercase hexadecimal characters"
  },
  "sourceArchive": {
    "name": "awsm-firefox-source-v<version>.zip",
    "sha256": "64 lowercase hexadecimal characters"
  },
  "signedXpi": {
    "name": "awsm-firefox-v<version>.xpi",
    "sha256": "64 lowercase hexadecimal characters"
  }
}
```

Use strict construction and strict decoding. Reject missing, extra, malformed, mismatched, or
non-canonical fields. Do not include timestamps, actor identities, credentials, AMO account data,
submission responses, opaque AMO URLs, or mutable branch names.

The always-run resumability artifact is separate:

```text
Artifact:
  firefox-amo-submission-v<version>-<full-commit-sha>

Optional file:
  .amo-upload-uuid
```

Treat the UUID as non-secret but operational. Never publish it in the GitHub Release or public
documentation.

## 4.3 Local command

Add this package script:

```text
release:firefox:verify-candidate
```

Its interface is:

```bash
corepack pnpm --filter @awsm/browser-extension \
  release:firefox:verify-candidate --run-id <candidate-run-id>
```

`--run-id` is required and accepts decimal digits only. Do not add implicit “latest run” selection.
The command may write only beneath ignored browser-extension `.output` paths and may create a
GitHub commit status. It must not create or push a Git tag, create a Release, contact AMO, change
repository files, or deploy anything.

## 4.4 Commit status

Use one context:

```text
awsm/firefox-signed-local-proof
```

The local command:

1. completes non-mutating repository, run, provenance, archive, and XPI preflight;
2. posts `pending` before starting real-browser execution;
3. posts `failure` when a handled browser or verification failure occurs;
4. posts `success` only after Stable, ESR, and the complete cross-browser command pass; and
5. uses the candidate workflow URL as `target_url`.

The description is bounded, contains the version and first 12 XPI digest characters, and contains
no local path, hostname, credential, account data, test payload, or user data.

The latest status for this exact context is authoritative. A later `pending` or `failure` blocks
publication even if an older success exists.

The local GitHub credential must have push access and commit-status write permission. The
tag-publishing job needs only `statuses: read`, `actions: read`, and its existing contents
permissions.

# 5. Workflow Implementation

## 5.1 Shared build

Retain one shared build path for validate-only, candidate, and tag runs:

1. check out the event's exact commit with full tag ancestry where required;
2. enable Corepack and install frozen dependencies;
3. derive strict metadata from the package version and event;
4. require tag/version equality on tag pushes;
5. require candidate and tag commits to be ancestors of `origin/main`;
6. run lint, typecheck, unit/release tests, and production builds;
7. create Chrome ZIP, deterministic unsigned Firefox ZIP, and Firefox source ZIP;
8. validate exact archive counts, root manifests, permissions, forbidden paths, notices, sizes,
   and checksums; and
9. upload the validated build inputs for jobs in the same workflow run.

Do not use a broad cleanup. Remove only the known generated versioned browser archives through the
existing release-output script.

## 5.2 Candidate signing job

Run the candidate signing job only when all are true:

- event is `workflow_dispatch`;
- `operation == sign-firefox-candidate`; and
- `FIREFOX_AMO_SIGNING_ENABLED == true`.

The job SHALL:

1. fail clearly before AMO traffic if either protected secret is empty;
2. download the shared validated inputs;
3. rebuild the deterministic unsigned Firefox package and compare it byte-for-byte with the shared
   input;
4. restore an optional upload UUID only from a validated `resume_run_id`;
5. query the permanent add-on ID and exact version before submitting;
6. submit only when that exact version is absent;
7. use `web-ext sign --channel=unlisted` and upload the exact source archive;
8. poll only the exact add-on ID and version;
9. distinguish signed, pending, rejected, malformed, and HTTP failure states;
10. retrieve only the AMO-reported signed XPI and verify its reported SHA-256;
11. validate Mozilla signature entries and exact unsigned payload equivalence;
12. create and verify the XPI checksum and strict provenance manifest;
13. upload the candidate artifact; and
14. preserve the optional upload UUID in an `always()` step.

Keep the existing finite polling window. When review remains pending, fail with an explicit
resumption message and create no candidate XPI artifact. A later dispatch resumes by exact
ID/version and may use `resume_run_id`.

## 5.3 Chrome-only publisher

Retain the Chrome-only publisher only when:

- the event is a `v*` tag push; and
- `FIREFOX_AMO_SIGNING_ENABLED != true`.

It revalidates transferred Chrome assets and publishes Chrome ZIP plus checksum with Chrome-only
release notes. It makes no AMO request and mentions no unavailable XPI.

## 5.4 Joint publisher

Replace the current tag-time signing dependency with a proof-import gate. Run the joint publisher
only when:

- the event is a `v*` tag push; and
- `FIREFOX_AMO_SIGNING_ENABLED == true`.

The job SHALL:

1. re-prove tag/version equality and `main` ancestry;
2. query statuses for the tag commit and select the latest exact proof context;
3. require its state to be `success`;
4. require its target URL to be an Actions run in the same repository;
5. query that run and require:
   - the browser release workflow;
   - `workflow_dispatch`;
   - completed `success`;
   - head SHA equal to the tag commit;
6. construct the exact artifact name from version and full commit SHA;
7. download that artifact from the referenced run using run-scoped Actions access;
8. strictly validate provenance repository, commit, version, tag, operation
   `sign-firefox-candidate`, add-on ID, run URL, filenames, and digests;
9. verify XPI and checksum integrity;
10. compare the signed payload with the tag run's deterministic unsigned Firefox package;
11. revalidate the Chrome archive and checksum;
12. prove that no Release already exists;
13. create one GitHub Release containing:

    ```text
    awsm-chrome-v<version>.zip
    awsm-chrome-v<version>.zip.sha256
    awsm-firefox-v<version>.xpi
    awsm-firefox-v<version>.xpi.sha256
    ```

14. use joint Chrome and Firefox installation notes.

The tag workflow must not receive AMO secrets, call `web-ext sign`, query AMO, or replace the
candidate XPI with a new download. This is what makes the published file exactly the locally tested
file.

# 6. Local Signed-Candidate Verifier

Implement the verifier as a repository-owned Node script using existing Node APIs and subprocesses.
Do not add a dependency for argument parsing, GitHub access, checksums, ZIP handling, or process
orchestration.

## 6.1 Preflight

Before creating a status, require:

1. current branch is `main`;
2. working tree is clean, excluding known ignored generated output;
3. `git fetch origin main` succeeds;
4. local `HEAD == origin/main`;
5. package version is strict SemVer and equals the candidate provenance version;
6. matching remote tag and GitHub Release are both absent;
7. GitHub CLI authentication can read the repository and write commit statuses;
8. selected run exists in the authorized repository;
9. run event is `workflow_dispatch`, head SHA equals `HEAD`, status is completed, and conclusion is
   success;
10. exactly one expected candidate artifact is downloaded;
11. provenance operation is exactly `sign-firefox-candidate`;
12. provenance and checksums validate;
13. signed XPI root manifest reports the permanent ID and exact version;
14. required Mozilla signature entries exist;
15. `corepack pnpm zip:firefox` reproduces the expected unsigned archive; and
16. the signed XPI payload equals that unsigned archive.

Fail without creating a status if any preflight item fails.

## 6.2 Browser proof

After posting `pending`, run in order:

1. the Firefox production suite against the exact XPI with
   `AWSM_FIREFOX_SIGNED_XPI=<absolute-candidate-path>`;
2. both repository-pinned Firefox Stable and ESR lanes;
3. the complete cross-browser suite with the same signed XPI; and
4. every Chrome-to-Firefox and Firefox-to-Chrome case, including process-restart coverage that
   temporary add-ons cannot prove.

Do not rebuild or substitute the XPI after the status becomes pending. Production Firefox tests
must install it as a permanent signed add-on, not as a temporary extension, and must leave signature
enforcement at its normal value for signed-install proof.

Capture command names, versions, exit outcomes, commit, run ID, and asset digest in an ignored local
proof JSON for operator inspection. Do not record Vault content, Recovery Phrases, Account
credentials, test-server secrets, local absolute paths, or remote operational identifiers.

## 6.3 Status failure behavior

- A nonzero browser command posts `failure` and exits nonzero.
- A termination that prevents cleanup may leave `pending`; `pending` blocks publication.
- A later rerun posts a newer status for the same context.
- Do not post `success` from a `finally` block or after a partial lane.
- Do not let `--force`, an environment variable, or missing browser installation skip a lane.

# 7. Public Product and Documentation Changes

## 7.1 Positioning

Use this factual distribution contract everywhere:

> AWSM provides a Mozilla-signed Firefox beta for desktop Linux Firefox Stable and ESR. Download
> the unlisted XPI and checksum from the GitHub Release. It is not a public AMO listing and does not
> provide AMO-managed automatic updates.

Do not describe it as development-only, unsigned, a temporary add-on, generally cross-platform, or
available “from AMO.” “Mozilla-signed” describes signing; “unlisted” describes its AMO channel;
GitHub Releases is the user-facing download location.

## 7.2 README and guides

Update owned version and artifact references together:

- Chrome direct download and checksum become `v0.1.10`;
- add Firefox XPI and checksum links for `v0.1.10`;
- state that the latest Release contains both browser packages;
- change released-platform copy from Chrome-only plus Firefox development build to Chrome plus the
  signed desktop-Linux Firefox beta;
- keep temporary Firefox installation instructions only in an explicitly labeled development
  section;
- direct ordinary Firefox users to the signed-XPI guide; and
- preserve optional synchronization permission and local-only behavior explanations.

Change the Firefox guide:

- remove “Future” from its title;
- replace “no signed XPI” prose with latest-Release download instructions;
- retain `sha256sum --check`;
- describe ordinary XPI installation and persistence across restarts;
- describe manual upgrade with the same permanent extension ID;
- retain Linux, Stable/ESR, normal-window, MHTML, synchronization-permission, Export-before-remove,
  and troubleshooting boundaries; and
- state plainly that unlisted distribution has no AMO-managed automatic updates.

Generated joint release notes use tag-pinned guide URLs and exact artifact names.

## 7.3 Public Rails site

Update the Firefox installation panel to include:

- badge: **Mozilla-signed Linux beta**;
- heading: **Firefox on desktop Linux**;
- steps to download the latest Release, verify the XPI checksum, open the signed XPI, approve the
  installation, and choose local-only or optional synchronization;
- primary **Latest Release** link; and
- secondary **Firefox installation guide** link.

Update the installation FAQ to contrast the Chrome unpacked preview with the signed Firefox Linux
beta without implying a store listing.

During the required public-copy audit, correct the existing stale FAQ that says Search is not
shipped. State that keyword Search works locally and optional semantic Search uses either an
explicitly downloaded local model or an explicitly configured remote endpoint with disclosure.
Do not imply generated answers, summaries, tags, or classifications.

No new CSS or design-system token is expected. If the revised content exposes a layout or contrast
problem, fix it through existing semantic components and approved tokens rather than introducing
one-off styling.

Update request assertions, no-JavaScript assertions, and the Firefox installation and affected FAQ
screenshots. Inspect primary and narrow rendered states for wrapping, spacing, focus, button
prominence, readable contrast, and the complete static fallback.

## 7.4 Roadmap, architecture, and plan reconciliation

After the joint Release succeeds:

- remove the completed **Firefox AMO Signing and Distribution** Roadmap entry;
- keep **Public Browser Store Distribution** and rewrite it to start from the now-available
  unlisted Linux Firefox beta;
- remove stale dependencies that say Firefox is unsigned or signing is deferred;
- update Plan 13 and its evidence record to describe the completed two-phase workflow and signed
  proof rather than a future tag-time gate;
- update testing guidance so signed Stable/ESR and cross-browser proof remains local and the commit
  status is the publication handoff; and
- search all non-historical product documentation for superseded development-only, unsigned,
  future-XPI, or tag-time-signing language.

Do not rewrite unrelated historical facts in TDD evidence. Clearly distinguish “planned at the
time” from current canonical behavior when history must remain.

## 7.5 Release skill

Update `.codex/skills/release-browser-extension/SKILL.md` so a future agent:

1. reads current repository workflow, scripts, manifests, tags, Releases, and docs before trusting
   the skill;
2. treats candidate signing and publication as separate phases;
3. uses explicit run IDs and exact commit equality;
4. runs the complete local matrix, including both heavyweight Coordination Server proofs;
5. requires the signed-candidate proof status before tagging;
6. never signs at tag time or publishes untested replacement bytes;
7. resumes pending AMO review by exact add-on ID/version;
8. chooses a new version after changed bytes, rejection remediation, or signed-browser failure;
9. updates public browser-distribution copy and Roadmap state;
10. verifies every public asset and checksum independently;
11. deploys staging only when separately in scope; and
12. keeps reference deployment details in the local override rather than portable skill text.

Update `agents/openai.yaml` so its prompt covers candidate signing, local signed proof, joint
publication, and recovery. Keep the skill concise and under 500 lines. Do not add a README,
changelog, redundant reference, or host-specific asset to the skill.

Validate the skill with the installed skill-creator `quick_validate.py`. Local policy prohibits
subagent forward-testing, so rely on workflow regression tests and the real `v0.1.10` execution as
the forward test.

# 8. Test-Driven Implementation Sequence

Follow this order. Do not create the AMO candidate until all repository changes and local unsigned
gates pass.

## Task 1: Lock workflow behavior in tests

Extend release-workflow tests first. Red tests SHALL prove:

- validate-only dispatch never enters candidate signing;
- candidate signing requires the exact operation and enabled variable;
- tag runs cannot enter candidate signing;
- Chrome-only publication remains available only while signing is disabled;
- joint publication requires a successful local-proof status;
- joint publication downloads a run-scoped candidate artifact;
- hosted workflows contain no Playwright, Selenium, browser download, or `test:e2e` command;
- tag jobs contain no AMO secrets, `web-ext sign`, or AMO API URL;
- missing credentials fail before AMO requests;
- missing, malformed, stale, wrong-commit, wrong-workflow, validate-only, pending, or failed statuses
  block publication; and
- exact Release notes remain Chrome-only or joint according to the publisher.

## Task 2: Implement strict provenance

Add repository-owned provenance construction and decoding with unit tests for:

- exact positive manifest;
- extra/missing key rejection;
- repository, SHA, SemVer, tag, add-on ID, run URL, filename, and digest validation;
- path traversal and non-basename rejection;
- uppercase, truncated, or non-hex digest rejection;
- candidate run from another repository rejection; and
- digest mismatch after artifact transfer.

Use the metadata script's existing SemVer and artifact naming rules rather than defining a second
incompatible version grammar.

## Task 3: Split candidate signing from tag publication

Implement dispatch inputs, candidate conditions, resumability validation, candidate artifact
creation, and the tag-time proof import. Make workflow contract tests green.

Retain synthetic signing-script tests for:

- absent, pending, signed, rejected, listed, malformed, and HTTP failure responses;
- no duplicate submission after an exact version appears;
- AMO-reported SHA-256 mismatch;
- signed payload mutation;
- missing signature entries; and
- pending timeout with an actionable resume message.

## Task 4: Implement the local verifier

Write subprocess and GitHub adapters so unit tests can use temporary repositories, fixture
artifacts, and fake executables without contacting GitHub, AMO, or real browsers.

Test:

- strict `--run-id`;
- clean `main` and remote equality;
- absent tag and Release;
- exact run identity and conclusion;
- candidate artifact selection;
- provenance, checksum, manifest, signature, and payload verification;
- pending before browser commands;
- Stable and ESR invocation;
- signed-XPI environment propagation;
- complete cross-browser invocation;
- failure status on either command;
- no success after partial proof; and
- success payload context, description, target URL, SHA, and ordering.

Then run it once against the real successful `v0.1.10` candidate. That live execution is required;
synthetic tests do not replace it.

## Task 5: Update version, public surfaces, and documentation

Bump `0.1.10`, update public artifact references, revise release notes, site copy, guide, Roadmap,
Plan 13/current evidence, testing guidance, and the release skill.

Run formatters owned by each file type. Browser-extension JavaScript, TypeScript, JSON, and CSS
remain Biome-owned. Markdown, workflow YAML, and other Prettier-owned files use the root Prettier
configuration.

Render the changed landing states, update only intentionally changed baselines, and inspect the
actual images. Do not accept snapshot updates without viewing them.

## Task 6: Prove and push the exact candidate

Run the complete pre-release matrix in Section 9. Resolve every failure. Review ignored files and
the complete staged diff. Commit with the repository's Conventional Commit style and push `main`.

Re-fetch and require:

```text
local HEAD == origin/main
working tree == clean
package version == 0.1.10
remote tag v0.1.10 == absent
GitHub Release v0.1.10 == absent
```

## Task 7: Sign and prove the candidate

Dispatch `sign-firefox-candidate` on `main`. Record the returned run ID. Monitor through success.
If pending, rerun the same operation and pass the prior run ID when its upload identity is needed.

Run the exact local verifier with the successful candidate run ID. Require the latest proof status
on `HEAD` to be `success`.

## Task 8: Tag and publish

Re-run the clean-tree, remote-equality, version, tag-absence, Release-absence, proof-status, and
candidate-artifact preflights.

Create:

```bash
git tag -a v0.1.10 -m "AWSM browser extension v0.1.10"
git push origin refs/tags/v0.1.10
```

Push only the tag. Monitor the browser release workflow. Do not create a Release manually while it
runs.

After success, download all four Release assets into a fresh temporary directory and independently
verify:

- both checksum files;
- ZIP and XPI integrity;
- exactly one root manifest in each browser package;
- manifest version `0.1.10`;
- permanent Firefox add-on ID;
- Mozilla signature entries;
- signed payload equivalence;
- public, non-draft, non-prerelease Release state; and
- annotated tag peeled commit equal to the proven candidate commit.

## Task 9: Reconcile completion and stage the public site

Complete the Roadmap and current-document reconciliation only when the joint Release and assets are
verified. If those edits were already present in the tagged candidate, confirm their claims now
match external state; do not create an untested post-tag application change.

Deploy the exact tagged source, not a later `main`, to the configured isolated staging environment.
Reference-adapter details belong in the ignored `AGENTS.override.md`, not this public plan.

Portable staging requirements:

1. re-inspect deployed topology and isolation;
2. preserve the current source and application image as a recoverable rollback;
3. install the exact tag source without copying local ignored files;
4. rebuild and replace only the staging application service;
5. do not recreate databases, Redis, queues, opaque storage, credentials, or ingress;
6. verify origin liveness and readiness before cache mutation;
7. verify the rendered Firefox copy and latest-Release link at the origin;
8. dry-run and then perform the separately authorized exact-URL shared-cache purge;
9. warm `/`, `/privacy`, `/security`, and `/glossary`;
10. require successful public responses, expected cache headers, cache hits, and correct Release
    assets; and
11. restore the preserved staging source/image if health or rendered verification fails.

Never infer permission to deploy, purge, restart, inspect credentials, or change production.

# 9. Verification Matrix

Run every command against the final candidate content. A hosted success does not replace a local
gate.

## 9.1 Formatting and static review

```bash
corepack pnpm exec prettier --check \
  .github/workflows/chrome-extension-release.yml \
  .codex/skills/release-browser-extension/SKILL.md \
  README.md \
  ROADMAP.md \
  docs/guides/install-firefox-extension.md \
  docs/plans/19-two-phase-firefox-signing-and-distribution.md
corepack pnpm lint
corepack pnpm typecheck
git diff --check
```

Also:

- validate the release skill with skill-creator `quick_validate.py`;
- inspect `git status --short --ignored`;
- prove no credential, `.env`, AMO response, upload UUID, generated package, browser profile,
  screenshot trace, or local operational file is staged; and
- review the complete staged diff, not only its summary.

## 9.2 Repository tests and packages

```bash
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
corepack pnpm zip
```

Require:

- release/workflow unit tests pass;
- production Chrome and Firefox builds pass static verifiers;
- `web-ext lint` passes with only explicitly documented platform warnings;
- deterministic Firefox unsigned ZIP reproduction passes;
- Firefox source ZIP contains reviewable source and build inputs;
- both browser archives contain the exact current version; and
- stale archives cannot contaminate selection.

## 9.3 Local browser tests

```bash
corepack pnpm test:e2e:chrome
corepack pnpm test:e2e:firefox
corepack pnpm test:e2e:cross-browser
corepack pnpm test:e2e:design
```

Then run the new signed candidate verifier with its explicit successful run ID.

The unsigned Firefox and cross-browser commands prove current source before AMO submission. The
signed verifier separately proves the exact Mozilla-signed file that publication will attach.

View the changed Firefox installation and FAQ screenshots at primary and narrow widths. Confirm
contrast, wrapping, focus, button dimensions, static no-JavaScript visibility, and absence of
unintended layout movement.

## 9.4 Coordination Server and public-site tests

Run the full Rails suite through the repository Compose service:

```bash
docker compose exec -T coordination-server env RAILS_ENV=test bundle exec rspec
```

At minimum, require focused public landing, public cache, link, and no-JavaScript assertions before
the full suite.

Run both heavyweight local-only proofs:

```bash
corepack pnpm test:sync-proof
corepack pnpm test:e2e:coordination
```

These proofs must remain local. Do not add either to hosted CI.

## 9.5 Hosted and staging evidence

Require:

- validate-only dispatch: success, no AMO job, no Release;
- candidate dispatch: exact SHA, success, candidate artifact and provenance;
- local proof status: latest exact context is success;
- tag workflow: success, no AMO traffic, exact candidate artifact import;
- GitHub Release: four exact assets, correct visibility and tag;
- staging origin: healthy and ready;
- staging public pages: correct signed-Firefox and Search copy;
- latest Release link: resolves to `v0.1.10`;
- XPI/checksum links: downloadable and valid; and
- shared cache: exact canonical pages warmed and returning expected hits.

# 10. Failure and Recovery Rules

| Failure                                   | Required response                                                     |
| ----------------------------------------- | --------------------------------------------------------------------- |
| Signing variable disabled                 | Candidate dispatch fails clearly; tag uses Chrome-only path           |
| Missing AMO secret                        | Fail before AMO request; reveal no value                              |
| AMO version absent                        | Submit exact unlisted package and source                              |
| AMO pending                               | No candidate XPI or Release; rerun exact version                      |
| AMO rejected                              | No tag or Release; inspect safe validator summary and use new version |
| Candidate digest/signature mismatch       | Fail; preserve evidence; do not test or tag                           |
| Candidate run does not match `HEAD`       | Fail before status creation                                           |
| Stable, ESR, or cross-browser failure     | Latest proof status failure; fix and use new version if bytes change  |
| Verifier interrupted                      | Pending status blocks publication                                     |
| Missing/stale/wrong proof status          | Tag publisher fails before Release creation                           |
| Candidate artifact expired                | Rerun candidate retrieval and full local proof before tagging         |
| Tag workflow fails before Release         | Inspect exact failure; do not create a manual competing Release       |
| Release already exists                    | Stop; never overwrite or recreate it                                  |
| Published asset verification fails        | Report release blocker; do not deploy staging                         |
| Staging build/health/render check fails   | Restore retained staging source/image; leave production untouched     |
| Staging cache purge fails                 | Keep healthy origin, report stale CDN state, and do not broaden purge |
| Production target appears in any mutation | Stop immediately                                                      |

Do not weaken a verifier, skip a browser lane, broaden a cache purge, move a tag, or manually
replace an asset to recover from a failure.

# 11. Completion Criteria

This plan is complete only when all are true:

- [ ] workflow tests prove candidate signing and tag publication are separate;
- [ ] validate-only dispatch cannot contact AMO;
- [ ] candidate signing uses the exact commit, version, unsigned archive, and source archive;
- [ ] candidate artifact contains strict non-secret provenance;
- [ ] local verifier tests exact signed bytes in Stable, ESR, and every cross-browser case;
- [ ] latest proof status on the release commit is successful;
- [ ] tag publisher refuses missing, stale, failed, or mismatched proof;
- [ ] tag publisher imports the exact proven run artifact and makes no AMO request;
- [ ] `v0.1.10` joint Release contains four verified assets;
- [ ] published XPI bytes equal locally tested bytes;
- [ ] README, Firefox guide, release notes, landing page, FAQ, and screenshots are factual;
- [ ] stale “unsigned,” “development-only,” “future signed XPI,” and tag-time-signing language is
      removed from current documentation;
- [ ] stale public Search copy is corrected;
- [ ] Firefox signing Roadmap work is removed and store-listing work remains forward-looking;
- [ ] Plan 13/current evidence and testing guidance match the two-phase contract;
- [ ] release skill and UI metadata match the proven workflow and pass validation;
- [ ] all formatting, lint, typecheck, unit, integration, build, package, browser, Rails, design,
      sync-proof, and coordination-E2E gates pass;
- [ ] exact tagged source is healthy and correctly rendered on staging;
- [ ] only staging's four canonical public URLs are purged, warmed, and verified;
- [ ] working tree is clean and pushed commits/tags resolve to the intended commit; and
- [ ] production, production cache, production ingress, production data, and frozen upstream
      repository are unchanged.
