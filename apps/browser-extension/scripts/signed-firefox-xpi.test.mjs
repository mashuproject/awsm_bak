import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";

const execute = promisify(execFile);
const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const manifest = JSON.stringify({
  manifest_version: 3,
  version: packageMetadata.version,
  permissions: ["activeTab", "scripting", "unlimitedStorage", "downloads", "alarms"],
  optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  browser_specific_settings: {
    gecko: {
      id: "{f6f49704-8d53-4eda-aef7-619ab88dda5f}",
      strict_min_version: "140.0",
      data_collection_permissions: {
        required: ["none"],
        optional: [
          "websiteContent",
          "browsingActivity",
          "authenticationInfo",
          "personallyIdentifyingInfo",
        ],
      },
    },
  },
});

async function archive(entries) {
  const writer = new ZipWriter(new BlobWriter("application/zip"));
  for (const [name, value] of entries) await writer.add(name, new TextReader(value));
  return Buffer.from(await (await writer.close()).arrayBuffer());
}

test("accepts AMO manifest reserialization but rejects semantic or payload mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "awsm-signed-xpi-"));
  const unsignedPath = join(directory, "unsigned.zip");
  const signedPath = join(directory, "signed.xpi");
  await writeFile(unsignedPath, await archive([["manifest.json", manifest]]));
  await writeFile(
    signedPath,
    await archive([
      ["manifest.json", manifest],
      ["META-INF/manifest.mf", "manifest"],
      ["META-INF/mozilla.sf", "signature"],
      ["META-INF/mozilla.rsa", "certificate"],
    ]),
  );

  const result = await execute(
    process.execPath,
    [new URL("verify-signed-firefox-xpi.mjs", import.meta.url).pathname, signedPath, unsignedPath],
    { encoding: "utf8" },
  );
  assert.match(result.stdout, /validation passed/u);

  const { manifest_version: manifestVersion, ...reorderedManifest } = JSON.parse(manifest);
  await writeFile(
    signedPath,
    await archive([
      [
        "manifest.json",
        `${JSON.stringify({ ...reorderedManifest, manifest_version: manifestVersion })} `,
      ],
      ["META-INF/manifest.mf", "manifest"],
      ["META-INF/mozilla.sf", "signature"],
      ["META-INF/mozilla.rsa", "certificate"],
    ]),
  );
  await execute(
    process.execPath,
    [new URL("verify-signed-firefox-xpi.mjs", import.meta.url).pathname, signedPath, unsignedPath],
    { encoding: "utf8" },
  );

  const changedManifest = JSON.stringify({ ...JSON.parse(manifest), name: "Changed by signer" });
  await writeFile(
    signedPath,
    await archive([
      ["manifest.json", changedManifest],
      ["META-INF/manifest.mf", "manifest"],
      ["META-INF/mozilla.sf", "signature"],
      ["META-INF/mozilla.rsa", "certificate"],
    ]),
  );
  await assert.rejects(
    execute(process.execPath, [
      new URL("verify-signed-firefox-xpi.mjs", import.meta.url).pathname,
      signedPath,
      unsignedPath,
    ]),
    /changed signed manifest semantics/u,
  );

  await writeFile(
    unsignedPath,
    await archive([
      ["manifest.json", manifest],
      ["payload.js", "a"],
    ]),
  );
  await writeFile(
    signedPath,
    await archive([
      ["manifest.json", manifest],
      ["payload.js", "b"],
      ["META-INF/manifest.mf", "manifest"],
      ["META-INF/mozilla.sf", "signature"],
      ["META-INF/mozilla.rsa", "certificate"],
    ]),
  );
  await assert.rejects(
    execute(process.execPath, [
      new URL("verify-signed-firefox-xpi.mjs", import.meta.url).pathname,
      signedPath,
      unsignedPath,
    ]),
    /changed signed payload bytes/u,
  );
});
