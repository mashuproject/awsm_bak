import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../", import.meta.url);
const output = new URL(".output/chrome-mv3/", root);
const approvedPermissions = [
  "activeTab",
  "scripting",
  "offscreen",
  "unlimitedStorage",
  "downloads",
  "alarms",
];
const approvedOptionalOrigins = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];
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
assert(
  JSON.stringify(manifest.permissions) === JSON.stringify(approvedPermissions),
  "Built permissions differ from the approved allowlist.",
);
assert(
  !manifest.permissions.includes("pageCapture"),
  "The shipping manifest must not request pageCapture.",
);
assert(
  !("host_permissions" in manifest),
  "The shipping manifest must not contain host permissions.",
);
assert(
  JSON.stringify(manifest.optional_host_permissions) === JSON.stringify(approvedOptionalOrigins),
  "Built optional origins differ from the approved allowlist.",
);
assert(manifest.minimum_chrome_version === "116", "The minimum Chrome version must remain 116.");
const csp = manifest.content_security_policy?.extension_pages;
assert(
  typeof csp === "string" && csp.includes("'wasm-unsafe-eval'"),
  "Sodium WASM CSP is missing.",
);
assert(!/(?:^|\s)'unsafe-eval'(?:\s|;|$)/u.test(csp), "General unsafe-eval is prohibited.");

const builtFiles = await files(output.pathname);
for (const path of builtFiles) {
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

for (const directory of ["entrypoints", "src"]) {
  for (const path of await files(new URL(directory, root).pathname)) {
    if (![".ts", ".html", ".css"].includes(extname(path))) continue;
    const source = await readFile(path, "utf8");
    assert(!/\bchrome\.storage\b/u.test(source), `chrome.storage is prohibited in ${path}.`);
    assert(!/\blocalStorage\b/u.test(source), `localStorage is prohibited in ${path}.`);
    assert(
      !/\bcaches\.(?:open|put|add|addAll|match)\b/u.test(source),
      `Cache Storage is prohibited in ${path}.`,
    );
    assert(
      !/(?:from|import\s*)\s*\(?["']https?:/u.test(source),
      `Remote code import found in ${path}.`,
    );
  }
}

console.log("Release manifest and static security checks passed.");
