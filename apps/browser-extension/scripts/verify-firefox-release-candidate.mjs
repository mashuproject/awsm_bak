import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  candidateArtifactName,
  decodeCandidateProvenance,
  sha256File,
  verifyCandidateProvenance,
} from "./firefox-candidate-provenance.mjs";
import { FIREFOX_PROOF_CONTEXT, validateCandidateWorkflowRun } from "./firefox-proof-status.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseRunId(arguments_) {
  assert(
    arguments_.length === 2 && arguments_[0] === "--run-id" && /^[1-9]\d*$/u.test(arguments_[1]),
    "Usage: verify-firefox-release-candidate --run-id <positive-integer>",
  );
  return arguments_[1];
}

export function proofStatusPayload({ state, version, digest, targetUrl }) {
  assert(["pending", "failure", "success"].includes(state), "Proof status state is invalid.");
  assert(/^[0-9a-f]{64}$/u.test(digest), "Proof status digest is invalid.");
  const verb = state === "pending" ? "running" : state === "success" ? "passed" : "failed";
  return {
    state,
    context: FIREFOX_PROOF_CONTEXT,
    target_url: targetUrl,
    description: `Firefox v${version} signed proof ${verb} (${digest.slice(0, 12)})`,
  };
}

function command(
  commandName,
  arguments_,
  { cwd = repositoryRoot, env, input, capture = false } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandName, arguments_, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [
        input === undefined ? "inherit" : "pipe",
        capture ? "pipe" : "inherit",
        capture ? "pipe" : "inherit",
      ],
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

async function requireSuccess(commandName, arguments_, options) {
  const result = await command(commandName, arguments_, options);
  if (result.code !== 0) {
    throw new Error(
      `${commandName} stopped with ${
        result.signal === null ? `exit ${result.code}` : `signal ${result.signal}`
      }${result.stderr === "" ? "" : `: ${result.stderr.trim()}`}`,
    );
  }
  return result.stdout.trim();
}

async function postStatus(repository, commit, payload) {
  await requireSuccess(
    "gh",
    [
      "api",
      "--method",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      `repos/${repository}/statuses/${commit}`,
      "--input",
      "-",
    ],
    { input: JSON.stringify(payload), capture: true },
  );
}

async function requireAbsentTag(version) {
  const output = await requireSuccess(
    "git",
    ["ls-remote", "--tags", "origin", `refs/tags/v${version}`, `refs/tags/v${version}^{}`],
    { capture: true },
  );
  assert(output === "", `Remote tag v${version} already exists.`);
}

async function requireAbsentRelease(repository, version) {
  const result = await command("gh", ["api", `repos/${repository}/releases/tags/v${version}`], {
    capture: true,
  });
  if (result.code === 0) throw new Error(`GitHub Release v${version} already exists.`);
  assert(
    /HTTP 404|Not Found/iu.test(result.stderr),
    `GitHub Release lookup failed: ${result.stderr.trim()}`,
  );
}

async function verifyChecksumFile(checksumPath, expectedName, expectedDigest) {
  const contents = await readFile(checksumPath, "utf8");
  assert(
    contents === `${expectedDigest}  ${expectedName}\n`,
    "Firefox candidate checksum file is invalid.",
  );
}

async function main() {
  const runId = parseRunId(process.argv.slice(2));
  const branch = await requireSuccess("git", ["branch", "--show-current"], { capture: true });
  assert(branch === "main", "Firefox candidate proof must run on main.");
  const status = await requireSuccess("git", ["status", "--porcelain"], { capture: true });
  assert(status === "", "Firefox candidate proof requires a clean working tree.");
  await requireSuccess("git", ["fetch", "origin", "main"]);
  const commit = await requireSuccess("git", ["rev-parse", "HEAD"], { capture: true });
  const remoteCommit = await requireSuccess("git", ["rev-parse", "origin/main"], { capture: true });
  assert(commit === remoteCommit, "Local HEAD does not match origin/main.");
  const packageMetadata = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const version = packageMetadata.version;
  const repository = await requireSuccess(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { capture: true },
  );
  await requireAbsentTag(version);
  await requireAbsentRelease(repository, version);

  const run = JSON.parse(
    await requireSuccess("gh", ["api", `repos/${repository}/actions/runs/${runId}`], {
      capture: true,
    }),
  );
  validateCandidateWorkflowRun(run, { repository, commit, runId });
  const runUrl = run.html_url;
  const artifactName = candidateArtifactName(version, commit);
  const outputDirectory = resolve(
    packageRoot,
    ".output",
    "firefox-release-candidate",
    `run-${runId}`,
  );
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await requireSuccess("gh", [
    "run",
    "download",
    runId,
    "--repo",
    repository,
    "--name",
    artifactName,
    "--dir",
    outputDirectory,
  ]);

  const provenancePath = resolve(outputDirectory, `firefox-candidate-v${version}.json`);
  const provenance = decodeCandidateProvenance(JSON.parse(await readFile(provenancePath, "utf8")));
  assert(provenance.repository === repository, "Candidate repository does not match.");
  assert(provenance.commit === commit, "Candidate commit does not match.");
  assert(provenance.version === version, "Candidate version does not match.");
  assert(provenance.candidateRunUrl === runUrl, "Candidate run URL does not match.");
  const signedXpi = resolve(outputDirectory, provenance.signedXpi.name);
  const signedChecksum = resolve(outputDirectory, `${provenance.signedXpi.name}.sha256`);
  const signedDigest = await sha256File(signedXpi);
  await verifyChecksumFile(signedChecksum, basename(signedXpi), signedDigest);

  await requireSuccess("corepack", ["pnpm", "zip:firefox"], { cwd: packageRoot });
  const generatedUnsigned = resolve(
    packageRoot,
    ".output",
    `awsmbrowser-extension-${version}-firefox.zip`,
  );
  const generatedSource = resolve(
    packageRoot,
    ".output",
    `awsmbrowser-extension-${version}-sources.zip`,
  );
  const unsignedArchive = resolve(outputDirectory, provenance.unsignedArchive.name);
  const sourceArchive = resolve(outputDirectory, provenance.sourceArchive.name);
  await Promise.all([
    copyFile(generatedUnsigned, unsignedArchive),
    copyFile(generatedSource, sourceArchive),
  ]);
  await verifyCandidateProvenance(provenance, {
    repository,
    commit,
    version,
    candidateRunUrl: runUrl,
    unsignedArchive,
    sourceArchive,
    signedXpi,
  });
  await requireSuccess(
    process.execPath,
    [resolve(packageRoot, "scripts", "verify-signed-firefox-xpi.mjs"), signedXpi, unsignedArchive],
    { cwd: packageRoot },
  );

  let pending = false;
  try {
    await postStatus(
      repository,
      commit,
      proofStatusPayload({
        state: "pending",
        version,
        digest: signedDigest,
        targetUrl: runUrl,
      }),
    );
    pending = true;
    await requireSuccess(
      "corepack",
      [
        "pnpm",
        "exec",
        "playwright",
        "test",
        "-c",
        "tests/firefox-production/playwright.config.mjs",
      ],
      {
        cwd: packageRoot,
        env: { AWSM_FIREFOX_SIGNED_XPI: signedXpi },
      },
    );
    await requireSuccess("corepack", ["pnpm", "test:e2e:cross-browser"], {
      cwd: repositoryRoot,
      env: { AWSM_FIREFOX_SIGNED_XPI: signedXpi },
    });
    const proof = {
      repository,
      commit,
      version,
      candidateRunId: runId,
      candidateRunUrl: runUrl,
      signedXpi: { name: basename(signedXpi), sha256: signedDigest },
      firefoxLanes: ["stable", "esr"],
      commands: ["firefox-production", "test:e2e:cross-browser"],
      outcome: "success",
    };
    await writeFile(
      resolve(outputDirectory, `firefox-proof-v${version}.json`),
      `${JSON.stringify(proof, undefined, 2)}\n`,
      { mode: 0o600 },
    );
    await postStatus(
      repository,
      commit,
      proofStatusPayload({
        state: "success",
        version,
        digest: signedDigest,
        targetUrl: runUrl,
      }),
    );
    process.stdout.write(`Firefox signed candidate v${version} passed local proof.\n`);
  } catch (error) {
    if (pending) {
      await postStatus(
        repository,
        commit,
        proofStatusPayload({
          state: "failure",
          version,
          digest: signedDigest,
          targetUrl: runUrl,
        }),
      ).catch(() => {});
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
