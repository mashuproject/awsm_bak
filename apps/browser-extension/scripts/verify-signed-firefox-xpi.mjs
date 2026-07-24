import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";

const extensionId = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";
const expectedPermissions = ["activeTab", "scripting", "unlimitedStorage", "downloads", "alarms"];
const expectedOptionalOrigins = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];
const expectedDataPermissions = {
  required: ["none"],
  optional: [
    "websiteContent",
    "browsingActivity",
    "authenticationInfo",
    "personallyIdentifyingInfo",
  ],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const xpiPath = process.argv[2];
const unsignedPath = process.argv[3];
assert(
  xpiPath !== undefined && xpiPath !== "" && unsignedPath !== undefined && unsignedPath !== "",
  "Usage: verify-signed-firefox-xpi <signed-xpi> <unsigned-zip>",
);

const archive = await readFile(resolve(xpiPath));
const reader = new ZipReader(new BlobReader(new Blob([archive])));
try {
  const entries = await reader.getEntries();
  const names = entries.map((entry) => entry.filename);
  assert(new Set(names).size === names.length, "Signed XPI contains duplicate paths.");
  assert(
    names.filter((name) => name === "manifest.json").length === 1,
    "Signed XPI must contain one root manifest.json.",
  );
  for (const name of names)
    assert(
      !name.startsWith("/") && !name.split("/").includes(".."),
      `Signed XPI contains an unsafe path: ${name}`,
    );
  for (const signature of ["META-INF/manifest.mf", "META-INF/mozilla.sf", "META-INF/mozilla.rsa"])
    assert(names.includes(signature), `Signed XPI is missing ${signature}.`);

  const manifestEntry = entries.find((entry) => entry.filename === "manifest.json");
  assert(manifestEntry?.getData !== undefined, "Signed XPI manifest is unreadable.");
  const manifest = JSON.parse(await manifestEntry.getData(new TextWriter()));
  const packageMetadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert(manifest.manifest_version === 3, "Signed XPI must use Manifest V3.");
  assert(manifest.version === packageMetadata.version, "Signed XPI version changed.");
  assert(
    JSON.stringify(manifest.permissions) === JSON.stringify(expectedPermissions),
    "Signed XPI permissions changed.",
  );
  assert(
    JSON.stringify(manifest.optional_host_permissions) === JSON.stringify(expectedOptionalOrigins),
    "Signed XPI optional origins changed.",
  );
  assert(!("host_permissions" in manifest), "Signed XPI has required origins.");
  const gecko = manifest.browser_specific_settings?.gecko;
  assert(gecko?.id === extensionId, "Signed XPI extension ID changed.");
  assert(gecko?.strict_min_version === "140.0", "Signed XPI minimum Firefox changed.");
  assert(
    manifest.browser_specific_settings?.gecko_android === undefined,
    "Signed desktop Linux XPI claims Firefox for Android compatibility.",
  );
  assert(
    JSON.stringify(gecko?.data_collection_permissions) === JSON.stringify(expectedDataPermissions),
    "Signed XPI data permissions changed.",
  );

  const unsignedReader = new ZipReader(
    new BlobReader(new Blob([await readFile(resolve(unsignedPath))])),
  );
  try {
    const unsignedEntries = await unsignedReader.getEntries();
    const signedContent = new Map(
      entries
        .filter((entry) => !entry.directory && !entry.filename.startsWith("META-INF/"))
        .map((entry) => [entry.filename, entry]),
    );
    assert(
      signedContent.size === unsignedEntries.length,
      "Signed XPI payload paths differ from the verified unsigned ZIP.",
    );
    for (const unsignedEntry of unsignedEntries) {
      const signedEntry = signedContent.get(unsignedEntry.filename);
      assert(
        unsignedEntry.getData !== undefined && signedEntry?.getData !== undefined,
        `Signed XPI payload is unreadable: ${unsignedEntry.filename}`,
      );
      const [unsignedBytes, signedBytes] = await Promise.all([
        unsignedEntry.getData(new Uint8ArrayWriter()),
        signedEntry.getData(new Uint8ArrayWriter()),
      ]);
      assert(
        Buffer.from(unsignedBytes).equals(Buffer.from(signedBytes)),
        `AMO changed signed payload bytes: ${unsignedEntry.filename}`,
      );
    }
  } finally {
    await unsignedReader.close();
  }
} finally {
  await reader.close();
}

console.log(`Signed Firefox XPI validation passed: ${resolve(xpiPath)}`);
