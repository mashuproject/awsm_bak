import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const amoBaseUrl = "https://addons.mozilla.org/api/v5/";

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

export function versionEndpoint(addonId, version) {
  return new URL(
    `addons/addon/${encodeURIComponent(addonId)}/versions/v${encodeURIComponent(version)}/`,
    amoBaseUrl,
  );
}

export function classifyAmoVersion(value, version) {
  if (
    typeof value !== "object" ||
    value === null ||
    value.version !== version ||
    value.file === undefined ||
    typeof value.file !== "object" ||
    value.file === null
  )
    throw new Error("AMO returned an invalid or mismatched version response.");
  if (
    value.channel !== "unlisted" ||
    !["public", "disabled", "unreviewed"].includes(value.file.status)
  )
    throw new Error("AMO returned an invalid unlisted version status.");
  if (
    value.file.status === "public" &&
    typeof value.file.url === "string" &&
    typeof value.file.hash === "string"
  )
    return { state: "Signed", url: value.file.url, hash: value.file.hash };
  if (value.file.status === "disabled") return { state: "Rejected", status: value.file.status };
  return { state: "Pending" };
}

function jwt(issuer, secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: issuer,
      jti: randomUUID(),
      iat: now,
      exp: now + 300,
    }),
  );
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function amoRequest(url, issuer, secret) {
  return fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `JWT ${jwt(issuer, secret)}`,
      "User-Agent": "awsm-firefox-release/1",
    },
  });
}

async function queryVersion(addonId, version, issuer, secret) {
  const response = await amoRequest(versionEndpoint(addonId, version), issuer, secret);
  if (response.status === 404) return { state: "Absent" };
  if (!response.ok) throw new Error(`AMO version query failed with HTTP ${response.status}.`);
  return classifyAmoVersion(await response.json(), version);
}

export function webExtCommand(arguments_) {
  return ["pnpm", "--filter", "@awsm/browser-extension", "exec", "web-ext", ...arguments_];
}

function runWebExt(arguments_, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("corepack", webExtCommand(arguments_), {
      stdio: "inherit",
      env: environment,
    });
    child.addListener("error", reject);
    child.addListener("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `web-ext sign stopped with ${signal === null ? `exit ${code}` : `signal ${signal}`}.`,
          ),
        );
    });
  });
}

async function downloadSignedXpi(url, expectedHash, destination, issuer, secret) {
  const response = await amoRequest(new URL(url), issuer, secret);
  if (!response.ok || response.body === null)
    throw new Error(`Signed XPI download failed with HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const [algorithm, digest] = expectedHash.split(":", 2);
  if (
    algorithm !== "sha256" ||
    digest === undefined ||
    createHash("sha256").update(bytes).digest("hex") !== digest.toLowerCase()
  )
    throw new Error("Signed XPI does not match the AMO SHA-256 digest.");
  const temporary = `${destination}.partial`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, destination);
}

async function main() {
  const [buildDirectory, sourceArchive, outputDirectory, addonId, version] = process.argv.slice(2);
  if (
    [buildDirectory, sourceArchive, outputDirectory, addonId, version].some(
      (value) => value === undefined || value === "",
    )
  )
    throw new Error(
      "Usage: sign-firefox-unlisted <build-dir> <source-zip> <output-dir> <addon-id> <version>",
    );
  const issuer = process.env.AMO_JWT_ISSUER;
  const secret = process.env.AMO_JWT_SECRET;
  if (issuer === undefined || issuer === "" || secret === undefined || secret === "")
    throw new Error("Protected AMO signing credentials are unavailable.");
  await mkdir(resolve(outputDirectory), { recursive: true });

  let status = await queryVersion(addonId, version, issuer, secret);
  if (status.state === "Absent") {
    await runWebExt(
      [
        "sign",
        "--no-config-discovery",
        "--source-dir",
        resolve(buildDirectory),
        "--artifacts-dir",
        resolve(outputDirectory),
        "--channel",
        "unlisted",
        "--upload-source-code",
        resolve(sourceArchive),
        "--approval-timeout",
        "0",
        "--timeout",
        "300000",
      ],
      {
        ...process.env,
        WEB_EXT_API_KEY: issuer,
        WEB_EXT_API_SECRET: secret,
      },
    ).catch(async (error) => {
      const submitted = await queryVersion(addonId, version, issuer, secret);
      if (submitted.state === "Absent") throw error;
    });
  }

  const deadline = Date.now() + 20 * 60_000;
  while (true) {
    status = await queryVersion(addonId, version, issuer, secret);
    if (status.state === "Signed") {
      const destination = resolve(outputDirectory, `awsm-firefox-v${version}.xpi`);
      await downloadSignedXpi(status.url, status.hash, destination, issuer, secret);
      process.stdout.write(`Retrieved ${basename(destination)}.\n`);
      return;
    }
    if (status.state === "Rejected")
      throw new Error(`AMO rejected Firefox ${version} (${status.status}).`);
    if (Date.now() >= deadline)
      throw new Error(
        `AMO review for Firefox ${version} is still pending; rerun this exact workflow to resume.`,
      );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
