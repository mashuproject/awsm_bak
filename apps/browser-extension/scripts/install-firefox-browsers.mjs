import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const supportedLanes = new Set(["stable", "esr"]);

export function requestedFirefoxLanes(arguments_) {
  const lanes = arguments_.length === 0 ? ["stable", "esr"] : arguments_;
  if (lanes.some((lane) => !supportedLanes.has(lane))) {
    throw new Error("Firefox lanes must be stable and/or esr");
  }
  return [...new Set(lanes)];
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function installFirefox(packageRoot, lane, configuration) {
  const browser = configuration[lane];
  if (
    typeof browser?.archiveUrl !== "string" ||
    !browser.archiveUrl.startsWith("https://download-installer.cdn.mozilla.net/") ||
    !/^[a-f0-9]{128}$/.test(browser.archiveSha512) ||
    typeof browser.executable !== "string"
  ) {
    throw new Error(`Invalid pinned Firefox configuration for ${lane}`);
  }

  const executable = path.resolve(packageRoot, browser.executable);
  if (await pathExists(executable)) {
    process.stdout.write(`Pinned Firefox ${lane} is already installed.\n`);
    return;
  }

  const browserRoot = path.dirname(executable);
  const downloadRoot = path.resolve(packageRoot, ".output/firefox-browsers/downloads");
  const archive = path.join(downloadRoot, `firefox-${lane}.tar.xz`);
  await mkdir(downloadRoot, { recursive: true });
  await rm(browserRoot, { recursive: true, force: true });
  await mkdir(browserRoot, { recursive: true });

  const response = await fetch(browser.archiveUrl);
  if (!response.ok || response.body === null) {
    throw new Error(`Firefox ${lane} download failed with HTTP ${response.status}`);
  }

  const hash = createHash("sha512");
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    hasher,
    createWriteStream(archive, { mode: 0o600 }),
  );
  if (hash.digest("hex") !== browser.archiveSha512) {
    await rm(archive, { force: true });
    throw new Error(`Firefox ${lane} archive checksum did not match the repository pin`);
  }

  await execFileAsync("tar", ["-xJf", archive, "--strip-components=1", "-C", browserRoot]);
  await rm(archive, { force: true });
  if (!(await pathExists(executable))) {
    throw new Error(`Firefox ${lane} archive did not contain the configured executable`);
  }
  process.stdout.write(`Installed pinned Firefox ${lane}.\n`);
}

async function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(scriptDirectory, "..");
  const configuration = JSON.parse(
    await readFile(path.join(packageRoot, "tests/firefox-feasibility/browsers.json"), "utf8"),
  );
  for (const lane of requestedFirefoxLanes(process.argv.slice(2))) {
    await installFirefox(packageRoot, lane, configuration);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
