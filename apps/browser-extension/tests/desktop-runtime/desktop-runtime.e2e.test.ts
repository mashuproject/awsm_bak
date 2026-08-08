import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const configuredExtensionBuild = process.env.AWSM_EXTENSION_BUILD;
const extensionBuildPath =
  configuredExtensionBuild === undefined
    ? resolve(repositoryRoot, "apps/browser-extension/.output/chrome-mv3-e2e")
    : isAbsolute(configuredExtensionBuild)
      ? configuredExtensionBuild
      : configuredExtensionBuild.startsWith("apps/browser-extension/")
        ? resolve(repositoryRoot, configuredExtensionBuild)
        : resolve(process.cwd(), configuredExtensionBuild);

interface Fixture {
  readonly process: ChildProcessWithoutNullStreams;
  readonly address: string;
  command(value: object): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const dataDir = await mkdtemp(resolve(repositoryRoot, ".tmp-runtime-e2e-"));
  const child = spawn("go", ["run", "./cmd/e2e-fixture", "--data-dir", dataDir], {
    cwd: resolve(repositoryRoot, "apps/runtime-go"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(`[runtime-fixture] ${chunk}`));
  const lines = createInterface({ input: child.stdout });
  const queued: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  lines.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(line);
    else waiter(line);
  });
  const nextLine = (): Promise<string> => {
    const queuedLine = queued.shift();
    if (queuedLine !== undefined) return Promise.resolve(queuedLine);
    return new Promise((resolveLine, rejectLine) => {
      waiters.push((line) => resolveLine(line));
      child.once("close", (code) => {
        rejectLine(
          new Error(`Runtime fixture exited before responding (code ${code ?? "unknown"}).`),
        );
      });
    });
  };
  const ready = JSON.parse(await nextLine()) as Record<string, unknown>;
  if (ready.event !== "ready" || typeof ready.address !== "string") {
    throw new Error("Runtime fixture did not report readiness.");
  }
  const command = async (value: object): Promise<Record<string, unknown>> => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
    return JSON.parse(await nextLine()) as Record<string, unknown>;
  };
  return {
    process: child,
    address: ready.address,
    command,
    async close() {
      try {
        await command({ command: "shutdown" });
      } finally {
        lines.close();
        await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  };
}

async function runtimeCommand(address: string, token: string, value: object): Promise<unknown> {
  const response = await fetch(`http://${address}/api/awsm/runtime/command`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    throw new Error("Runtime setup Command failed.");
  }
  return payload.value;
}

async function createDesktopVault(fixture: Fixture): Promise<void> {
  const pairingResponse = await fetch(`http://${fixture.address}/api/awsm/runtime/pairings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientName: "desktop-content-setup", scopes: ["runtime.vault"] }),
  });
  const pairing = (await pairingResponse.json()) as Record<string, unknown>;
  if (
    !pairingResponse.ok ||
    typeof pairing.pairingId !== "string" ||
    typeof pairing.code !== "string"
  ) {
    throw new Error("Runtime setup pairing failed.");
  }
  await expect(fixture.command({ command: "approve-next" })).resolves.toMatchObject({ ok: true });
  const grantResponse = await fetch(
    `http://${fixture.address}/api/awsm/runtime/pairings/${encodeURIComponent(pairing.pairingId)}/redeem`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code, scopes: ["runtime.vault"] }),
    },
  );
  const grant = (await grantResponse.json()) as Record<string, unknown>;
  if (!grantResponse.ok || typeof grant.token !== "string") {
    throw new Error("Runtime setup grant failed.");
  }
  const begin = (await runtimeCommand(fixture.address, grant.token, {
    type: "BeginVaultCreation",
    expectedVaultId: null,
    label: "Desktop archive",
  })) as Record<string, unknown>;
  if (typeof begin.setupId !== "string" || typeof begin.recoveryPhrase !== "string") {
    throw new Error("Runtime setup creation did not return a recovery ceremony.");
  }
  const confirmed = (await runtimeCommand(fixture.address, grant.token, {
    type: "ConfirmVaultCreation",
    setupId: begin.setupId,
    recoveryPhrase: begin.recoveryPhrase,
  })) as Record<string, unknown>;
  if (typeof confirmed.vaultId !== "string")
    throw new Error("Runtime setup Vault was not created.");
}

async function packagedExtension(testInfo: TestInfo): Promise<{
  readonly context: BrowserContext;
  readonly extensionId: string;
}> {
  const extensionPath = testInfo.outputPath("desktop-runtime-extension");
  await cp(extensionBuildPath, extensionPath, { recursive: true });
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  // The permission prompt is covered by the unit seam. Pre-grant loopback in
  // this browser proof so the test exercises the real transport and approval
  // journey instead of depending on headless browser prompt behavior.
  manifest.host_permissions = ["http://127.0.0.1/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(
    testInfo.outputPath(`desktop-runtime-profile-${randomUUID()}`),
    {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    },
  );
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  await Promise.all(context.pages().map((page) => page.close()));
  return { context, extensionId };
}

async function popup(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 440, height: 820 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

async function createVault(page: Page): Promise<void> {
  await page.getByLabel("Vault name").fill("Desktop Runtime proof");
  await page.getByRole("button", { name: "Create Vault" }).click();
  const phrase = await page
    .getByRole("textbox", { name: "Recovery Phrase", exact: true })
    .inputValue();
  await page.getByLabel("Type the Recovery Phrase to continue").fill(phrase);
  await page.getByRole("button", { name: "Confirm Recovery Phrase" }).click();
  await expect(page.getByRole("heading", { name: "Archive this page" })).toBeVisible();
}

test("connects the extension to a real Runtime and recovers revocation", async ({
  browser: _browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await startFixture();
  const extension = await packagedExtension(testInfo);
  try {
    const first = await popup(extension.context, extension.extensionId);
    await expect(first.getByRole("heading", { name: "Desktop Runtime" })).toBeVisible();
    await createVault(first);
    await first.getByRole("button", { name: "Vault settings" }).click();
    await expect(first.getByRole("heading", { name: "Desktop Runtime" })).toBeVisible();

    const approval = fixture.command({ command: "approve-next" });
    await first.getByRole("button", { name: "Connect Desktop Runtime" }).click();
    await expect(approval).resolves.toMatchObject({ ok: true });
    await expect(first.getByText(/Connected · runtime\.vault/u)).toBeVisible();
    await expect(first.getByRole("button", { name: "Disconnect Desktop Runtime" })).toBeEnabled();
    await first.screenshot({ path: testInfo.outputPath("desktop-runtime-connected.png") });

    const rawState = await first.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolveDatabase, rejectDatabase) => {
        const request = indexedDB.open("awsm");
        request.onerror = () => rejectDatabase(request.error);
        request.onsuccess = () => resolveDatabase(request.result);
      });
      return await new Promise<readonly unknown[]>((resolveValues, rejectValues) => {
        const request = database
          .transaction("installation_state", "readonly")
          .objectStore("installation_state")
          .getAll();
        request.onerror = () => rejectValues(request.error);
        request.onsuccess = () => resolveValues(request.result);
      });
    });
    expect(rawState.some((value) => typeof value === "string")).toBe(false);

    await first.close();
    await expect(fixture.command({ command: "revoke-all" })).resolves.toMatchObject({ ok: true });
    const reopened = await popup(extension.context, extension.extensionId);
    await reopened.getByRole("button", { name: "Vault settings" }).click();
    await expect(reopened.getByText("Desktop Runtime access was revoked.")).toBeVisible();
  } finally {
    await extension.context.close();
    await fixture.close();
  }
});

test("selects a desktop-owned Vault before any browser-local Vault exists", async ({
  browser: _browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await startFixture();
  await createDesktopVault(fixture);
  const extension = await packagedExtension(testInfo);
  try {
    const first = await popup(extension.context, extension.extensionId);
    await expect(first.getByRole("heading", { name: "Desktop Runtime" })).toBeVisible();
    const approval = fixture.command({ command: "approve-next" });
    await first.getByRole("button", { name: "Connect Desktop Runtime" }).click();
    await expect(approval).resolves.toMatchObject({ ok: true });
    await expect(first.getByRole("heading", { name: "Archive this page" })).toBeVisible();
    const libraryOpened = extension.context.waitForEvent("page");
    await first.getByRole("button", { name: "Open Library" }).click();
    const library = await libraryOpened;
    await expect(library.getByText("Desktop archive", { exact: true })).toBeVisible();
    await expect(library.getByText("Capture a page from the popup to add it here.")).toBeVisible();
    await expect(library.getByRole("heading", { name: "Vault content" })).toBeVisible();

    await library.getByLabel("Folder name").fill("Desktop folder");
    await library.getByRole("button", { name: "Create Folder" }).click();
    await expect(library.getByRole("list", { name: "Folders" })).toContainText("Desktop folder");

    await library.getByLabel("Tag name").fill("Desktop tag");
    await library.getByRole("button", { name: "Create Tag" }).click();
    await expect(library.getByRole("list", { name: "Tags" })).toContainText("Desktop tag");
  } finally {
    await extension.context.close();
    await fixture.command({ command: "revoke-all" });
    await fixture.close();
  }
});
