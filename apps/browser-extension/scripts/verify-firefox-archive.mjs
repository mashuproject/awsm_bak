import { readdir, readFile } from "node:fs/promises";
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js";

const root = new URL("../", import.meta.url);
const output = new URL(".output/", root);
const extensionId = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";
const expectedPages = new Set(["library.html", "popup.html", "sync-setup.html"]);
const approvedPermissions = ["activeTab", "scripting", "unlimitedStorage", "downloads", "alarms"];
const approvedOptionalOrigins = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];
const approvedDataCollectionPermissions = {
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

const archiveNames = (await readdir(output)).filter((name) => name.endsWith("-firefox.zip")).sort();
assert(archiveNames.length === 1, `Expected one Firefox ZIP, found ${archiveNames.length}.`);
const sourceArchiveNames = (await readdir(output))
  .filter((name) => name.endsWith("-sources.zip"))
  .sort();
assert(
  sourceArchiveNames.length === 1,
  `Expected one Firefox source ZIP, found ${sourceArchiveNames.length}.`,
);
const archive = await readFile(new URL(archiveNames[0], output));
const reader = new ZipReader(new BlobReader(new Blob([archive])));

try {
  const entries = await reader.getEntries();
  const names = entries.map((entry) => entry.filename);
  assert(
    names.filter((name) => name === "manifest.json").length === 1,
    "The Firefox ZIP must contain one root manifest.json.",
  );
  for (const name of names) {
    assert(!name.startsWith("/") && !name.includes("../"), `Unsafe archive path: ${name}`);
    assert(!name.endsWith(".map"), `Source map packaged in Firefox ZIP: ${name}`);
    assert(
      !/(^|\/)(?:tests?|fixtures?|profiles?|downloads?|coverage|node_modules)(\/|$)/iu.test(name),
      `Development artifact packaged in Firefox ZIP: ${name}`,
    );
    assert(
      !/(?:^|\/)(?:\.env|credentials|secrets?)(?:\.|$)/iu.test(name),
      `Confidential-looking file packaged in Firefox ZIP: ${name}`,
    );
    assert(
      /^(?:assets\/|chunks\/|manifest\.json|background\.js|(?:library|popup|sync-setup)\.html|chunks\/[^/]+\.js|assets\/[^/]+\.(?:css|woff2)|icon-(?:16|32|48|128|512)\.png)$/u.test(
        name,
      ),
      `Unexpected file packaged in Firefox ZIP: ${name}`,
    );
  }
  for (const page of expectedPages)
    assert(names.includes(page), `Expected extension page is missing: ${page}`);

  const manifestEntry = entries.find((entry) => entry.filename === "manifest.json");
  assert(manifestEntry?.getData !== undefined, "Firefox manifest entry is unreadable.");
  const manifest = JSON.parse(await manifestEntry.getData(new TextWriter()));
  assert(manifest.manifest_version === 3, "Archived Firefox manifest must use MV3.");
  assert(
    JSON.stringify(manifest.permissions) === JSON.stringify(approvedPermissions),
    "Archived Firefox permissions differ from the approved allowlist.",
  );
  assert(
    JSON.stringify(manifest.optional_host_permissions) === JSON.stringify(approvedOptionalOrigins),
    "Archived Firefox optional origins differ from the approved allowlist.",
  );
  assert(!("host_permissions" in manifest), "Archived Firefox manifest has required origins.");
  assert(!("minimum_chrome_version" in manifest), "Archived Firefox manifest has Chrome metadata.");
  const gecko = manifest.browser_specific_settings?.gecko;
  assert(gecko?.id === extensionId, "Archived Firefox extension ID changed.");
  assert(gecko?.strict_min_version === "140.0", "Archived Firefox minimum version changed.");
  assert(
    manifest.browser_specific_settings?.gecko_android === undefined,
    "Archived desktop Linux beta claims Firefox for Android compatibility.",
  );
  assert(
    JSON.stringify(gecko?.data_collection_permissions) ===
      JSON.stringify(approvedDataCollectionPermissions),
    "Archived Firefox data-collection permission mapping changed.",
  );
} finally {
  await reader.close();
}

const sourceArchive = await readFile(new URL(sourceArchiveNames[0], output));
assert(sourceArchive.byteLength < 5 * 1024 * 1024, "Firefox source ZIP exceeds 5 MiB.");
const sourceReader = new ZipReader(new BlobReader(new Blob([sourceArchive])));
try {
  const sourceNames = (await sourceReader.getEntries()).map((entry) => entry.filename);
  assert(sourceNames.includes("package.json"), "Firefox source ZIP is missing package.json.");
  assert(sourceNames.includes("wxt.config.ts"), "Firefox source ZIP is missing WXT configuration.");
  assert(
    sourceNames.includes("entrypoints/background.ts"),
    "Firefox source ZIP is missing its background entrypoint.",
  );
  for (const name of sourceNames)
    assert(
      !/(^|\/)(?:\.output|\.wxt|blob-report|coverage|downloads?|node_modules|playwright-report|profiles?|test-results|tests)(\/|$)/iu.test(
        name,
      ),
      `Development artifact packaged in Firefox source ZIP: ${name}`,
    );
} finally {
  await sourceReader.close();
}

console.log(`Firefox archive validation passed: ${archiveNames[0]} and ${sourceArchiveNames[0]}`);
