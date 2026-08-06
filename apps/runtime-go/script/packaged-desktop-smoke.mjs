import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const runtimeRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const binary = process.env.AWSM_DESKTOP_BINARY;
if (!binary) throw new Error("AWSM_DESKTOP_BINARY is required");

async function waitForReady(path, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (typeof value.address === "string" && value.address.startsWith("127.0.0.1:")) return value;
    } catch {
      // The ready file is written atomically while the Runtime starts.
    }
    if (child.exitCode !== null) throw new Error(`Desktop Runtime exited before readiness (${child.exitCode}).`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Packaged desktop Runtime did not become ready within 20 seconds.");
}

const temporaryRoot = await mkdtemp(resolve(repositoryRoot, ".tmp-runtime-package-smoke-"));
const readyFile = resolve(temporaryRoot, "desktop.ready");
const dataDirectory = resolve(temporaryRoot, "data");
const child = spawn("xvfb-run", ["-a", "--server-args=-screen 0 1280x800x24", binary,
  "--data-dir", dataDirectory, "--ready-file", readyFile,
], { cwd: repositoryRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", (chunk) => process.stderr.write(`[packaged-wails] ${chunk}`));

try {
  const ready = await waitForReady(readyFile, child);
  const response = await fetch(`http://${ready.address}/api/awsm/runtime/health`);
  if (!response.ok || (await response.json()).status !== "ok") {
    throw new Error("Packaged desktop Runtime health check failed.");
  }
  // WebKitGTK repairs its process signal handlers during the first few seconds
  // of startup. Wait before the smoke test exercises graceful shutdown.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 6_000));
  process.kill(-child.pid, "SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("close", resolveExit)),
    new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error("Packaged desktop Runtime did not stop.")), 15_000)),
  ]);
  try {
    await access(readyFile);
    throw new Error("Packaged desktop Runtime left its ready file after shutdown.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  console.log("Packaged desktop Runtime smoke passed.");
} finally {
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* process group already exited */ }
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
