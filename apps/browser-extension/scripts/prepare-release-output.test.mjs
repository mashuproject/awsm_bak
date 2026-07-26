import assert from "node:assert/strict";
import test from "node:test";
import { isGeneratedReleaseArchive } from "./prepare-release-output.mjs";

test("recognizes only generated browser release archives", () => {
  assert.equal(isGeneratedReleaseArchive("awsmbrowser-extension-0.1.6-chrome.zip"), true);
  assert.equal(isGeneratedReleaseArchive("awsmbrowser-extension-0.1.6-firefox.zip"), true);
  assert.equal(isGeneratedReleaseArchive("awsmbrowser-extension-0.1.6-sources.zip"), true);
  assert.equal(isGeneratedReleaseArchive("unrelated.zip"), false);
  assert.equal(isGeneratedReleaseArchive("awsmbrowser-extension-0.1.6-chrome.zip.sha256"), false);
});
