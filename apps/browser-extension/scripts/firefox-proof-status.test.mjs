import assert from "node:assert/strict";
import test from "node:test";

import {
  FIREFOX_PROOF_CONTEXT,
  RELEASE_WORKFLOW_PATH,
  runIdFromStatus,
  selectLatestProofStatus,
  validateCandidateWorkflowRun,
  validateResumeWorkflowRun,
} from "./firefox-proof-status.mjs";

const repository = "parasquid/awsm";
const commit = "a".repeat(40);
const runId = "123456";
const targetUrl = `https://github.com/${repository}/actions/runs/${runId}`;
const run = {
  id: Number(runId),
  event: "workflow_dispatch",
  head_sha: commit,
  status: "completed",
  conclusion: "success",
  path: RELEASE_WORKFLOW_PATH,
  html_url: targetUrl,
};

test("selects the latest exact successful proof and validates its run", () => {
  const status = selectLatestProofStatus([
    { context: "other/check", state: "failure" },
    { context: FIREFOX_PROOF_CONTEXT, state: "success", target_url: targetUrl },
    { context: FIREFOX_PROOF_CONTEXT, state: "failure", target_url: targetUrl },
  ]);
  assert.equal(runIdFromStatus(status, repository), runId);
  assert.equal(validateCandidateWorkflowRun(run, { repository, commit, runId }), run);
});

test("rejects missing, non-successful, foreign, or malformed statuses", () => {
  assert.throws(() => selectLatestProofStatus([]), /missing/u);
  for (const state of ["pending", "failure", "error"]) {
    assert.throws(
      () =>
        selectLatestProofStatus([{ context: FIREFOX_PROOF_CONTEXT, state, target_url: targetUrl }]),
      new RegExp(state, "u"),
    );
  }
  for (const invalid of [
    "https://github.com/other/repository/actions/runs/123456",
    `${targetUrl}?token=secret`,
    "https://example.test/parasquid/awsm/actions/runs/123456",
  ]) {
    assert.throws(() =>
      runIdFromStatus(
        { context: FIREFOX_PROOF_CONTEXT, state: "success", target_url: invalid },
        repository,
      ),
    );
  }
});

test("rejects a candidate run with any mismatched identity or outcome", () => {
  for (const mutation of [
    { id: 654321 },
    { event: "push" },
    { head_sha: "b".repeat(40) },
    { status: "in_progress" },
    { conclusion: "failure" },
    { path: ".github/workflows/other.yml" },
    { html_url: "https://github.com/parasquid/awsm/actions/runs/654321" },
  ]) {
    assert.throws(() =>
      validateCandidateWorkflowRun({ ...run, ...mutation }, { repository, commit, runId }),
    );
  }
});

test("accepts a completed matching failed run only for upload-identity resumption", () => {
  const failed = { ...run, conclusion: "failure" };
  assert.equal(validateResumeWorkflowRun(failed, { repository, commit, runId }), failed);
  for (const mutation of [
    { id: 654321 },
    { event: "push" },
    { head_sha: "b".repeat(40) },
    { status: "in_progress" },
    { path: ".github/workflows/other.yml" },
    { html_url: "https://github.com/parasquid/awsm/actions/runs/654321" },
  ]) {
    assert.throws(() =>
      validateResumeWorkflowRun({ ...failed, ...mutation }, { repository, commit, runId }),
    );
  }
});
