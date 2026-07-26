import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const releaseArchivePattern =
  /^awsmbrowser-extension-[0-9A-Za-z.-]+-(?:chrome|firefox|sources)\.zip$/u;

export function isGeneratedReleaseArchive(fileName) {
  return releaseArchivePattern.test(fileName);
}

async function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const outputDirectory = path.resolve(scriptDirectory, "../.output");
  const entries = await readdir(outputDirectory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isFile() && isGeneratedReleaseArchive(entry.name)) {
      await rm(path.join(outputDirectory, entry.name));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
