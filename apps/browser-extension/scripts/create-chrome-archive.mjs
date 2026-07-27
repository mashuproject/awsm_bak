import { readFile } from "node:fs/promises";

import { createDeterministicArchive } from "./create-deterministic-archive.mjs";

const root = new URL("../", import.meta.url);
const buildDirectory = new URL(".output/chrome-mv3/", root);
const outputDirectory = new URL(".output/", root);
const packageMetadata = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const archive = new URL(
  `awsmbrowser-extension-${packageMetadata.version}-chrome.zip`,
  outputDirectory,
);

await createDeterministicArchive(buildDirectory.pathname, archive);
console.log(`Created deterministic Chrome archive: ${archive.pathname}`);
