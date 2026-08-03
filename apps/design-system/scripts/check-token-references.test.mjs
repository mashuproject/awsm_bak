import assert from "node:assert/strict";
import test from "node:test";

import { findUnknownTokenReferences } from "./check-token-references.mjs";

test("accepts references to declared design tokens", () => {
  assert.deepEqual(
    findUnknownTokenReferences(
      ".card { gap: var(--awsm-space-8); color: var(--awsm-ink); }",
      new Set(["--awsm-space-8", "--awsm-ink"]),
    ),
    [],
  );
});

test("reports references to undeclared design tokens", () => {
  assert.deepEqual(
    findUnknownTokenReferences(
      ".card { gap: var(--awsm-space-10); }",
      new Set(["--awsm-space-8"]),
    ),
    ["--awsm-space-10"],
  );
});
