import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";

import { normalizeFirefoxSourceArchive } from "./normalize-firefox-source-archive.mjs";

async function archive(entries, timestamp) {
  const writer = new ZipWriter(new BlobWriter("application/zip"));
  for (const [name, contents] of entries)
    await writer.add(name, new TextReader(contents), { lastModDate: timestamp });
  return Buffer.from(await (await writer.close()).arrayBuffer());
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("normalizes source entry order and timestamps without changing content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "awsm-firefox-source-"));
  const first = join(directory, "first-sources.zip");
  const second = join(directory, "second-sources.zip");
  try {
    await writeFile(
      first,
      await archive(
        [
          ["zeta.txt", "zeta"],
          ["nested/alpha.txt", "alpha"],
        ],
        new Date("2026-07-27T10:22:44.000Z"),
      ),
    );
    await writeFile(
      second,
      await archive(
        [
          ["nested/alpha.txt", "alpha"],
          ["zeta.txt", "zeta"],
        ],
        new Date("2030-01-02T03:04:06.000Z"),
      ),
    );

    await Promise.all([
      normalizeFirefoxSourceArchive(first),
      normalizeFirefoxSourceArchive(second),
    ]);

    assert.equal(digest(await readFile(first)), digest(await readFile(second)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
