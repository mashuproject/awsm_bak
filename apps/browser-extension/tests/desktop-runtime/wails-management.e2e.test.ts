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
          replicaAvailability: "Complete",
          missingArtifactCount: 0,
          clientCredentialId: "2".repeat(64),
          selected: true,
        },
      ],
    };
    const authority = {
      vaultId: selectedVaultId,
      activeMemberIds: ["1".repeat(64)],
      administratorIds: ["1".repeat(64)],
      administratorConflicts: [],
      activeInvitationIds: [],
      invitationConflictIds: [],
      activeClientCredentialIds: ["2".repeat(64)],
      effectiveRecoveryCredentialIds: ["3".repeat(64)],
      recoveryConflicts: [],
      keyEpochConflicts: [],
      currentKeyEpochIds: ["4".repeat(64)],
      lifecycle: "Open",
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
            if (request.type === "GetAuthorityState") return authority;
            if (request.type === "GarbageCollect") return { deletedStorageItemIds: [] };
            if (request.type === "RotateKeyEpoch")
              return {
                keyEpochId: "5".repeat(64),
                displayNumber: 1,
                eventRecordId: "6".repeat(64),
              };
            if (request.type === "EndClientCredential") {
              const selected = state.vaults[0];
              if (selected === undefined) throw new Error("selected Vault fixture missing");
              selected.access = "ReadOnly";
              authority.activeClientCredentialIds = [];
              return {
                targetClientCredentialId: "2".repeat(64),
                eventRecordId: "7".repeat(64),
              };
            }
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
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Vaults" }),
  ).toHaveCount(1);
  await expect(
    page.getByText("Personal archive · Open · Authoring · Replica complete"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Fork this Vault" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Vault authority" })).toBeVisible();
  await expect(page.getByText("Active members", { exact: true })).toBeVisible();
  await expect(page.getByText("Active invitations", { exact: true })).toBeVisible();
  await expect(page.getByText("Current Key Epochs", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Vacuum this Vault" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run Garbage Collection" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rotate Key Epoch" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Run Garbage Collection" }).click();
  await expect(page.getByText("Garbage Collection completed.")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Rotate Key Epoch" }).click();
  await expect(page.getByText("Vault Key Epoch 1 is now current.")).toBeVisible();
  await expect(page.getByRole("button", { name: "End this Client Credential" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "End this Client Credential" }).click();
  await expect(
    page.getByText("This Client Credential has ended; the Vault is now read-only here."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Change Recovery Phrase" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rotate Key Epoch" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run Garbage Collection" })).toBeVisible();
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

test("Wails Vault surface authors an Invitation through the Runtime command boundary", async ({
  page,
}, testInfo) => {
  const vaultId = "b".repeat(64);
  await page.addInitScript((selectedVaultId) => {
    const state = {
      selectedVaultId,
      vaults: [
        {
          vaultId: selectedVaultId,
          label: "Invitation archive",
          lifecycle: "Open",
          access: "Authoring",
          replicaAvailability: "Complete",
          missingArtifactCount: 0,
          clientCredentialId: "2".repeat(64),
          selected: true,
        },
      ],
    };
    const authority = {
      vaultId: selectedVaultId,
      activeMemberIds: ["1".repeat(64)],
      administratorIds: ["1".repeat(64)],
      administratorConflicts: [],
      activeInvitationIds: [],
      invitationConflictIds: [],
      activeClientCredentialIds: ["2".repeat(64)],
      effectiveRecoveryCredentialIds: ["3".repeat(64)],
      recoveryConflicts: [],
      keyEpochConflicts: [],
      currentKeyEpochIds: ["4".repeat(64)],
      lifecycle: "Open",
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
            if (request.type === "GetAuthorityState") return authority;
            if (request.type === "CreateInvitation")
              return {
                invitationId: "5".repeat(64),
                eventRecordId: "6".repeat(64),
                redemptionSecret: "redemption-secret",
                cancellationSecret: "cancellation-secret",
                redemptionVerifier: "redemption-verifier",
                cancellationVerifier: "cancellation-verifier",
              };
            if (request.type === "AcceptInvitation")
              return {
                invitationId: "5".repeat(64),
                memberId: "7".repeat(64),
                clientCredentialId: "8".repeat(64),
                recoveryCredentialId: "9".repeat(64),
                eventRecordId: "a".repeat(64),
              };
            throw new Error(`unexpected command: ${request.type}`);
          },
          PendingTransfers: async () => [],
        },
      },
    };
  }, vaultId);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Invitation operations" })).toBeVisible();
  await page.getByLabel("Invitation capability CBOR values").fill("capability-cbor");
  await page.getByLabel("Redemption Authority ID").fill("authority-id");
  await page.getByLabel("Receipt verification key").fill("receipt-key");
  await page.getByRole("button", { name: "Create Invitation" }).click();
  await expect(page.getByRole("heading", { name: "Invitation created." })).toBeVisible();
  await expect(page.getByLabel("Redemption Capability seed")).toHaveValue("redemption-secret");
  await expect(page.getByLabel("Cancellation Capability seed")).toHaveValue("cancellation-secret");
  await page.getByLabel("Invitation Join Request CBOR").fill("join-request");
  await page.getByLabel("Invitation Acceptance Proposal CBOR").fill("acceptance-proposal");
  await page.getByLabel("Consumed Invitation receipt CBOR").fill("consumed-receipt");
  await page.getByRole("button", { name: "Record Invitation acceptance" }).click();
  await expect(page.getByRole("heading", { name: "Invitation accepted." })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop-invitation-wide.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  await page.screenshot({
    path: testInfo.outputPath("desktop-invitation-narrow.png"),
    fullPage: true,
  });
});

test("Wails Vault surface authors an Administrator role change", async ({ page }) => {
  const vaultId = "c".repeat(64);
  await page.addInitScript((selectedVaultId) => {
    const state = {
      selectedVaultId,
      vaults: [
        {
          vaultId: selectedVaultId,
          label: "Authority archive",
          lifecycle: "Open",
          access: "Authoring",
          replicaAvailability: "Complete",
          missingArtifactCount: 0,
          clientCredentialId: "2".repeat(64),
          selected: true,
        },
      ],
    };
    const authority = {
      vaultId: selectedVaultId,
      activeMemberIds: ["1".repeat(64), "3".repeat(64)],
      administratorIds: ["1".repeat(64)],
      administratorConflicts: [],
      activeInvitationIds: [],
      invitationConflictIds: [],
      activeClientCredentialIds: ["2".repeat(64)],
      effectiveRecoveryCredentialIds: ["4".repeat(64)],
      recoveryConflicts: [],
      keyEpochConflicts: [],
      currentKeyEpochIds: ["5".repeat(64)],
      lifecycle: "Open",
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
            if (request.type === "GetAuthorityState") return authority;
            if (request.type === "GrantAdministrator") return { eventRecordId: "6".repeat(64) };
            throw new Error(`unexpected command: ${request.type}`);
          },
          PendingTransfers: async () => [],
        },
      },
    };
  }, vaultId);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Authority operations" })).toBeVisible();
  await page.getByLabel("Target Member ID").fill("3".repeat(64));
  await page.getByRole("button", { name: "Grant Administrator" }).click();
  await expect(page.getByRole("heading", { name: "Administrator granted." })).toBeVisible();
});

test("Wails Vault surface recovers an imported Open Replica", async ({ page }) => {
  const vaultId = "d".repeat(64);
  await page.addInitScript((selectedVaultId) => {
    const state = {
      selectedVaultId,
      vaults: [
        {
          vaultId: selectedVaultId,
          label: "Imported archive",
          lifecycle: "Open",
          access: "ReadOnly",
          replicaAvailability: "Complete",
          missingArtifactCount: 0,
          selected: true,
        },
      ],
    };
    const authority = {
      vaultId: selectedVaultId,
      activeMemberIds: ["1".repeat(64)],
      administratorIds: ["1".repeat(64)],
      administratorConflicts: [],
      activeInvitationIds: [],
      invitationConflictIds: [],
      activeClientCredentialIds: [],
      effectiveRecoveryCredentialIds: ["3".repeat(64)],
      recoveryConflicts: [],
      keyEpochConflicts: [],
      currentKeyEpochIds: ["4".repeat(64)],
      lifecycle: "Open",
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
            if (request.type === "GetAuthorityState") return authority;
            if (request.type === "RecoverMember") return { clientCredentialId: "5".repeat(64) };
            throw new Error(`unexpected command: ${request.type}`);
          },
          PendingTransfers: async () => [],
        },
      },
    };
  }, vaultId);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Recover this Client Credential" })).toBeVisible();
  await page.getByLabel("Recovery Phrase").fill("abandon abandon abandon abandon abandon abandon");
  await page.getByRole("button", { name: "Recover Member" }).click();
  await expect(page.getByRole("heading", { name: "Client Credential recovered." })).toBeVisible();
});

test("Wails Vault projections reconcile from a Runtime invalidation without reload", async ({
  page,
}) => {
  const vaultId = "a".repeat(64);
  await page.addInitScript((selectedVaultId) => {
    const state = {
      selectedVaultId,
      vaults: [
        {
          vaultId: selectedVaultId,
          label: "Live archive",
          lifecycle: "Open",
          access: "Authoring",
          replicaAvailability: "Complete",
          missingArtifactCount: 0,
          clientCredentialId: "2".repeat(64),
          selected: true,
        },
      ],
    };
    const authority = {
      vaultId: selectedVaultId,
      activeMemberIds: ["1".repeat(64)],
      administratorIds: ["1".repeat(64)],
      administratorConflicts: [],
      activeInvitationIds: [],
      invitationConflictIds: [],
      activeClientCredentialIds: ["2".repeat(64)],
      effectiveRecoveryCredentialIds: ["3".repeat(64)],
      recoveryConflicts: [],
      keyEpochConflicts: [],
      currentKeyEpochIds: ["4".repeat(64)],
      lifecycle: "Open",
    };
    const listeners = new Set<() => void>();
    const emitInvalidation = () =>
      listeners.forEach((listener) => {
        listener();
      });
    (globalThis as unknown as { runtime: unknown }).runtime = {
      EventsOn: (name: string, listener: () => void) => {
        if (name === "awsm.runtime.invalidated") listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    (globalThis as unknown as { mutateAndEmit: () => void }).mutateAndEmit = () => {
      state.vaults[0].access = "ReadOnly";
      state.vaults[0].replicaAvailability = "Sparse";
      state.vaults[0].missingArtifactCount = 1;
      authority.activeClientCredentialIds = [];
      emitInvalidation();
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
            if (request.type === "GetAuthorityState") return authority;
            throw new Error(`unexpected command: ${request.type}`);
          },
        },
      },
    };
  }, vaultId);

  await page.goto("/");
  await expect(page.getByText("Live archive · Open · Authoring · Replica complete")).toBeVisible();
  await page.evaluate(() =>
    (globalThis as unknown as { mutateAndEmit: () => void }).mutateAndEmit(),
  );
  await expect(
    page.getByText("Live archive · Open · ReadOnly · 1 Artifact needs hydration"),
  ).toBeVisible();
  await expect(page.getByText("Client credentials", { exact: true }).locator("..")).toContainText(
    "0",
  );
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
      const authority = {
        vaultId: selectedVaultId,
        activeMemberIds: ["1".repeat(64)],
        administratorIds: ["1".repeat(64)],
        administratorConflicts: [],
        activeInvitationIds: [],
        invitationConflictIds: [],
        activeClientCredentialIds: ["2".repeat(64)],
        effectiveRecoveryCredentialIds: ["3".repeat(64)],
        recoveryConflicts: [],
        keyEpochConflicts: [],
        currentKeyEpochIds: ["4".repeat(64)],
        lifecycle: "Open",
      };
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
              if (request.type === "GetAuthorityState") return authority;
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
            if (request.type === "GetAuthorityState") {
              return {
                vaultId: selectedVaultId,
                activeMemberIds: [],
                administratorIds: [],
                administratorConflicts: [],
                activeInvitationIds: [],
                invitationConflictIds: [],
                activeClientCredentialIds: [],
                effectiveRecoveryCredentialIds: [],
                recoveryConflicts: [],
                keyEpochConflicts: [],
                currentKeyEpochIds: [],
                lifecycle: "Open",
              };
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
    const authority = {
      vaultId: selectedVaultId,
      activeMemberIds: ["1".repeat(64)],
      administratorIds: ["1".repeat(64)],
      administratorConflicts: [],
      activeInvitationIds: [],
      invitationConflictIds: [],
      activeClientCredentialIds: ["2".repeat(64)],
      effectiveRecoveryCredentialIds: ["3".repeat(64)],
      recoveryConflicts: [],
      keyEpochConflicts: [],
      currentKeyEpochIds: ["4".repeat(64)],
      lifecycle: "Open",
    };
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
            if (request.type === "GetAuthorityState") return authority;
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
    "GetAuthorityState",
    "ExportComplete",
    "ImportComplete",
    "GetState",
    "ListLibraryProjection",
    "ListRemotes",
    "GetAuthorityState",
  ]);
});

test("Wails Vault surface runs hosted pull, materialization, and Artifact hydration actions", async ({
  page,
}, testInfo) => {
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
      let remotes = [
        {
          remoteId: "remote-1",
          name: "Home Host",
          endpoint: "https://host.example.test",
          enabled: true,
          replicaHandle: "11111111-1111-4111-8111-111111111111",
        },
      ];
      const attachmentSetupId = "attachment-setup-1";
      const attachmentReplicaHandle = "22222222-2222-4222-8222-222222222222";
      const authority = {
        vaultId: selectedVaultId,
        activeMemberIds: ["1".repeat(64)],
        administratorIds: ["1".repeat(64)],
        administratorConflicts: [],
        activeInvitationIds: [],
        invitationConflictIds: [],
        activeClientCredentialIds: ["2".repeat(64)],
        effectiveRecoveryCredentialIds: ["3".repeat(64)],
        recoveryConflicts: [],
        keyEpochConflicts: [],
        currentKeyEpochIds: ["4".repeat(64)],
        lifecycle: "Open",
      };
      const target = globalThis as unknown as { go: unknown };
      target.go = {
        main: {
          desktopBinding: {
            PendingPairings: async () => [],
            ListGrants: async () => [],
            RuntimeAddress: () => "127.0.0.1:37373",
            VaultCommand: async (request: {
              type: string;
              remoteId?: string;
              name?: string;
              setupId?: string;
              replicaHandle?: string;
            }) => {
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
              if (request.type === "GetAuthorityState") return authority;
              if (request.type === "BeginHostedReplicaAttachment") {
                (globalThis as unknown as { __awsmCalls?: string[] }).__awsmCalls?.push(
                  request.type,
                );
                return {
                  setupId: attachmentSetupId,
                  replicas: [{ replicaHandle: attachmentReplicaHandle, storedBytes: 4096 }],
                };
              }
              if (request.type === "ConfirmHostedReplicaAttachment") {
                (globalThis as unknown as { __awsmCalls?: string[] }).__awsmCalls?.push(
                  request.type,
                );
                if (
                  request.setupId !== attachmentSetupId ||
                  request.replicaHandle !== attachmentReplicaHandle
                )
                  throw new Error("invalid Hosted Replica attachment");
                const remote = {
                  remoteId: "remote-2",
                  name: "Attached Host",
                  endpoint: "https://attached.example.test",
                  enabled: true,
                  replicaHandle: attachmentReplicaHandle,
                };
                remotes = [...remotes, remote];
                return remote;
              }
              if (request.type === "CancelHostedReplicaAttachment") {
                (globalThis as unknown as { __awsmCalls?: string[] }).__awsmCalls?.push(
                  request.type,
                );
                return null;
              }
              if (request.type === "RenameRemote") {
                const remote = remotes.find((candidate) => candidate.remoteId === request.remoteId);
                if (remote === undefined || request.name === undefined)
                  throw new Error("unknown remote");
                remote.name = request.name;
                return remote;
              }
              if (request.type === "RetireRemote") {
                remotes = remotes.filter((candidate) => candidate.remoteId !== request.remoteId);
                return { remoteId: request.remoteId, retired: true };
              }
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
  await page.getByRole("button", { name: "Attach existing Hosted Replica" }).click();
  await page
    .getByLabel("Hosted Replica HTTPS address for attachment")
    .fill("https://attached.example.test");
  await page.getByLabel("Hosted Replica name for attachment").fill("Attached Host");
  await page.getByLabel("Account username for attachment").fill("alice");
  await page.getByLabel("Account password for attachment").fill("secret");
  await page.getByRole("button", { name: "Find Hosted Replicas" }).click();
  await expect(page.getByRole("heading", { name: "Choose a Hosted Replica" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop-hosted-replica-selection-wide.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("desktop-hosted-replica-selection-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: /^Use Hosted Replica/u }).click();
  await page.getByRole("button", { name: "Attach selected Hosted Replica" }).click();
  await expect(page.getByText("Attached Host", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rename Hosted Replica" }).first().click();
  await page.getByLabel("New Hosted Replica name").fill("Renamed Host");
  await page.getByRole("button", { name: "Save Hosted Replica name" }).click();
  await expect(page.getByText("Renamed Host", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Materialize now" }).first().click();
  await expect(page.getByText("Hosted Replica materialized.")).toBeVisible();
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.getByText("Hosted Replica pull completed.")).toBeVisible();
  await page.getByRole("button", { name: "Hydrate Artifact" }).click();
  await expect(page.getByText("Available locally")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove Hosted Replica" }).nth(1).click();
  await expect(page.getByText("Attached Host", { exact: true })).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove Hosted Replica" }).first().click();
  await expect(page.getByText("No Hosted Replicas are configured on this Client.")).toBeVisible();
  await page.getByRole("button", { name: "Attach existing Hosted Replica" }).click();
  await page
    .getByLabel("Hosted Replica HTTPS address for attachment")
    .fill("https://attached.example.test");
  await page.getByLabel("Hosted Replica name for attachment").fill("Cancelled Host");
  await page.getByLabel("Account username for attachment").fill("alice");
  await page.getByLabel("Account password for attachment").fill("secret");
  await page.getByRole("button", { name: "Find Hosted Replicas" }).click();
  await expect(page.getByRole("heading", { name: "Choose a Hosted Replica" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel attachment" }).click();
  await expect(page.getByRole("heading", { name: "Choose a Hosted Replica" })).toHaveCount(0);
  const observed = await page.evaluate(
    () => (globalThis as unknown as { __awsmCalls: string[] }).__awsmCalls,
  );
  expect(observed).toEqual([
    "BeginHostedReplicaAttachment",
    "ConfirmHostedReplicaAttachment",
    "MaterializeHostedReplica",
    "PullHostedReplicas",
    "HydrateArtifact",
    "BeginHostedReplicaAttachment",
    "CancelHostedReplicaAttachment",
  ]);
});
