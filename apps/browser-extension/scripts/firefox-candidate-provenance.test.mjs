import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  candidateArtifactName,
  candidateRunId,
  createCandidateProvenance,
  decodeCandidateProvenance,
  verifyCandidateProvenance,
} from "./firefox-candidate-provenance.mjs";

const repository = "parasquid/awsm";
const commit = "a".repeat(40);
const version = "0.1.8";
const candidateRunUrl = `https://github.com/${repository}/actions/runs/123456`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "awsm-firefox-candidate-"));
  const unsignedArchive = join(directory, `awsm-firefox-unsigned-v${version}.zip`);
  const sourceArchive = join(directory, `awsm-firefox-source-v${version}.zip`);
  const signedXpi = join(directory, `awsm-firefox-v${version}.xpi`);
  await Promise.all([
    writeFile(unsignedArchive, "unsigned"),
    writeFile(sourceArchive, "source"),
    writeFile(signedXpi, "signed"),
  ]);
  const input = {
    repository,
    commit,
    version,
    candidateRunUrl,
    unsignedArchive,
    sourceArchive,
    signedXpi,
  };
  return { input, candidate: await createCandidateProvenance(input) };
}

test("creates and verifies exact candidate provenance", async () => {
  const { input, candidate } = await fixture();
  assert.equal(candidate.operation, "sign-firefox-candidate");
  assert.equal(candidate.tag, "v0.1.8");
  assert.equal(candidateRunId(candidate.candidateRunUrl, repository), "123456");
  assert.equal(
    candidateArtifactName(version, commit),
    `firefox-candidate-v0.1.8-${"a".repeat(40)}`,
  );
  assert.deepEqual(await verifyCandidateProvenance(candidate, input), candidate);
});

test("rejects extra, missing, mismatched, and unsafe provenance", async () => {
  const { input, candidate } = await fixture();
  assert.throws(() => decodeCandidateProvenance({ ...candidate, unexpected: true }), /keys/u);
  const { signedXpi: _signedXpi, ...missing } = candidate;
  assert.throws(() => decodeCandidateProvenance(missing), /keys/u);
  assert.throws(
    () => decodeCandidateProvenance({ ...candidate, operation: "validate-only" }),
    /operation/u,
  );
  assert.throws(
    () =>
      decodeCandidateProvenance({
        ...candidate,
        signedXpi: { ...candidate.signedXpi, name: "../candidate.xpi" },
      }),
    /unsafe/u,
  );
  assert.throws(
    () =>
      decodeCandidateProvenance({
        ...candidate,
        candidateRunUrl: "https://github.com/other/repository/actions/runs/123456",
      }),
    /repository/u,
  );
  await writeFile(input.signedXpi, "changed");
  await assert.rejects(verifyCandidateProvenance(candidate, input), /digest/u);
});

test("rejects malformed identifiers and digests", async () => {
  const { candidate } = await fixture();
  for (const invalid of [
    { commit: "A".repeat(40) },
    { version: "0.1.08" },
    { tag: "v0.1.9" },
    { repository: "parasquid/awsm/extra" },
    { candidateRunUrl: `${candidateRunUrl}?token=secret` },
    { signedXpi: { ...candidate.signedXpi, sha256: "A".repeat(64) } },
  ]) {
    assert.throws(() => decodeCandidateProvenance({ ...candidate, ...invalid }));
  }
});
