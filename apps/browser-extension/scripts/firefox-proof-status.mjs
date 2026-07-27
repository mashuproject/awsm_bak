import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const FIREFOX_PROOF_CONTEXT = "awsm/firefox-signed-local-proof";
export const RELEASE_WORKFLOW_PATH = ".github/workflows/chrome-extension-release.yml";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function selectLatestProofStatus(statuses) {
  assert(Array.isArray(statuses), "Commit statuses response is invalid.");
  const status = statuses.find((candidate) => candidate?.context === FIREFOX_PROOF_CONTEXT);
  assert(status !== undefined, "Firefox signed local proof status is missing.");
  assert(status.state === "success", `Firefox signed local proof status is ${status.state}.`);
  assert(typeof status.target_url === "string", "Firefox proof status target URL is invalid.");
  return status;
}

export function runIdFromStatus(status, repository) {
  const url = new URL(status.target_url);
  assert(
    url.protocol === "https:" && url.hostname === "github.com",
    "Proof target URL is invalid.",
  );
  assert(url.username === "" && url.password === "", "Proof target URL contains credentials.");
  assert(url.search === "" && url.hash === "", "Proof target URL contains query or fragment data.");
  const prefix = `/${repository}/actions/runs/`;
  assert(url.pathname.startsWith(prefix), "Proof target URL repository is invalid.");
  const runId = url.pathname.slice(prefix.length);
  assert(/^[1-9]\d*$/u.test(runId), "Proof target run ID is invalid.");
  return runId;
}

export function validateCandidateWorkflowRun(run, { repository, commit, runId }) {
  assert(typeof run === "object" && run !== null, "Candidate workflow run is invalid.");
  assert(String(run.id) === runId, "Candidate workflow run ID does not match.");
  assert(run.event === "workflow_dispatch", "Candidate run was not manually dispatched.");
  assert(run.head_sha === commit, "Candidate workflow run commit does not match.");
  assert(run.status === "completed", "Candidate workflow run is not complete.");
  assert(run.conclusion === "success", "Candidate workflow run did not succeed.");
  assert(run.path === RELEASE_WORKFLOW_PATH, "Candidate workflow path does not match.");
  assert(
    run.html_url === `https://github.com/${repository}/actions/runs/${runId}`,
    "Candidate run URL does not match.",
  );
  return run;
}

export function validateResumeWorkflowRun(run, { repository, commit, runId }) {
  assert(typeof run === "object" && run !== null, "Resume workflow run is invalid.");
  assert(String(run.id) === runId, "Resume workflow run ID does not match.");
  assert(run.event === "workflow_dispatch", "Resume run was not manually dispatched.");
  assert(run.head_sha === commit, "Resume workflow run commit does not match.");
  assert(run.status === "completed", "Resume workflow run is not complete.");
  assert(run.path === RELEASE_WORKFLOW_PATH, "Resume workflow path does not match.");
  assert(
    run.html_url === `https://github.com/${repository}/actions/runs/${runId}`,
    "Resume run URL does not match.",
  );
  return run;
}

async function github(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "awsm-firefox-release/1",
    },
  });
  if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}.`);
  return response.json();
}

async function main() {
  const operation = process.argv[2];
  const repository = process.env.GITHUB_REPOSITORY;
  const commit = process.env.CANDIDATE_COMMIT;
  const token = process.env.GH_TOKEN;
  assert(repository !== undefined && repository !== "", "GITHUB_REPOSITORY is required.");
  assert(commit !== undefined && /^[0-9a-f]{40}$/u.test(commit), "CANDIDATE_COMMIT is invalid.");
  assert(token !== undefined && token !== "", "GH_TOKEN is required.");
  if (operation === "validate-resume") {
    const runId = process.env.RESUME_RUN_ID;
    assert(runId !== undefined && /^[1-9]\d*$/u.test(runId), "RESUME_RUN_ID is invalid.");
    const run = await github(`/repos/${repository}/actions/runs/${runId}`, token);
    validateResumeWorkflowRun(run, { repository, commit, runId });
    process.stdout.write(`Validated resumable Firefox candidate run ${runId}.\n`);
    return;
  }
  assert(
    operation === "resolve-proof",
    "Usage: firefox-proof-status <resolve-proof|validate-resume>",
  );
  const output = process.env.GITHUB_OUTPUT;
  assert(output !== undefined && output !== "", "GITHUB_OUTPUT is required.");
  const statuses = await github(`/repos/${repository}/statuses/${commit}?per_page=100`, token);
  const status = selectLatestProofStatus(statuses);
  const runId = runIdFromStatus(status, repository);
  const run = await github(`/repos/${repository}/actions/runs/${runId}`, token);
  validateCandidateWorkflowRun(run, { repository, commit, runId });
  await appendFile(output, `run_id=${runId}\nrun_url=${status.target_url}\n`);
  process.stdout.write(`Resolved Firefox signed local proof run ${runId}.\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
