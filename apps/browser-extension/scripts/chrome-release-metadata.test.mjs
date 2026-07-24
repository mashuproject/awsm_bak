import assert from "node:assert/strict";
import test from "node:test";

import { releaseMetadata, renderReleaseNotes } from "./chrome-release-metadata.mjs";

const repository = "parasquid/awsm";

test("returns stable release metadata with exact asset names and guide URL", () => {
  assert.deepEqual(
    releaseMetadata({
      version: "0.1.0",
      eventName: "push",
      refName: "v0.1.0",
      repository,
    }),
    {
      version: "0.1.0",
      tag: "v0.1.0",
      prerelease: false,
      archiveName: "awsm-chrome-v0.1.0.zip",
      checksumName: "awsm-chrome-v0.1.0.zip.sha256",
      firefoxXpiName: "awsm-firefox-v0.1.0.xpi",
      firefoxChecksumName: "awsm-firefox-v0.1.0.xpi.sha256",
      firefoxSourceName: "awsm-firefox-source-v0.1.0.zip",
      guideUrl:
        "https://github.com/parasquid/awsm/blob/v0.1.0/docs/guides/install-chrome-extension.md",
      firefoxGuideUrl:
        "https://github.com/parasquid/awsm/blob/v0.1.0/docs/guides/install-firefox-extension.md",
    },
  );
});

test("classifies a SemVer suffix as a prerelease", () => {
  assert.equal(
    releaseMetadata({
      version: "0.1.0-rc.1",
      eventName: "push",
      refName: "v0.1.0-rc.1",
      repository,
    }).prerelease,
    true,
  );
});

test("manual runs derive metadata without requiring a matching ref", () => {
  const metadata = releaseMetadata({
    version: "0.1.0",
    eventName: "workflow_dispatch",
    refName: "main",
    repository,
  });

  assert.equal(metadata.tag, "v0.1.0");
});

test("rejects a mismatched push tag", () => {
  assert.throws(
    () =>
      releaseMetadata({
        version: "0.1.0",
        eventName: "push",
        refName: "v0.1.1",
        repository,
      }),
    /tag mismatch/,
  );
});

for (const version of [
  "1",
  "1.2",
  "01.2.3",
  "1.02.3",
  "1.2.03",
  "1.2.3+build",
  "1.2.3-rc.01",
  "1.2.3-",
  " 1.2.3",
]) {
  test(`rejects malformed version ${JSON.stringify(version)}`, () => {
    assert.throws(
      () =>
        releaseMetadata({
          version,
          eventName: "workflow_dispatch",
          refName: "main",
          repository,
        }),
      /invalid version/,
    );
  });
}

for (const invalidRepository of [
  "parasquid",
  "parasquid/awsm/extra",
  "https://github.com/parasquid/awsm",
  "parasquid /awsm",
  "parasquid/awsm?tab=readme",
  "parasquid/awsm#readme",
]) {
  test(`rejects malformed repository ${JSON.stringify(invalidRepository)}`, () => {
    assert.throws(
      () =>
        releaseMetadata({
          version: "0.1.0",
          eventName: "workflow_dispatch",
          refName: "main",
          repository: invalidRepository,
        }),
      /invalid repository/,
    );
  });
}

test("rejects unsupported events", () => {
  assert.throws(
    () =>
      releaseMetadata({
        version: "0.1.0",
        eventName: "pull_request",
        refName: "main",
        repository,
      }),
    /unsupported event/,
  );
});

test("renders Chrome and Firefox installation guidance and one trailing newline", () => {
  const metadata = releaseMetadata({
    version: "0.1.0",
    eventName: "workflow_dispatch",
    refName: "main",
    repository,
  });
  const notes = renderReleaseNotes(metadata);

  for (let step = 1; step <= 7; step += 1) {
    assert.match(notes, new RegExp(`^${step}\\. `, "m"));
  }
  assert.match(notes, /`awsm-chrome-v0\.1\.0\.zip`/);
  assert.match(notes, /`awsm-chrome-v0\.1\.0\.zip\.sha256`/);
  assert.match(notes, /`awsm-firefox-v0\.1\.0\.xpi`/);
  assert.match(notes, /`awsm-firefox-v0\.1\.0\.xpi\.sha256`/);
  assert.match(notes, new RegExp(`\\]\\(${metadata.guideUrl.replaceAll(".", "\\.")}\\)`));
  assert.match(notes, new RegExp(`\\]\\(${metadata.firefoxGuideUrl.replaceAll(".", "\\.")}\\)`));
  assert.equal(notes.endsWith("\n"), true);
  assert.equal(notes.endsWith("\n\n"), false);
});
