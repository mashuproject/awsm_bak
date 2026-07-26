import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../../.github/workflows/chrome-extension-release.yml", import.meta.url),
  "utf8",
);

test("keeps Chrome tags publishable while AMO signing is deferred", () => {
  assert.match(
    workflow,
    /sign-firefox:[\s\S]*?if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\) && vars\.FIREFOX_AMO_SIGNING_ENABLED == 'true'/u,
  );
  assert.match(
    workflow,
    /publish-chrome:[\s\S]*?if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\) && vars\.FIREFOX_AMO_SIGNING_ENABLED != 'true'/u,
  );
  assert.match(
    workflow,
    /publish-joint:[\s\S]*?if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\) && vars\.FIREFOX_AMO_SIGNING_ENABLED == 'true'/u,
  );
  assert.match(workflow, /cat dist\/chrome-release-notes\.md/u);
  assert.doesNotMatch(workflow, /Require the protected Firefox signing gate for tags/u);
});

test("keeps hosted CI free of real-browser lanes", () => {
  assert.match(workflow, /branches:\s+- main/u);
  assert.match(
    workflow,
    /build:[\s\S]*?if: github\.event_name == 'workflow_dispatch' \|\| \(github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)\)/u,
  );
  assert.doesNotMatch(workflow, /playwright install/u);
  assert.doesNotMatch(workflow, /test:e2e/u);
  assert.doesNotMatch(workflow, /firefox-nightly:|cross-browser-nightly:/u);
  assert.doesNotMatch(workflow, /^\s+schedule:/mu);
});
