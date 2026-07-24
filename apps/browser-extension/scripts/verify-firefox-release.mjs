import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../", import.meta.url);
const output = new URL(".output/firefox-mv3/", root);
const extensionId = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";
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
const releaseExcludedFaultPrefixes = [
  "storage-relief:",
  "artifact-retrieval:",
  "stale-discard:",
  "server-switch-relay:",
  "export-download:",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

const manifest = JSON.parse(await readFile(new URL("manifest.json", output), "utf8"));
assert(manifest.manifest_version === 3, "The Firefox build must use Manifest V3.");
assert(
  JSON.stringify(manifest.permissions) === JSON.stringify(approvedPermissions),
  "Built Firefox permissions differ from the approved allowlist.",
);
assert(!manifest.permissions.includes("offscreen"), "Firefox must not request offscreen.");
assert(!manifest.permissions.includes("pageCapture"), "Firefox must not request pageCapture.");
assert(!("host_permissions" in manifest), "Firefox must not contain required host permissions.");
assert(
  JSON.stringify(manifest.optional_host_permissions) === JSON.stringify(approvedOptionalOrigins),
  "Built Firefox optional origins differ from the approved allowlist.",
);
const gecko = manifest.browser_specific_settings?.gecko;
assert(gecko?.id === extensionId, "The permanent Firefox extension ID changed.");
assert(gecko?.strict_min_version === "140.0", "The Firefox minimum version must remain 140.0.");
assert(
  manifest.browser_specific_settings?.gecko_android === undefined,
  "The desktop Linux beta must not claim Firefox for Android compatibility.",
);
assert(
  JSON.stringify(gecko?.data_collection_permissions) ===
    JSON.stringify(approvedDataCollectionPermissions),
  "The Firefox data-collection permission mapping changed.",
);
assert(!("minimum_chrome_version" in manifest), "Chrome-only manifest metadata reached Firefox.");
const csp = manifest.content_security_policy?.extension_pages;
assert(
  typeof csp === "string" && csp.includes("'wasm-unsafe-eval'"),
  "Sodium WASM CSP is missing.",
);
assert(!/(?:^|\s)'unsafe-eval'(?:\s|;|$)/u.test(csp), "General unsafe-eval is prohibited.");

for (const path of await files(output.pathname)) {
  if (extname(path) === ".js") {
    const source = await readFile(path, "utf8");
    assert(
      !source.includes("awsm:test-fault-control"),
      `E2E fault controls found in ${relative(output.pathname, path)}.`,
    );
    for (const prefix of releaseExcludedFaultPrefixes)
      assert(
        !source.includes(prefix),
        `Release-excluded fault checkpoint found in ${relative(output.pathname, path)}.`,
      );
  }
  if (![".html", ".css"].includes(extname(path))) continue;
  const source = await readFile(path, "utf8");
  assert(
    !/(?:src|href)=["']https?:|url\(\s*["']?https?:/iu.test(source),
    `Remote asset reference found in ${relative(output.pathname, path)}.`,
  );
}

console.log("Firefox release manifest and static security checks passed.");
