import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../../.github/workflows/chrome-extension-release.yml", import.meta.url),
  "utf8",
);

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `Missing workflow job ${name}.`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/u);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

test("exposes explicit validate-only and Firefox candidate operations", () => {
  assert.match(
    workflow,
    /workflow_dispatch:[\s\S]*?operation:[\s\S]*?default: validate-only[\s\S]*?- validate-only[\s\S]*?- sign-firefox-candidate[\s\S]*?resume_run_id:/u,
  );
  const candidate = job("sign-firefox-candidate");
  assert.match(
    candidate,
    /if: github\.event_name == 'workflow_dispatch' && inputs\.operation == 'sign-firefox-candidate' && vars\.FIREFOX_AMO_SIGNING_ENABLED == 'true'/u,
  );
  assert.match(candidate, /sign-firefox-unlisted\.mjs/u);
  assert.match(candidate, /firefox-candidate-provenance\.mjs create/u);
  assert.match(
    candidate,
    /firefox-candidate-v\$\{\{ needs\.build\.outputs\.version \}\}-\$\{\{ needs\.build\.outputs\.commit \}\}/u,
  );
  assert.match(candidate, /retention-days: 30/u);
  assert.doesNotMatch(candidate, /gh release create/u);
});

test("validates an explicit resumable run before restoring its upload identity", () => {
  const candidate = job("sign-firefox-candidate");
  assert.match(candidate, /inputs\.resume_run_id != ''/u);
  assert.match(candidate, /firefox-proof-status\.mjs validate-resume/u);
  assert.match(candidate, /run-id: \$\{\{ inputs\.resume_run_id \}\}/u);
  assert.match(candidate, /firefox-amo-submission-v/u);
  assert.match(candidate, /if: always\(\)/u);
});

test("keeps Chrome fallback and exact proven joint publication mutually exclusive", () => {
  const chrome = job("publish-chrome");
  const joint = job("publish-joint");
  assert.match(
    chrome,
    /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\) && vars\.FIREFOX_AMO_SIGNING_ENABLED != 'true'/u,
  );
  assert.match(chrome, /cat dist\/chrome-release-notes\.md/u);
  assert.doesNotMatch(chrome, /\.xpi/u);
  assert.match(
    joint,
    /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\) && vars\.FIREFOX_AMO_SIGNING_ENABLED == 'true'/u,
  );
  assert.match(joint, /actions: read/u);
  assert.match(joint, /statuses: read/u);
  assert.match(joint, /firefox-proof-status\.mjs resolve-proof/u);
  assert.match(joint, /run-id: \$\{\{ steps\.proof\.outputs\.run_id \}\}/u);
  assert.match(joint, /firefox-candidate-provenance\.mjs verify/u);
  assert.match(joint, /verify-signed-firefox-xpi\.mjs/u);
  assert.match(joint, /gh release create/u);
  assert.doesNotMatch(joint, /AMO_JWT|sign-firefox-unlisted|web-ext sign|addons\.mozilla/u);
});

test("builds and publishes desktop artifacts with the browser release", () => {
  const desktop = job("desktop-build");
  assert.match(desktop, /strategy:/u);
  assert.match(desktop, /ubuntu-latest/u);
  assert.match(desktop, /windows-latest/u);
  assert.match(desktop, /macos-latest/u);
  assert.match(desktop, /actions\/setup-node@/u);
  assert.match(
    desktop,
    /version=\$\(node --print "require\('\.\/apps\/browser-extension\/package\.json'\)\.version"\)/u,
  );
  assert.match(desktop, /echo "version=\$version" >> "\$GITHUB_OUTPUT"/u);
  assert.match(desktop, /wails@v2\.13\.0/u);
  assert.match(desktop, /Set Wails product version/u);
  assert.match(desktop, /productVersion: process\.env\.VERSION/u);
  assert.match(desktop, /-nsis/u);
  assert.match(desktop, /hdiutil create/u);
  assert.match(desktop, /AppImage/u);
  assert.match(desktop, /appimagetool\/releases\/download\/1\.9\.1/u);
  assert.match(desktop, /shasum -a 256/u);
  assert.match(desktop, /actions\/upload-artifact/u);
  for (const publisher of ["publish-chrome", "publish-joint"]) {
    assert.match(job(publisher), /needs: \[build, desktop-build\]/u);
    assert.match(job(publisher), /DESKTOP_LINUX_NAME/u);
    assert.match(job(publisher), /DESKTOP_WINDOWS_NAME/u);
    assert.match(job(publisher), /DESKTOP_MACOS_NAME/u);
  }
});

test("runs release validation when desktop or public installation surfaces change", () => {
  assert.match(workflow, /apps\/runtime-go\/\*\*/u);
  assert.match(workflow, /docs\/guides\/install-desktop-runtime\.md/u);
  assert.match(workflow, /docs\/guides\/install-chrome-extension\.md/u);
  assert.match(workflow, /docs\/guides\/install-firefox-extension\.md/u);
  assert.match(workflow, /apps\/coordination-server\/app\/views\/\*\*/u);
});

test("fails an explicitly requested candidate when its protected gate is disabled", () => {
  const rejected = job("reject-disabled-firefox-candidate");
  assert.match(
    rejected,
    /inputs\.operation == 'sign-firefox-candidate' && vars\.FIREFOX_AMO_SIGNING_ENABLED != 'true'/u,
  );
  assert.match(rejected, /must be exactly true/u);
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
