---
name: release-browser-extension
description: Safely prepare, validate, publish, and verify a tag-driven browser-extension GitHub Release while keeping real-browser proof local. Use when cutting an AWSM extension release, bumping its release version, recovering from a failed unpublished release run, validating packaged Chrome or Firefox artifacts, or confirming that a staging site points to the published release.
---

# Release Browser Extension

Release the browser extension from an exact reviewed commit. Keep expensive real-browser proof
local and let hosted automation perform reproducible source checks, packaging, checksums, and
publication.

## Establish authority and scope

1. Read the repository-root `AGENTS.md` and every applicable override completely.
2. Inspect the current branch, remotes, working tree, package version, tags, Releases, release
   documentation, workflow, and package scripts. Never infer them from an earlier release.
3. Identify the authorized repository and branch. Distinguish a working fork from upstream and
   staging from production. Honor freezes and branch-switch approval rules.
4. Confirm that the user's request authorizes public tag and Release creation. Treat deployment,
   cache purge, upstream push, and production mutation as separate scopes.
5. Use the repository-pinned package manager and existing release workflow. Do not replace a
   tag-driven publisher with an ad hoc manual Release.

Never print or retain tokens, OAuth callbacks, credentials, account or zone identifiers, private
deployment configuration, user data, or full infrastructure inventories. Keep repository guidance
portable; do not add reference-deployment domains, host aliases, paths, or account topology as
application defaults.

## Choose the version

Resolve the next version from all of:

- the extension package version;
- existing remote tags and GitHub Releases;
- versioned public download links;
- the repository's SemVer and prerelease rules; and
- the user's intended downstream or upstream promotion.

Never guess when these disagree. Never move, delete, recreate, or overwrite a published tag or
Release. For a failed tag with no Release, explain the state and obtain explicit approval before
deleting or recreating it. Prefer a new version when the user wants an immutable audit trail.

Update every owned version and public artifact reference together. Do not change unrelated fixture
versions that merely exercise version-shaped data.

## Prepare the exact release commit

1. Make only release-required source, workflow, test, and documentation changes.
2. Keep hosted CI free of Playwright, Selenium, browser downloads, browser matrices, scheduled
   browser jobs, and live cross-browser proof unless the user explicitly accepts that quota cost.
3. Preserve inexpensive hosted gates: dependency installation, lint, typecheck, unit tests,
   production builds, archive validation, checksums, and Release publication.
4. Ensure packaging removes only known generated versioned archives before building. Never use a
   broad destructive cleanup.
5. Run applicable formatters and static checks.
6. Inspect ignored files, stage only intended files, review the complete staged diff, and commit
   with the repository's commit convention.

Do not tag a dirty tree or an unpushed commit. Do not place generated archives, credentials, test
profiles, logs, or operational evidence in the commit.

## Prove the release locally

Run the repository-declared local release gates against the exact content that will be tagged:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm zip
corepack pnpm --filter @awsm/browser-extension test:e2e:cross-browser
```

Discover and follow newer repository commands when manifests differ. Require:

- all unit and release-workflow tests to pass;
- Chrome and Firefox production builds to pass static release validation;
- archives to contain the expected root manifest and current version;
- stale archives not to contaminate package selection; and
- every local live Chrome-to-Firefox and Firefox-to-Chrome scenario to pass.

If a gate fails, diagnose it. Do not bypass, skip, weaken, or move it into hosted CI merely to
publish. Fix the source, rerun the affected checks, create a new commit, and rerun the local browser
gate on the final content.

## Publish

1. Push the exact release commit to the authorized repository.
2. Re-fetch and prove local `HEAD` equals the intended remote branch.
3. Prove the target tag and Release do not already exist.
4. Create the matching annotated `v<version>` tag on that commit and push only that tag.
5. Monitor the repository's release workflow through completion.

Do not create a second Release manually while the workflow is running. If the workflow fails,
inspect the failed step and confirm no Release was published before planning recovery. Cancel
unnecessary hosted browser jobs promptly if an older workflow unexpectedly starts them.

## Verify publication

Download the published archive and checksum into a fresh temporary directory. Verify:

- the checksum succeeds;
- the archive passes integrity testing;
- the root manifest reports the released version;
- the GitHub Release is public, non-draft, and has the expected assets; and
- the tag resolves to the intended commit.

If staging is in scope, inspect its rendered release link. Prefer a repository-level
`/releases/latest` link when that is the established contract, confirm it resolves to the new
Release, and verify the page's expected CDN cache status. Do not deploy or purge merely because a
generic latest-Release redirect changed; mutate staging only when its source or configuration
actually requires it. Never touch production without separate explicit authorization.

Finish by reporting the version, Release URL, tagged commit, artifact and checksum verification,
local browser results, hosted workflow result, staging result when applicable, commits pushed, and
working-tree state.
