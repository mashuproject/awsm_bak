import { expect, test } from "@playwright/test";
import {
  activeGeneration,
  applyUnionWithVisuals,
  appRequest,
  archiveFixture,
  createSynchronizedClient,
  extractNewestCapture,
  faultControl,
  interruptSwitch,
  localAuthoritySnapshot,
  loginSynchronizedClient,
  sharedDeletedBase,
  vacuumDeleted,
  waitForSynchronizedState,
} from "./server-switch-support";

test("publishes a live source Vault to an empty candidate server", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(900_000);
  expect(browserName).toBe("chromium");
  const password = "correct horse archive battery";
  const sourceEmail = `empty-source-${crypto.randomUUID()}@example.test`;
  const candidateEmail = `empty-candidate-${crypto.randomUUID()}@example.test`;
  const source = await createSynchronizedClient(
    testInfo,
    "empty-candidate-source",
    "http://127.0.0.1:3300",
    sourceEmail,
    password,
  );
  let observer: Awaited<ReturnType<typeof loginSynchronizedClient>> | undefined;
  try {
    const library = await source.context.newPage();
    await library.goto(`chrome-extension://${source.extensionId}/library.html`);
    const fixture = await source.context.newPage();
    await fixture.goto("http://127.0.0.1:4174/fixture");
    for (let index = 1; index <= 3; index += 1) {
      await fixture.evaluate((number) => {
        document.title = `Empty candidate baseline ${String(number)}`;
        document.body.dataset.emptyCandidateBaseline = String(number);
      }, index);
      await archiveFixture(source, fixture, index);
    }
    const baseline = await appRequest<
      readonly {
        collectionId: string;
        captures: readonly { bundleId: string }[];
      }[]
    >(library, { type: "ListLibrary", expectedVaultId: source.vaultId });
    const bundleIds = baseline.flatMap((group) =>
      group.captures.map((capture) => capture.bundleId),
    );
    expect(bundleIds).toHaveLength(3);
    await appRequest(library, {
      type: "ExtractCaptures",
      expectedVaultId: source.vaultId,
      bundleIds: [bundleIds[0]],
    });
    await appRequest(library, {
      type: "DeleteCaptures",
      expectedVaultId: source.vaultId,
      bundleIds: [bundleIds[1]],
    });
    await waitForSynchronizedState(library, "http://127.0.0.1:3300");
    observer = await loginSynchronizedClient(
      testInfo,
      "empty-candidate-source-observer",
      "http://127.0.0.1:3300",
      sourceEmail,
      password,
    );
    const observerLibrary = await observer.context.newPage();
    await observerLibrary.goto(`chrome-extension://${observer.extensionId}/library.html`);

    await library.getByRole("button", { name: "Settings" }).click();
    await library.getByRole("tab", { name: "Account" }).click();
    let settings = library.getByRole("dialog", {
      name: "Settings",
    });
    await settings
      .getByRole("textbox", { name: "Change synchronization server" })
      .fill("http://127.0.0.1:3301");
    await settings.getByLabel(/verify and reconcile the candidate/u).check();
    await settings.getByRole("button", { name: "Change server" }).click();
    await expect(settings).toBeHidden({ timeout: 60_000 });
    await library.getByRole("button", { name: "Settings" }).click();
    await library.getByRole("tab", { name: "Account" }).click();
    settings = library.getByRole("dialog", {
      name: "Settings",
    });
    await expect(settings.getByText(/current server remains active/u)).toBeVisible();
    await library.screenshot({
      path: testInfo.outputPath("server-switch-login-desktop.png"),
    });
    await library.setViewportSize({ width: 420, height: 800 });
    await library.screenshot({
      path: testInfo.outputPath("server-switch-login-narrow.png"),
    });
    await library.setViewportSize({ width: 1280, height: 900 });

    await fixture.evaluate(() => {
      document.title = "Source mutation during candidate authentication";
      document.body.dataset.sourceStillLive = "true";
    });
    await archiveFixture(source, fixture, 3);
    await waitForSynchronizedState(library, "http://127.0.0.1:3300");
    await waitForSynchronizedState(observerLibrary, "http://127.0.0.1:3300");
    const observerBeforePromotion = await appRequest<readonly { captures: readonly unknown[] }[]>(
      observerLibrary,
      {
        type: "ListLibrary",
        expectedVaultId: observer.vaultId,
      },
    );
    expect(observerBeforePromotion.reduce((total, group) => total + group.captures.length, 0)).toBe(
      3,
    );

    await settings.getByRole("textbox", { name: "Email" }).fill(candidateEmail);
    await settings.getByLabel("Password").fill(password);
    await faultControl(library, "arm", "server-switch:after-classification");
    await settings.getByRole("button", { name: "Create account" }).click();
    await expect
      .poll(async () => (await faultControl(library, "status")).reached, {
        timeout: 120_000,
      })
      .toBe(true);
    const progress = await source.context.newPage();
    await progress.goto(`chrome-extension://${source.extensionId}/library.html`);
    await progress.getByRole("button", { name: "Settings" }).click();
    await expect(
      progress.getByText("Publishing this Vault to the candidate server…"),
    ).toBeVisible();
    await progress.screenshot({
      path: testInfo.outputPath("server-switch-publish-desktop.png"),
    });
    await progress.setViewportSize({ width: 420, height: 800 });
    await progress.screenshot({
      path: testInfo.outputPath("server-switch-publish-narrow.png"),
    });
    await progress.close();
    await faultControl(library, "release");
    await waitForSynchronizedState(library, "http://127.0.0.1:3301");

    const candidateDeleted = await appRequest<readonly unknown[]>(library, {
      type: "ListDeleted",
      expectedVaultId: source.vaultId,
    });
    expect(candidateDeleted).toHaveLength(1);
    const candidateGroups = await appRequest<
      readonly { collectionId: string; captures: readonly unknown[] }[]
    >(library, { type: "ListLibrary", expectedVaultId: source.vaultId });
    expect(candidateGroups.reduce((total, group) => total + group.captures.length, 0)).toBe(3);
    expect(new Set(candidateGroups.map((group) => group.collectionId)).size).toBe(2);

    await fixture.evaluate(() => {
      document.title = "Candidate-only post-switch mutation";
      document.body.dataset.candidateOnly = "true";
    });
    await archiveFixture(source, fixture, 4);
    await waitForSynchronizedState(library, "http://127.0.0.1:3301");
    await appRequest(observerLibrary, { type: "WakeSynchronization" });
    await waitForSynchronizedState(observerLibrary, "http://127.0.0.1:3300");
    const sourceAfterPromotion = await appRequest<readonly { captures: readonly unknown[] }[]>(
      observerLibrary,
      {
        type: "ListLibrary",
        expectedVaultId: observer.vaultId,
      },
    );
    expect(sourceAfterPromotion.reduce((total, group) => total + group.captures.length, 0)).toBe(3);
    await library.getByRole("button", { name: "Settings" }).click();
    await library.screenshot({
      path: testInfo.outputPath("server-switch-success-desktop.png"),
    });
    await library.setViewportSize({ width: 420, height: 800 });
    await library.screenshot({
      path: testInfo.outputPath("server-switch-success-narrow.png"),
    });
  } finally {
    await observer?.context.close();
    await source.context.close();
  }
});

test("fast-forwards a candidate server from an exact recovered predecessor", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(600_000);
  expect(browserName).toBe("chromium");
  const setup = await sharedDeletedBase(testInfo, "candidate-behind");
  try {
    const predecessor = await activeGeneration(setup.page);
    await vacuumDeleted(setup.page, setup.client.vaultId);
    const successor = await activeGeneration(setup.page);
    expect(successor.generationNumber).toBe(predecessor.generationNumber + 1);
    await interruptSwitch(
      setup.client,
      testInfo,
      setup.page,
      "http://127.0.0.1:3300",
      setup.sourceEmail,
      setup.password,
      "server-switch:after-remote-activation",
      "server-switch-fast-forward-candidate",
    );
    expect(await activeGeneration(setup.page)).toEqual(successor);
  } finally {
    await setup.client.context.close();
  }
});

test("fast-forwards a stale local Replica from a candidate successor", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(600_000);
  expect(browserName).toBe("chromium");
  const setup = await sharedDeletedBase(testInfo, "candidate-ahead");
  let stale: Awaited<ReturnType<typeof loginSynchronizedClient>> | undefined;
  try {
    stale = await loginSynchronizedClient(
      testInfo,
      "candidate-ahead-stale",
      "http://127.0.0.1:3300",
      setup.sourceEmail,
      setup.password,
    );
    const stalePage = await stale.context.newPage();
    await stalePage.goto(`chrome-extension://${stale.extensionId}/library.html`);
    const liveSurface = await stale.context.newPage();
    await liveSurface.goto(`chrome-extension://${stale.extensionId}/library.html`);
    await liveSurface.getByText("Deleted (1)", { exact: true }).click();
    await expect(liveSurface.locator(".deleted-section .card")).toHaveCount(1);
    const predecessor = await activeGeneration(stalePage);
    await vacuumDeleted(setup.page, setup.client.vaultId);
    const successor = await activeGeneration(setup.page);
    const candidateAuthority = await localAuthoritySnapshot(setup.page);
    expect(successor.generationNumber).toBe(predecessor.generationNumber + 1);
    const before = await appRequest<readonly { captures: readonly unknown[] }[]>(stalePage, {
      type: "ListDeleted",
      expectedVaultId: stale.vaultId,
    });
    expect(before).toHaveLength(1);
    await interruptSwitch(
      stale,
      testInfo,
      stalePage,
      "http://127.0.0.1:3301",
      setup.candidateEmail,
      setup.password,
      "server-switch:before-local-activation",
      "server-switch-fast-forward-local",
    );
    expect(await activeGeneration(stalePage)).toEqual(successor);
    await expect(liveSurface.getByText("Deleted is empty.")).toBeVisible({
      timeout: 60_000,
    });
    await stalePage.getByText("Deleted (0)", { exact: true }).click();
    await expect(stalePage.getByText("Deleted is empty.")).toBeVisible();
    expect(await localAuthoritySnapshot(stalePage)).toEqual(candidateAuthority);
  } finally {
    await stale?.context.close();
    await setup.client.context.close();
  }
});

test("unions independent append-only Events in the same Generation", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(600_000);
  expect(browserName).toBe("chromium");
  const setup = await sharedDeletedBase(testInfo, "union");
  let source: Awaited<ReturnType<typeof loginSynchronizedClient>> | undefined;
  let freshCandidate: Awaited<ReturnType<typeof loginSynchronizedClient>> | undefined;
  try {
    source = await loginSynchronizedClient(
      testInfo,
      "union-source-branch",
      "http://127.0.0.1:3300",
      setup.sourceEmail,
      setup.password,
    );
    const sourcePage = await source.context.newPage();
    await sourcePage.goto(`chrome-extension://${source.extensionId}/library.html`);
    const candidateFixture = await setup.client.context.newPage();
    await candidateFixture.goto("http://127.0.0.1:4174/fixture");
    await candidateFixture.evaluate(() => {
      document.title = "Candidate-only Capture";
      document.body.dataset.branch = "candidate";
    });
    await archiveFixture(setup.client, candidateFixture, 3);
    await extractNewestCapture(setup.page, setup.client.vaultId);
    const sourceFixture = await source.context.newPage();
    await sourceFixture.goto("http://127.0.0.1:4174/fixture");
    await sourceFixture.evaluate(() => {
      document.title = "Source-only Capture";
      document.body.dataset.branch = "source";
    });
    await archiveFixture(source, sourceFixture, 3);
    await extractNewestCapture(sourcePage, source.vaultId);
    await applyUnionWithVisuals(
      source,
      testInfo,
      sourcePage,
      "http://127.0.0.1:3301",
      setup.candidateEmail,
      setup.password,
    );
    const groups = await appRequest<
      readonly { collectionId: string; captures: readonly unknown[] }[]
    >(sourcePage, { type: "ListLibrary", expectedVaultId: source.vaultId });
    expect(groups.reduce((total, group) => total + group.captures.length, 0)).toBe(4);
    expect(new Set(groups.map((group) => group.collectionId)).size).toBe(4);
    freshCandidate = await loginSynchronizedClient(
      testInfo,
      "union-fresh-candidate",
      "http://127.0.0.1:3301",
      setup.candidateEmail,
      setup.password,
    );
    const freshPage = await freshCandidate.context.newPage();
    await freshPage.goto(`chrome-extension://${freshCandidate.extensionId}/library.html`);
    const freshGroups = await appRequest<
      readonly { collectionId: string; captures: readonly unknown[] }[]
    >(freshPage, {
      type: "ListLibrary",
      expectedVaultId: freshCandidate.vaultId,
    });
    expect(freshGroups.reduce((total, group) => total + group.captures.length, 0)).toBe(4);
    expect(new Set(freshGroups.map((group) => group.collectionId)).size).toBe(4);
  } finally {
    await freshCandidate?.context.close();
    await source?.context.close();
    await setup.client.context.close();
  }
});

test("reports sibling successor Generations as a conflict without changing servers", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(600_000);
  expect(browserName).toBe("chromium");
  const setup = await sharedDeletedBase(testInfo, "sibling-conflict");
  let sibling: Awaited<ReturnType<typeof loginSynchronizedClient>> | undefined;
  try {
    sibling = await loginSynchronizedClient(
      testInfo,
      "sibling-conflict-source",
      "http://127.0.0.1:3300",
      setup.sourceEmail,
      setup.password,
    );
    const siblingPage = await sibling.context.newPage();
    await siblingPage.goto(`chrome-extension://${sibling.extensionId}/library.html`);
    await vacuumDeleted(setup.page, setup.client.vaultId);
    await vacuumDeleted(siblingPage, sibling.vaultId);
    const localSuccessor = await activeGeneration(setup.page);
    const remoteSuccessor = await activeGeneration(siblingPage);
    expect(remoteSuccessor.generationId).not.toBe(localSuccessor.generationId);
    await appRequest(setup.page, {
      type: "BeginServerSwitch",
      candidateOrigin: "http://127.0.0.1:3300",
      expectedVaultId: setup.client.vaultId,
    });
    const state = await appRequest<{
      account: { configuration: { serverOrigin?: string } };
      serverSwitch?: { state: string; reason?: string };
    }>(setup.page, {
      type: "LoginServerSwitchCandidate",
      email: setup.sourceEmail,
      password: setup.password,
    });
    expect(state).toMatchObject({
      account: { configuration: { serverOrigin: "http://127.0.0.1:3301" } },
      serverSwitch: { state: "Conflict", reason: "DivergedGeneration" },
    });
    expect(await activeGeneration(setup.page)).toEqual(localSuccessor);
    await setup.page.getByRole("button", { name: "Settings" }).click();
    await setup.page.getByRole("tab", { name: "Account" }).click();
    await expect(setup.page.getByRole("heading", { name: "Server switch conflict" })).toBeVisible();
    const text = await setup.page.getByRole("dialog", { name: "Settings" }).innerText();
    expect(text).not.toMatch(/(?:Generation|Object|Event|Account|key) ID|ciphertext/iu);
    await setup.page.screenshot({
      path: testInfo.outputPath("server-switch-conflict-desktop.png"),
    });
    await setup.page.setViewportSize({ width: 420, height: 800 });
    await setup.page.screenshot({
      path: testInfo.outputPath("server-switch-conflict-narrow.png"),
    });
    const fixture = await setup.client.context.newPage();
    await fixture.goto("http://127.0.0.1:4174/fixture");
    await archiveFixture(setup.client, fixture, 3);
    try {
      await waitForSynchronizedState(setup.page, "http://127.0.0.1:3301");
    } catch (error) {
      const diagnostic = await faultControl(setup.page, "status");
      throw new Error(
        `Post-conflict source synchronization failed (${JSON.stringify(diagnostic.lastFailure)})`,
        { cause: error },
      );
    }
    expect(await activeGeneration(siblingPage)).toEqual(remoteSuccessor);
  } finally {
    await sibling?.context.close();
    await setup.client.context.close();
  }
});
