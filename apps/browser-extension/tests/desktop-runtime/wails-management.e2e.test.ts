import { expect, test } from "@playwright/test";

test("Wails management panel approves and revokes grants without displaying tokens", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const pending = [
      { pairingId: "pair-1", clientName: "browser extension", scopes: ["runtime.vault"] },
    ];
    const grants = [
      {
        grantId: "grant-1",
        clientName: "browser extension",
        scopes: ["runtime.vault"],
        revoked: false,
      },
    ];
    (globalThis as unknown as { go: unknown }).go = {
      main: {
        desktopBinding: {
          PendingPairings: async () => pending,
          ListGrants: async () => grants,
          ApprovePairing: async (pairingId: string) => {
            if (pairingId !== "pair-1") throw new Error("unknown pairing");
            pending.splice(0, 1);
          },
          RevokeGrant: async (grantId: string) => {
            if (grantId !== "grant-1") throw new Error("unknown grant");
            const grant = grants[0];
            if (grant === undefined) throw new Error("grant fixture missing");
            grant.revoked = true;
          },
          RuntimeAddress: () => "127.0.0.1:37373",
        },
      },
    };
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Desktop Runtime" })).toBeVisible();
  await expect(page.getByText("browser extension", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve pairing" })).toBeVisible();
  await page.getByRole("button", { name: "Approve pairing" }).click();
  await expect(page.getByText("No pending pairing requests.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke grant" })).toBeVisible();
  await page.getByRole("button", { name: "Revoke grant" }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("opaque-token");
});

test("Wails Vault surface renders the selected Vault management slice", async ({
  page,
}, testInfo) => {
  const vaultId = "a".repeat(64);
  await page.addInitScript((selectedVaultId) => {
    const state = {
      selectedVaultId,
      vaults: [
        {
          vaultId: selectedVaultId,
          label: "Personal archive",
          lifecycle: "Open",
          access: "Authoring",
          selected: true,
        },
      ],
    };
    (globalThis as unknown as { go: unknown }).go = {
      main: {
        desktopBinding: {
          PendingPairings: async () => [],
          ListGrants: async () => [],
          RuntimeAddress: () => "127.0.0.1:37373",
          VaultCommand: async (request: { type: string }) => {
            if (request.type === "GetState") return state;
            if (request.type === "ListLibraryProjection")
              return {
                captures: [],
                collections: [],
                folders: [],
                tags: [],
                tagAssignments: [],
                notes: [],
                conflicts: [],
              };
            if (request.type === "ListRemotes") return [];
            if (request.type === "GarbageCollect") return { deletedStorageItemIds: [] };
            throw new Error(`unexpected command: ${request.type}`);
          },
          PendingTransfers: async () => [],
        },
      },
    };
  }, vaultId);

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Vaults", exact: true })).toBeVisible();
  await expect(page.getByText("Personal archive · Open · Authoring")).toBeVisible();
  await expect(page.getByRole("button", { name: "Fork this Vault" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Vacuum this Vault" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run Garbage Collection" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Run Garbage Collection" }).click();
  await expect(page.getByText("Garbage Collection completed.")).toBeVisible();
  await expect(page.getByText("No captures are stored in this Vault yet.")).toBeVisible();
  await expect(page.getByText("No Hosted Replicas are configured on this Client.")).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await page.screenshot({ path: testInfo.outputPath("desktop-vaults-wide.png"), fullPage: true });

  await page.evaluate(() => window.localStorage.setItem("awsm.appearance", "dark"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Vaults", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-vaults-dark.png"), fullPage: true });

  await page.evaluate(() => window.localStorage.setItem("awsm.appearance", "light"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Vaults", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("desktop-vaults-narrow-drawer.png"),
  });
});

test("Wails Library surface releases local Artifact bytes and refreshes its projection", async ({
  page,
}, testInfo) => {
  const vaultId = "c".repeat(64);
  const artifactId = "d".repeat(64);
  await page.addInitScript(
    ({ selectedVaultId, selectedArtifactId }) => {
      let availableLocally = true;
      const state = {
        selectedVaultId,
        vaults: [
          {
            vaultId: selectedVaultId,
            label: "Relief archive",
            lifecycle: "Open",
            access: "Authoring",
            selected: true,
          },
        ],
      };
      const calls: Array<{ type: string; objectIds?: readonly string[] }> = [];
      const library = () => [
        {
          bundleId: "e".repeat(64),
          collectionId: "f".repeat(64),
          artifactId: selectedArtifactId,
          capturedAt: 1,
          originalUrl: "https://example.test/article",
          finalUrl: "https://example.test/article",
          title: "Article to release",
          availableLocally,
          lifecycle: "Active",
        },
      ];
      (globalThis as unknown as { go: unknown }).go = {
        main: {
          desktopBinding: {
            PendingPairings: async () => [],
            ListGrants: async () => [],
            RuntimeAddress: () => "127.0.0.1:37373",
            VaultCommand: async (request: { type: string; objectIds?: readonly string[] }) => {
              calls.push(
                request.objectIds === undefined
                  ? { type: request.type }
                  : { type: request.type, objectIds: request.objectIds },
              );
              if (request.type === "GetState") return state;
              if (request.type === "ListLibraryProjection")
                return {
                  captures: library(),
                  collections: [],
                  folders: [],
                  tags: [],
                  tagAssignments: [],
                  notes: [],
                  conflicts: [],
                };
              if (request.type === "ListRemotes") return [];
              if (request.type === "StorageRelief") {
                if (
                  request.objectIds?.length !== 1 ||
                  request.objectIds[0] !== selectedArtifactId
                ) {
                  throw new Error("Storage Relief received the wrong Artifact ID");
                }
                availableLocally = false;
                return {
                  releasedObjectIds: [selectedArtifactId],
                  warning:
                    "Storage Relief removed local Object bytes. Without another retained Replica or export, this data may be unrecoverable.",
                };
              }
              throw new Error(`unexpected command: ${request.type}`);
            },
            PendingTransfers: async () => [],
          },
        },
      };
      (globalThis as unknown as { __awsmCalls?: unknown }).__awsmCalls = calls;
    },
    { selectedVaultId: vaultId, selectedArtifactId: artifactId },
  );

  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Library", exact: true }).last()).toBeVisible();
  await expect(page.getByText("Article to release", { exact: true })).toBeVisible();
  await expect(page.getByText("Available locally", { exact: true })).toBeVisible();
  const releaseButton = page.getByRole("button", { name: "Release local bytes" });
  await expect(releaseButton).toBeVisible();
  const releaseButtonBox = await releaseButton.boundingBox();
  expect(releaseButtonBox?.width).toBeGreaterThanOrEqual(44);
  expect(releaseButtonBox?.height).toBeGreaterThanOrEqual(44);
  await releaseButton.focus();
  await expect(releaseButton).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("desktop-storage-relief-before-wide.png"),
    fullPage: true,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await releaseButton.click();
  await expect(page.getByText("Needs hydration", { exact: true })).toBeVisible();
  await expect(page.getByText("Storage Relief completed.", { exact: false })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop-storage-relief-wide.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("heading", { name: "Library", exact: true }).last().scrollIntoViewIfNeeded();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await page.screenshot({ path: testInfo.outputPath("desktop-storage-relief-narrow.png") });
  const observed = await page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __awsmCalls: Array<{ type: string; objectIds?: readonly string[] }>;
        }
      ).__awsmCalls,
  );
  expect(observed).toContainEqual({ type: "StorageRelief", objectIds: [artifactId] });
});

test("Wails Vault creation can recover a pending setup without exposing its phrase", async ({
  page,
}) => {
  const vaultId = "b".repeat(64);
  await page.addInitScript((selectedVaultId) => {
    const state: {
      selectedVaultId: string;
      pendingVaultCreation: { setupId: string; expectedVaultId: string | null } | undefined;
      vaults: never[];
    } = {
      selectedVaultId,
      pendingVaultCreation: { setupId: "setup-1", expectedVaultId: selectedVaultId },
      vaults: [],
    };
    (globalThis as unknown as { go: unknown }).go = {
      main: {
        desktopBinding: {
          PendingPairings: async () => [],
          ListGrants: async () => [],
          RuntimeAddress: () => "127.0.0.1:37373",
          VaultCommand: async (request: { type: string }) => {
            if (request.type === "GetState") return state;
            if (request.type === "CancelVaultCreation") {
              state.pendingVaultCreation = undefined;
              return null;
            }
            if (request.type === "ListLibraryProjection" || request.type === "ListRemotes")
              return request.type === "ListRemotes"
                ? []
                : {
                    captures: [],
                    collections: [],
                    folders: [],
                    tags: [],
                    tagAssignments: [],
                    notes: [],
                    conflicts: [],
                  };
            throw new Error(`unexpected command: ${request.type}`);
          },
          PendingTransfers: async () => [],
        },
      },
    };
  }, vaultId);

  await page.goto("/");
  await expect(page.getByText("The Recovery Phrase is not stored by this Client")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Create a Vault on this desktop Client.")).toBeVisible();
});

test("Wails Vault surface exports and imports a Complete Export package", async ({
  page,
}, testInfo) => {
  const vaultId = "f".repeat(64);
  await page.addInitScript((selectedVaultId) => {
    const state = {
      selectedVaultId,
      vaults: [
        {
          vaultId: selectedVaultId,
          label: "Portable archive",
          lifecycle: "Open",
          access: "Authoring",
          selected: true,
        },
      ],
    };
    const calls: string[] = [];
    (globalThis as unknown as { go: unknown }).go = {
      main: {
        desktopBinding: {
          PendingPairings: async () => [],
          ListGrants: async () => [],
          RuntimeAddress: () => "127.0.0.1:37373",
          VaultCommand: async (request: { type: string }) => {
            calls.push(request.type);
            if (request.type === "GetState") return state;
            if (request.type === "ListLibraryProjection" || request.type === "ListRemotes")
              return request.type === "ListRemotes"
                ? []
                : {
                    captures: [],
                    collections: [],
                    folders: [],
                    tags: [],
                    tagAssignments: [],
                    notes: [],
                    conflicts: [],
                  };
            if (request.type === "ExportComplete") return { package: "encrypted-complete-export" };
            if (request.type === "ImportComplete") return state;
            throw new Error(`unexpected command: ${request.type}`);
          },
          PendingTransfers: async () => [],
        },
      },
    };
    (globalThis as unknown as { __awsmCalls?: string[] }).__awsmCalls = calls;
  }, vaultId);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Complete Export and Import" })).toBeVisible();
  await page.getByLabel("Export passphrase").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create Complete Export" }).click();
  await expect(page.getByLabel("Complete Export package", { exact: true })).toHaveValue(
    "encrypted-complete-export",
  );
  await page.getByLabel("Import passphrase").fill("correct horse battery staple");
  await page
    .getByLabel("Complete Export package to import", { exact: true })
    .fill("encrypted-complete-export");
  await page.getByRole("button", { name: "Import Complete Export" }).click();
  await expect(page.getByText("Complete Import completed.")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop-vaults-export-import.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("heading", { name: "Complete Export and Import" }).scrollIntoViewIfNeeded();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await page.screenshot({ path: testInfo.outputPath("desktop-vaults-export-import-narrow.png") });
  await page.getByRole("button", { name: "Import Complete Export" }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("desktop-vaults-export-import-narrow-controls.png"),
  });
  const observed = await page.evaluate(
    () => (globalThis as unknown as { __awsmCalls: string[] }).__awsmCalls,
  );
  expect(observed).toEqual([
    "GetState",
    "ListLibraryProjection",
    "ListRemotes",
    "ExportComplete",
    "ImportComplete",
    "GetState",
    "ListLibraryProjection",
    "ListRemotes",
  ]);
});

test("Wails Vault surface runs hosted pull, materialization, and Artifact hydration actions", async ({
  page,
}) => {
  const vaultId = "c".repeat(64);
  const artifactId = "d".repeat(64);
  await page.addInitScript(
    ({ selectedVaultId, artifactId }) => {
      const state = {
        selectedVaultId,
        vaults: [
          {
            vaultId: selectedVaultId,
            label: "Hosted archive",
            lifecycle: "Open",
            access: "Authoring",
            selected: true,
          },
        ],
      };
      const library = [
        {
          bundleId: "bundle-1",
          artifactId,
          title: "Remote capture",
          finalUrl: "https://example.test/remote",
          availableLocally: false,
          lifecycle: "Active",
        },
      ];
      const remotes = [
        {
          remoteId: "remote-1",
          name: "Home Host",
          endpoint: "https://host.example.test",
          enabled: true,
          replicaHandle: "11111111-1111-4111-8111-111111111111",
        },
      ];
      const target = globalThis as unknown as { go: unknown };
      target.go = {
        main: {
          desktopBinding: {
            PendingPairings: async () => [],
            ListGrants: async () => [],
            RuntimeAddress: () => "127.0.0.1:37373",
            VaultCommand: async (request: { type: string }) => {
              if (request.type === "GetState") return state;
              if (request.type === "ListLibraryProjection")
                return {
                  captures: library,
                  collections: [],
                  folders: [],
                  tags: [],
                  tagAssignments: [],
                  notes: [],
                  conflicts: [],
                };
              if (request.type === "ListRemotes") return remotes;
              if (request.type === "MaterializeHostedReplica") {
                (globalThis as unknown as { __awsmCalls?: string[] }).__awsmCalls?.push(
                  request.type,
                );
                return { remoteId: "remote-1", materializedCompactItemCount: 1 };
              }
              if (request.type === "PullHostedReplicas") {
                (globalThis as unknown as { __awsmCalls?: string[] }).__awsmCalls?.push(
                  request.type,
                );
                return [{ remoteId: "remote-1", status: "Completed" }];
              }
              if (request.type === "HydrateArtifact") {
                (globalThis as unknown as { __awsmCalls?: string[] }).__awsmCalls?.push(
                  request.type,
                );
                const firstLibraryItem = library[0];
                if (firstLibraryItem === undefined) {
                  throw new Error("fixture library is unexpectedly empty");
                }
                firstLibraryItem.availableLocally = true;
                return { artifactId, storageItemId: "e".repeat(64), remoteId: "remote-1" };
              }
              throw new Error(`unexpected command: ${request.type}`);
            },
            PendingTransfers: async () => [],
          },
        },
      };
      (globalThis as unknown as { __awsmCalls?: string[] }).__awsmCalls = [];
    },
    { selectedVaultId: vaultId, artifactId },
  );

  await page.goto("/");
  await expect(page.getByText("Home Host", { exact: true })).toBeVisible();
  await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Materialize now" }).click();
  await expect(page.getByText("Hosted Replica materialized.")).toBeVisible();
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.getByText("Hosted Replica pull completed.")).toBeVisible();
  await page.getByRole("button", { name: "Hydrate Artifact" }).click();
  await expect(page.getByText("Available locally")).toBeVisible();
  const observed = await page.evaluate(
    () => (globalThis as unknown as { __awsmCalls: string[] }).__awsmCalls,
  );
  expect(observed).toEqual(["MaterializeHostedReplica", "PullHostedReplicas", "HydrateArtifact"]);
});
