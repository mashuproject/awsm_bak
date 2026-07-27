import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ADDON_ID = "{f6f49704-8d53-4eda-aef7-619ab88dda5f}";
const OPERATION = "sign-firefox-candidate";

const ROOT_KEYS = [
  "addonId",
  "candidateRunUrl",
  "commit",
  "operation",
  "repository",
  "signedXpi",
  "sourceArchive",
  "tag",
  "unsignedArchive",
  "version",
];
const FILE_KEYS = ["name", "sha256"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, label) {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} is invalid.`,
  );
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  assert(
    JSON.stringify(actual) === JSON.stringify([...expected].sort()),
    `${label} keys are invalid.`,
  );
}

function string(value, label) {
  assert(typeof value === "string" && value !== "", `${label} is invalid.`);
  return value;
}

function fileRecord(value, label) {
  const record = object(value, label);
  exactKeys(record, FILE_KEYS, label);
  const name = string(record.name, `${label}.name`);
  assert(basename(name) === name && name !== "." && name !== "..", `${label}.name is unsafe.`);
  const sha256 = string(record.sha256, `${label}.sha256`);
  assert(SHA256_PATTERN.test(sha256), `${label}.sha256 is invalid.`);
  return { name, sha256 };
}

export function candidateArtifactName(version, commit) {
  assert(SEMVER_PATTERN.test(version), "Candidate version is invalid.");
  assert(COMMIT_PATTERN.test(commit), "Candidate commit is invalid.");
  return `firefox-candidate-v${version}-${commit}`;
}

export function candidateRunId(candidateRunUrl, repository) {
  const url = new URL(candidateRunUrl);
  assert(url.protocol === "https:", "Candidate run URL must use HTTPS.");
  assert(url.hostname === "github.com", "Candidate run URL must use github.com.");
  assert(url.username === "" && url.password === "", "Candidate run URL contains credentials.");
  assert(
    url.search === "" && url.hash === "",
    "Candidate run URL contains query or fragment data.",
  );
  const expectedPrefix = `/${repository}/actions/runs/`;
  assert(url.pathname.startsWith(expectedPrefix), "Candidate run URL repository is invalid.");
  const runId = url.pathname.slice(expectedPrefix.length);
  assert(/^[1-9]\d*$/u.test(runId), "Candidate run URL ID is invalid.");
  return runId;
}

export function decodeCandidateProvenance(value) {
  const record = object(value, "Candidate provenance");
  exactKeys(record, ROOT_KEYS, "Candidate provenance");
  const repository = string(record.repository, "Candidate repository");
  assert(REPOSITORY_PATTERN.test(repository), "Candidate repository is invalid.");
  const commit = string(record.commit, "Candidate commit");
  assert(COMMIT_PATTERN.test(commit), "Candidate commit is invalid.");
  const version = string(record.version, "Candidate version");
  assert(SEMVER_PATTERN.test(version), "Candidate version is invalid.");
  const tag = string(record.tag, "Candidate tag");
  assert(tag === `v${version}`, "Candidate tag does not match its version.");
  assert(record.operation === OPERATION, "Candidate operation is invalid.");
  assert(record.addonId === ADDON_ID, "Candidate add-on ID is invalid.");
  const candidateRunUrl = string(record.candidateRunUrl, "Candidate run URL");
  candidateRunId(candidateRunUrl, repository);
  return {
    repository,
    commit,
    version,
    tag,
    operation: OPERATION,
    addonId: ADDON_ID,
    candidateRunUrl,
    unsignedArchive: fileRecord(record.unsignedArchive, "Candidate unsigned archive"),
    sourceArchive: fileRecord(record.sourceArchive, "Candidate source archive"),
    signedXpi: fileRecord(record.signedXpi, "Candidate signed XPI"),
  };
}

export async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function createCandidateProvenance({
  repository,
  commit,
  version,
  candidateRunUrl,
  unsignedArchive,
  sourceArchive,
  signedXpi,
}) {
  return decodeCandidateProvenance({
    repository,
    commit,
    version,
    tag: `v${version}`,
    operation: OPERATION,
    addonId: ADDON_ID,
    candidateRunUrl,
    unsignedArchive: {
      name: basename(unsignedArchive),
      sha256: await sha256File(unsignedArchive),
    },
    sourceArchive: {
      name: basename(sourceArchive),
      sha256: await sha256File(sourceArchive),
    },
    signedXpi: {
      name: basename(signedXpi),
      sha256: await sha256File(signedXpi),
    },
  });
}

export async function verifyCandidateProvenance(
  value,
  { repository, commit, version, candidateRunUrl, unsignedArchive, sourceArchive, signedXpi },
) {
  const candidate = decodeCandidateProvenance(value);
  assert(candidate.repository === repository, "Candidate repository does not match.");
  assert(candidate.commit === commit, "Candidate commit does not match.");
  assert(candidate.version === version, "Candidate version does not match.");
  assert(candidate.candidateRunUrl === candidateRunUrl, "Candidate run URL does not match.");
  for (const [label, record, path] of [
    ["unsigned archive", candidate.unsignedArchive, unsignedArchive],
    ["source archive", candidate.sourceArchive, sourceArchive],
    ["signed XPI", candidate.signedXpi, signedXpi],
  ]) {
    assert(record.name === basename(path), `Candidate ${label} name does not match.`);
    assert(record.sha256 === (await sha256File(path)), `Candidate ${label} digest does not match.`);
  }
  return candidate;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert(value !== undefined && value !== "", `${name} is required.`);
  return value;
}

async function main() {
  const operation = process.argv[2];
  const provenancePath = resolve(requiredEnvironment("CANDIDATE_PROVENANCE"));
  const input = {
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    commit: requiredEnvironment("CANDIDATE_COMMIT"),
    version: requiredEnvironment("VERSION"),
    candidateRunUrl: requiredEnvironment("CANDIDATE_RUN_URL"),
    unsignedArchive: resolve(requiredEnvironment("UNSIGNED_ARCHIVE")),
    sourceArchive: resolve(requiredEnvironment("FIREFOX_SOURCE_ARCHIVE")),
    signedXpi: resolve(requiredEnvironment("FIREFOX_XPI")),
  };
  if (operation === "create") {
    const candidate = await createCandidateProvenance(input);
    await writeFile(provenancePath, `${JSON.stringify(candidate, undefined, 2)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(`Created Firefox candidate provenance: ${provenancePath}\n`);
    return;
  }
  if (operation === "verify") {
    const candidate = JSON.parse(await readFile(provenancePath, "utf8"));
    await verifyCandidateProvenance(candidate, input);
    process.stdout.write(`Firefox candidate provenance validation passed: ${provenancePath}\n`);
    return;
  }
  throw new Error("Usage: firefox-candidate-provenance <create|verify>");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
