import assert from "node:assert/strict";
import test from "node:test";
import { requestedFirefoxLanes } from "./install-firefox-browsers.mjs";

test("installs both pinned Firefox lanes by default", () => {
  assert.deepEqual(requestedFirefoxLanes([]), ["stable", "esr"]);
});

test("deduplicates explicitly requested Firefox lanes", () => {
  assert.deepEqual(requestedFirefoxLanes(["stable", "stable"]), ["stable"]);
});

test("rejects an unpinned Firefox lane", () => {
  assert.throws(() => requestedFirefoxLanes(["nightly"]), /stable and\/or esr/);
});
