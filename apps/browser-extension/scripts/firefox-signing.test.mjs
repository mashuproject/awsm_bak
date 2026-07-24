import assert from "node:assert/strict";
import test from "node:test";
import { classifyAmoVersion, versionEndpoint } from "./sign-firefox-unlisted.mjs";

const id = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";

test("addresses one exact encoded AMO add-on version", () => {
  assert.equal(
    versionEndpoint(id, "0.1.5").href,
    "https://addons.mozilla.org/api/v5/addons/addon/%7Bf6f49704-8d53-4eda-aef7-619ab88dda5f%7D/versions/v0.1.5/",
  );
});

test("accepts only the exact signed version response", () => {
  assert.deepEqual(
    classifyAmoVersion(
      {
        version: "0.1.5",
        channel: "unlisted",
        file: {
          status: "public",
          url: "https://addons.mozilla.net/awsm.xpi",
          hash: `sha256:${"a".repeat(64)}`,
        },
      },
      "0.1.5",
    ),
    {
      state: "Signed",
      url: "https://addons.mozilla.net/awsm.xpi",
      hash: `sha256:${"a".repeat(64)}`,
    },
  );
  assert.throws(
    () =>
      classifyAmoVersion(
        {
          version: "0.1.6",
          channel: "unlisted",
          file: {
            status: "public",
            url: "https://addons.mozilla.net/awsm.xpi",
            hash: `sha256:${"a".repeat(64)}`,
          },
        },
        "0.1.5",
      ),
    /mismatched/u,
  );
});

test("keeps pending and rejected AMO states distinct", () => {
  assert.deepEqual(
    classifyAmoVersion(
      {
        version: "0.1.5",
        channel: "unlisted",
        file: { status: "unreviewed" },
      },
      "0.1.5",
    ),
    { state: "Pending" },
  );
  assert.deepEqual(
    classifyAmoVersion(
      {
        version: "0.1.5",
        channel: "unlisted",
        file: { status: "disabled" },
      },
      "0.1.5",
    ),
    { state: "Rejected", status: "disabled" },
  );
});

test("rejects listed and undocumented AMO states", () => {
  assert.throws(
    () =>
      classifyAmoVersion(
        {
          version: "0.1.5",
          channel: "listed",
          file: { status: "unreviewed" },
        },
        "0.1.5",
      ),
    /invalid unlisted/u,
  );
});
