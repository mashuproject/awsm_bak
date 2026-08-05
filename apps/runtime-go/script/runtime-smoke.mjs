import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const runtimeRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const wantsWails = process.env.AWSM_RUNTIME_WAILS === "1";

async function build(outputPath, tags = []) {
  await execFileAsync("go", ["build", ...(tags.length === 0 ? [] : ["-tags", tags.join(",")]), "-o", outputPath, "./cmd/awsm"], {
    cwd: runtimeRoot,
  });
}

async function supportsPkgConfigPackage(name) {
  try {
    await execFileAsync("pkg-config", ["--exists", name]);
    return true;
  } catch {
    return false;
  }
}

async function waitForReady(path, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (typeof value.address === "string" && value.address.startsWith("127.0.0.1:")) return value;
    } catch {
      // The application writes the ready file atomically; retry while it starts.
    }
    if (child.exitCode !== null) throw new Error(`Runtime exited before readiness (${child.exitCode}).`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Runtime did not become ready within 20 seconds.");
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("close", resolveExit)),
    new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error("Runtime did not stop.")), 10_000)),
  ]);
}

async function runServe(binary, dataDirectory) {
  const readyFile = resolve(dataDirectory, "runtime.ready");
  const child = spawn(binary, [
    "--mode",
    "serve",
    "--data-dir",
    dataDirectory,
    "--listen",
    "127.0.0.1:0",
    "--ready-file",
    readyFile,
  ], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => process.stderr.write(`[runtime] ${chunk}`));
  try {
    const ready = await waitForReady(readyFile, child);
    const response = await fetch(`http://${ready.address}/api/awsm/runtime/health`);
    if (!response.ok || (await response.json()).status !== "ok") {
      throw new Error("Standalone Runtime health check failed.");
    }
    await stop(child);
    try {
      await access(readyFile);
      throw new Error("Standalone Runtime left its ready file after shutdown.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function runWails(binary, dataDirectory) {
  const readyFile = resolve(dataDirectory, "desktop.ready");
  const child = spawn("xvfb-run", ["-a", "--server-args=-screen 0 1280x800x24", binary,
    "--mode", "desktop", "--data-dir", dataDirectory, "--ready-file", readyFile,
  ], { cwd: repositoryRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => process.stderr.write(`[wails] ${chunk}`));
  try {
    const ready = await waitForReady(readyFile, child);
    const response = await fetch(`http://${ready.address}/api/awsm/runtime/health`);
    if (!response.ok || (await response.json()).status !== "ok") {
      throw new Error("Wails Runtime health check failed.");
    }
    // Wails repairs WebKitGTK's process signal handlers during the first few
    // seconds of page startup. Wait for that initialization before asking the
    // desktop process to shut down so the smoke test exercises graceful exit.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 6_000));
    process.kill(-child.pid, "SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("close", resolveExit)),
      new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error("Wails Runtime did not stop.")), 15_000)),
    ]);
    try {
      await access(readyFile);
      throw new Error("Wails Runtime left its ready file after shutdown.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } finally {
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process group already exited.
      }
    }
  }
}

const temporaryRoot = await mkdtemp(resolve(repositoryRoot, ".tmp-runtime-smoke-"));
try {
  const serveBinary = resolve(temporaryRoot, "awsm-serve");
  await build(serveBinary);
  await runServe(serveBinary, resolve(temporaryRoot, "serve-data"));
  if (wantsWails) {
    const desktopBinary = resolve(temporaryRoot, "awsm-desktop");
    const desktopTags = ["desktop", "production"];
    if (await supportsPkgConfigPackage("webkit2gtk-4.1")) desktopTags.push("webkit2_41");
    await build(desktopBinary, desktopTags);
    await runWails(desktopBinary, resolve(temporaryRoot, "desktop-data"));
  } else {
    console.log("Skipping native Wails smoke: set AWSM_RUNTIME_WAILS=1 to enable this lane.");
  }
  console.log("Runtime CLI smoke passed.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
