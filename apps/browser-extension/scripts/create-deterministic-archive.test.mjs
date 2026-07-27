import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDeterministicArchive } from "./create-deterministic-archive.mjs";

test("creates identical archives across traversal order and source timestamps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "awsm-runtime-archive-"));
  const firstRoot = join(directory, "first");
  const secondRoot = join(directory, "second");
  const firstArchive = join(directory, "first.zip");
  const secondArchive = join(directory, "second.zip");
  try {
    await mkdir(join(firstRoot, "nested"), { recursive: true });
    await writeFile(join(firstRoot, "zeta.txt"), "zeta");
    await writeFile(join(firstRoot, "nested", "alpha.txt"), "alpha");

    await mkdir(join(secondRoot, "nested"), { recursive: true });
    await writeFile(join(secondRoot, "nested", "alpha.txt"), "alpha");
    await writeFile(join(secondRoot, "zeta.txt"), "zeta");

    const oldTimestamp = new Date("2026-01-02T03:04:06.000Z");
    const futureTimestamp = new Date("2030-07-08T09:10:12.000Z");
    await Promise.all([
      utimes(join(firstRoot, "zeta.txt"), oldTimestamp, oldTimestamp),
      utimes(join(firstRoot, "nested", "alpha.txt"), oldTimestamp, oldTimestamp),
      utimes(join(secondRoot, "zeta.txt"), futureTimestamp, futureTimestamp),
      utimes(join(secondRoot, "nested", "alpha.txt"), futureTimestamp, futureTimestamp),
    ]);

    await createDeterministicArchive(firstRoot, firstArchive);
    await createDeterministicArchive(secondRoot, secondArchive);

    assert.deepEqual(await readFile(firstArchive), await readFile(secondArchive));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
