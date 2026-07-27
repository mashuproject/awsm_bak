import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { BlobWriter, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";

const canonicalTimestamp = new Date(1980, 0, 1, 0, 0, 0);

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

export async function createDeterministicArchive(buildDirectory, archive) {
  const paths = (await files(buildDirectory)).sort((left, right) =>
    relative(buildDirectory, left).localeCompare(relative(buildDirectory, right), "en"),
  );
  const writer = new ZipWriter(new BlobWriter("application/zip"), {
    extendedTimestamp: false,
  });
  for (const path of paths) {
    const name = relative(buildDirectory, path).replaceAll("\\", "/");
    await writer.add(name, new Uint8ArrayReader(await readFile(path)), {
      level: 9,
      lastModDate: canonicalTimestamp,
      creationDate: canonicalTimestamp,
      lastAccessDate: canonicalTimestamp,
      useUnicodeFileNames: true,
    });
  }
  const blob = await writer.close();
  await writeFile(archive, new Uint8Array(await blob.arrayBuffer()));
}
