import { execFileSync, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const configuredBuild = process.env.AWSM_CANONICAL_EXTENSION_BUILD;
const extensionBuild = resolve(
  repositoryRoot,
  configuredBuild ?? "apps/browser-extension/.output/canonical-surface/chrome-mv3",
);
const braveExecutable = process.env.AWSM_BRAVE_EXECUTABLE;
const braveFlatpakApp = process.env.AWSM_BRAVE_FLATPAK_APP ?? "com.brave.Browser";
const headless = process.env.AWSM_BRAVE_HEADLESS === "1";

function hasFlatpakBrave() {
  try {
    execFileSync("flatpak", ["info", braveFlatpakApp], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function availablePort() {
  const probe = createServer();
  await new Promise((resolvePort, rejectPort) => {
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", resolvePort);
  });
  const address = probe.address();
  await new Promise((resolveClose, rejectClose) =>
    probe.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  if (address === null || typeof address === "string") throw new Error("Brave debug port missing.");
  return address.port;
}

async function waitForDebugger(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Brave is still starting its remote debugging endpoint.
    }
    if (child.exitCode !== null)
      throw new Error(`Brave exited before debugging (${child.exitCode}).`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Brave did not expose remote debugging within 20 seconds.");
}

async function waitForExtensionWorker(context) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const worker = context.serviceWorkers()[0];
    if (worker !== undefined) return worker;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Brave did not start the packaged extension service worker within 30 seconds.");
}

async function startBrave(root, extensionPath, port) {
  if (braveExecutable === undefined && !hasFlatpakBrave()) {
    throw new Error(
      "Brave capture E2E requires AWSM_BRAVE_EXECUTABLE or an installed com.brave.Browser Flatpak.",
    );
  }
  const command = braveExecutable ?? "flatpak";
  const prefix = braveExecutable === undefined ? ["run", braveFlatpakApp] : [];
  const child = spawn(
    command,
    [
      ...prefix,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${resolve(root, "profile")}`,
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      ...(headless ? ["--headless=new"] : []),
      "about:blank",
    ],
    { cwd: repositoryRoot, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.on("data", (chunk) => process.stderr.write(`[brave] ${chunk}`));
  await waitForDebugger(port, child);
  return child;
}

function terminateBrave(root, child) {
  if (child?.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The browser process group already exited.
    }
  }
  try {
    execFileSync("pkill", ["-KILL", "-f", "--", `--user-data-dir=${resolve(root, "profile")}`], {
      stdio: "ignore",
    });
  } catch {
    // The exact temporary profile has no remaining browser process.
  }
}

async function main() {
  const root = await mkdtemp("/tmp/awsm-brave-capture-");
  let child;
  let browser;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>Brave capture fixture</title><main>Captured from Brave.</main>",
    );
  });
  try {
    const extensionPath = resolve(root, "extension");
    await cp(extensionBuild, extensionPath, { recursive: true });
    // popup.html is opened as a CDP page, so the test cannot invoke Brave's toolbar action to
    // grant activeTab. Grant only this test fixture origin in the copied artifact instead.
    const manifestPath = resolve(extensionPath, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host_permissions = ["http://127.0.0.1/*"];
    await writeFile(manifestPath, JSON.stringify(manifest));

    await new Promise((resolveServer, rejectServer) => {
      server.once("error", rejectServer);
      server.listen(0, "127.0.0.1", resolveServer);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Capture fixture did not bind.");
    const fixtureUrl = `http://127.0.0.1:${address.port}/fixture`;
    const port = await availablePort();
    child = await startBrave(root, extensionPath, port);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error("Brave did not expose a browser context.");
    const worker = await waitForExtensionWorker(context);
    const extensionId = new URL(worker.url()).host;
    const activePage = context.pages()[0] ?? (await context.newPage());
    await activePage.goto(fixtureUrl);
    await activePage.bringToFront();
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 400, height: 700 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await activePage.bringToFront();
    await popup.evaluate(async () => {
      const api = globalThis.chrome;
      const tabs = await api.tabs.query({});
      const active = tabs.find((tab) => tab.id !== undefined && tab.active);
      if (active?.id === undefined) throw new Error("Capture fixture tab is missing.");
      await api.tabs.update(active.id, { active: true });
    });
    await popup.getByRole("heading", { name: "Create your local Vault" }).waitFor();
    await popup.getByLabel("Vault name").fill("Brave capture proof");
    await popup.getByRole("button", { name: "Create Vault" }).click();
    const phrase = await popup
      .getByRole("textbox", { name: "Recovery Phrase", exact: true })
      .inputValue();
    await popup.getByLabel("Type the Recovery Phrase to continue").fill(phrase);
    await popup.getByRole("button", { name: "Confirm Recovery Phrase" }).click();
    await popup.getByRole("heading", { name: "Archive this page" }).waitFor();
    await popup.getByRole("button", { name: "Archive this page" }).click();
    await popup.getByRole("heading", { name: "Recent captures" }).waitFor();
    await popup.getByText("Brave capture fixture").waitFor();
    console.log("Brave capture E2E passed.");
  } finally {
    terminateBrave(root, child);
    if (browser !== undefined) {
      void browser.close().catch(() => undefined);
    }
    if (server.listening) {
      server.closeAllConnections();
      await Promise.race([
        new Promise((resolveClose) => server.close(() => resolveClose())),
        new Promise((resolveClose) => setTimeout(resolveClose, 1_000)),
      ]);
    }
    await rm(root, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
