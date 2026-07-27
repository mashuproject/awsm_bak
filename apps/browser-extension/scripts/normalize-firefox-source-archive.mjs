import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BlobReader,
  BlobWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";

const canonicalTimestamp = new Date(1980, 0, 1, 0, 0, 0);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function normalizeFirefoxSourceArchive(archivePath) {
  const path = resolve(archivePath);
  assert(basename(path).endsWith("-sources.zip"), "Expected a Firefox source ZIP.");

  const input = await readFile(path);
  const reader = new ZipReader(new BlobReader(new Blob([input])));
  let files;
  try {
    const entries = await reader.getEntries();
    files = await Promise.all(
      entries
        .filter((entry) => !entry.directory)
        .sort((left, right) => left.filename.localeCompare(right.filename, "en"))
        .map(async (entry) => {
          assert(
            entry.getData !== undefined &&
              !entry.filename.startsWith("/") &&
              !entry.filename.includes("../"),
            `Unsafe or unreadable source entry: ${entry.filename}`,
          );
          return {
            name: entry.filename,
            bytes: await entry.getData(new Uint8ArrayWriter()),
          };
        }),
    );
  } finally {
    await reader.close();
  }

  const writer = new ZipWriter(new BlobWriter("application/zip"), {
    extendedTimestamp: false,
  });
  for (const file of files) {
    await writer.add(file.name, new Uint8ArrayReader(file.bytes), {
      level: 9,
      lastModDate: canonicalTimestamp,
      creationDate: canonicalTimestamp,
      lastAccessDate: canonicalTimestamp,
      useUnicodeFileNames: true,
    });
  }
  const output = await writer.close();
  await writeFile(path, new Uint8Array(await output.arrayBuffer()));
  process.stdout.write(`Normalized deterministic Firefox source archive: ${path}\n`);
}

async function main() {
  assert(
    process.argv.length === 3,
    "Usage: normalize-firefox-source-archive <firefox-sources.zip>",
  );
  await normalizeFirefoxSourceArchive(process.argv[2]);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
