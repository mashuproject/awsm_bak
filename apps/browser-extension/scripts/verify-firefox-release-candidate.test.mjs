import assert from "node:assert/strict";
import test from "node:test";

import { parseRunId, proofStatusPayload } from "./verify-firefox-release-candidate.mjs";

test("requires one explicit positive candidate run ID", () => {
  assert.equal(parseRunId(["--run-id", "123456"]), "123456");
  for (const arguments_ of [
    [],
    ["123456"],
    ["--run-id", "0"],
    ["--run-id", "-1"],
    ["--run-id", "1", "extra"],
    ["--run-id", "latest"],
  ]) {
    assert.throws(() => parseRunId(arguments_), /Usage/u);
  }
});

test("creates bounded exact proof statuses", () => {
  const input = {
    version: "0.1.8",
    digest: "a".repeat(64),
    targetUrl: "https://github.com/parasquid/awsm/actions/runs/123456",
  };
  assert.deepEqual(proofStatusPayload({ ...input, state: "pending" }), {
    state: "pending",
    context: "awsm/firefox-signed-local-proof",
    target_url: input.targetUrl,
    description: "Firefox v0.1.8 signed proof running (aaaaaaaaaaaa)",
  });
  assert.match(
    proofStatusPayload({ ...input, state: "success" }).description,
    /signed proof passed/u,
  );
  assert.match(
    proofStatusPayload({ ...input, state: "failure" }).description,
    /signed proof failed/u,
  );
  assert.throws(() => proofStatusPayload({ ...input, state: "error" }));
  assert.throws(() => proofStatusPayload({ ...input, state: "success", digest: "A".repeat(64) }));
});
