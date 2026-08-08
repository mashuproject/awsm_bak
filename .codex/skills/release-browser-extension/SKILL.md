---
name: release-browser-extension
description: Safely prepare, sign, prove, publish, and verify tag-driven Chrome and Mozilla-signed Firefox browser-extension GitHub Releases while keeping real-browser proof local. Use when cutting an AWSM extension release, running or resuming an unlisted Firefox AMO candidate, recovering from a failed unpublished release, validating packaged Chrome or Firefox artifacts, or confirming that staging points to a published release.
---

# Release Browser Extension

Release one exact reviewed commit through separate Firefox-candidate and publication phases. The
publication includes the public website as well as the browser and desktop artifacts. Keep
real-browser proof local. Let hosted automation build, sign, preserve provenance, enforce proof,
package checksums, and publish only the already-proven bytes.

## Establish authority and current state

1. Read the repository-root `AGENTS.md` and every applicable override completely.
2. Inspect the current branch, remotes, worktree, package version, tags, Releases, workflow,
   release scripts, manifests, public documentation, and repository-declared commands. Treat these
   as authoritative when this skill is stale.
3. Resolve the authorized repository and branch. Distinguish a working fork from upstream and
   staging from production. Honor freezes and branch-switch approval rules.
4. Confirm authorization separately for candidate signing, tag and Release creation, deployment,
   cache mutation, upstream push, and production mutation.
5. Verify only the names and presence of required repository variables and secrets. Never inspect,
   echo, download, transform, persist, or reproduce credential values.

Keep repository guidance portable. Never add private domains, host aliases, deployment paths,
account identifiers, profiles, credentials, or operational topology to tracked source or this
skill.

## Test before choosing the immutable candidate

Freeze the intended code and public website content first. Run the complete applicable local
pre-versioning matrix against that content while the package still has its current version,
including website build, content, design, and rendered checks, plus the affected browser, desktop,
packaging, and integration proofs. Do not bump the package or application version, update
version-bound release references, create a tag, or consume an immutable Firefox/AMO candidate
number while a test or validation gate is failing. Fix the current source and rerun the failing
gate instead.

Only after every applicable pre-versioning gate is green may the candidate version be bumped once.
Then rerun the version-bound packaging, manifest, archive, checksum, and release validation gates
against the exact candidate commit. A failure after the bump but before an external candidate is
consumed is fixed in that same unsubmitted candidate; it does not require burning another version.

## Choose and prepare the immutable candidate

Resolve the version from the package, remote tags and Releases, public download links, SemVer
rules, and the requested promotion. Never move, delete, recreate, or overwrite a published tag or
Release.

Update every owned version, artifact reference, release note, installation guide, public site,
rendered assertion, architecture/testing document, superseded plan, and Roadmap entry together.
The website is part of the release candidate, not optional follow-up work: its copy, distribution
state, download links, and release links must correspond to the exact candidate commit.
Keep the Roadmap forward-looking.

Run all repository-declared gates applicable to the final candidate, including:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
corepack pnpm zip
corepack pnpm test:e2e:chrome
corepack pnpm test:e2e:firefox
corepack pnpm test:e2e:cross-browser
corepack pnpm test:e2e:design
corepack pnpm test:sync-proof
corepack pnpm test:e2e:coordination
```

Discover and follow newer commands when manifests differ. Keep both heavyweight Coordination
Server proofs local; do not add them or real-browser matrices to hosted CI. Validate release
archives, deterministic Firefox packaging, exact manifest version, expected root layout, source
reviewability, and stale-archive exclusion.

Require deterministic bytes for both the unsigned runtime ZIP and the Firefox source ZIP across
filesystem traversal order, timestamps, and host timezones. Run the package-owned verifier without
an extra standalone `--`:

```bash
corepack pnpm --filter @awsm/browser-extension \
  release:firefox:verify-candidate --run-id <candidate-run-id>
```

Before any AMO submission, prove every unsigned Firefox behavior that is locally reproducible in
the repository-pinned Stable and ESR lanes and in the complete unsigned Chrome/Firefox suite.
Exercise all affected permission, login, unlock, Capture, Export/Import, and synchronization paths,
and resolve product or harness failures before consuming an AMO version. After signing, prove the
signed candidate's retained-profile restart and returning-Device flows and run the complete signed
cross-browser suite before creating a tag or Release. Signing validates final bytes; it is not the
first functional Firefox test or a substitute for local proof.

When signed proof fails, close the entire defect class before consuming another AMO version:

1. identify the underlying browser/runtime boundary instead of naming only the observed symptom;
2. search all production code and test harnesses for analogous operations and sibling call paths;
3. inspect every match and document why it is affected or safe;
4. fix all affected sites, not merely the first stack location;
5. add the lowest-layer regression that exposes the mechanism and an end-to-end regression that
   crosses the exact persistence, restart, permission, or packaging boundary; and
6. rerun the complete unsigned matrix from rebuilt bytes.

One repaired scenario, a Chrome-only pass, or a unit test with mocked browser storage is not closure
evidence. Do not submit the next immutable candidate until the audit and all unsigned gates pass.

Inspect all changed rendered states at primary and narrow widths. Run applicable formatters,
static checks, and skill validation. Stage only intended files, review the complete staged diff,
commit, push the exact candidate, fetch, and prove local `HEAD` equals the authorized remote branch.
Do not commit generated packages, profiles, logs, credentials, screenshots, or local evidence.

## Phase 1: obtain the exact signed Firefox candidate

1. Prove the target tag and Release do not exist.
2. Manually dispatch the workflow's candidate-signing operation on the exact pushed commit.
3. Record the explicit workflow run ID. Never infer a candidate from “latest,” a version alone, or
   another branch.
4. If AMO review is pending, retain the same version and resume through that exact run's
   non-secret upload identity. Query the permanent add-on ID and exact version; never resubmit
   changed bytes.
5. Require the candidate artifact to bind repository, full commit, version, intended tag,
   operation, permanent add-on ID, candidate run URL, unsigned archive hash, source archive hash,
   signed XPI name, and signed XPI hash.
6. Download and validate the run-scoped signed artifact. Permit only semantic-equivalent
   `manifest.json` reserialization by AMO; reject semantic manifest drift, any other payload
   mutation, missing signatures, checksum mismatch, path ambiguity, or provenance mismatch.

Candidate signing creates no tag or Release. If source or package bytes change, AMO remediation
changes bytes, or signed-browser proof exposes a defect, choose a new patch version and repeat from
a new immutable candidate.

## Prove the signed bytes locally

Run the repository's signed-candidate verifier with the explicit successful candidate run ID. It
must:

- require a clean authorized branch whose `HEAD` equals the remote branch;
- prove the tag and Release are still absent;
- validate the workflow identity, repository, exact commit, run URL, operation, and provenance;
- reproduce and compare the unsigned package and source archive;
- validate the exact Mozilla-signed XPI and checksum;
- run that XPI in repository-pinned Firefox Stable and ESR;
- run both Chrome-to-Firefox and Firefox-to-Chrome synchronization directions; and
- write the configured commit-status context on the exact candidate commit.

For signed retained-profile restart proof, restart the browser with the same profile and verify the
persisted WebExtension policy is active. Do not reinstall the signed XPI after restart:
reinstallation would conceal persistence defects and can corrupt the proof boundary.

A pending or failed local run must not leave a success status. The success status target URL must
identify the exact candidate run without exposing local paths, test data, or secrets.

## Phase 2: tag and publish

1. Resolve the exact successful proof status on the candidate commit and validate its target
   workflow run, repository, workflow path, event, conclusion, and commit.
2. Create the explicitly authorized annotated `v<version>` tag on that exact commit and push only
   that tag.
3. Monitor the tag workflow. It must not contact AMO or sign new bytes.
4. Require the joint publisher to download the candidate artifact from the proof-bound run,
   validate provenance again, and publish that exact XPI beside the current Chrome ZIP and
   checksums.
5. Retain the explicit Chrome-only publisher only when Firefox signing is exactly disabled.

Do not create a second Release manually while automation is running. If a tag workflow fails,
inspect the failure and prove whether a Release exists before recovery. A failed tag without a
Release requires explicit recovery authority; prefer a new version when preserving an immutable
audit trail.

## Verify publication and website

Independently inspect the public non-draft, non-prerelease Release and exact tag commit. Download
each published asset and checksum into a fresh temporary directory; verify checksums, archive
integrity, root manifests, released version, Firefox signature, and exact expected asset set.

Publish the exact verified tag to the explicitly authorized website deployment target. Do not deploy
a dirty worktree or a later unverified commit. Then:

1. re-inspect live topology and isolation;
2. deploy an archive made from the exact verified tag, never a dirty worktree;
3. preserve explicit rollback material;
4. mutate only the authorized staging service;
5. verify origin liveness and readiness before any cache mutation;
6. record the canonical bodies, cache headers, ages, `Vary`, and known custom-key inputs;
7. dry-run and perform the narrowest separately authorized purge;
8. warm every canonical URL repeatedly and require current bodies plus fresh cache behavior across
   the header variants real browsers send;
9. treat neither API success, a single cache miss, nor one current response as eviction proof;
10. when exact-URL purge leaves a proven custom-key or Worker-managed variant stale, obtain new
    explicit authorization before escalating to hostname, prefix, or whole-zone scope;
11. inspect the rendered distribution copy and Release links at primary and narrow widths; and
12. prove production and unrelated cache targets were not changed.

For an authorized staging website target, apply the numbered deployment and cache safeguards above.
For another target, use that target's separately authorized deployment and live-state controls;
release publication alone never grants permission to mutate it.

Finish by reporting the version, Release URL, tagged commit, candidate and tag workflow runs,
proof-status result, artifact and checksum verification, local browser and full test results,
website deployment target and verification result, staging result when applicable, commits pushed,
and final worktree state.
