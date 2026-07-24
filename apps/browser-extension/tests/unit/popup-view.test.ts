import { describe, expect, it } from "vitest";
import type { AppState } from "../../src/app/protocol";
import { popupView, recentCaptureMatchesActiveUrl } from "../../src/ui/popup-view";

const vaultId = "00000000-0000-4000-8000-000000000000";

const base: AppState = {
  account: {
    configuration: { mode: "LocalOnly" },
    accountState: "SignedOut",
    vaultSyncState: "LocalOnly",
  },
  workspace: {
    workspaceId: vaultId,
    activeVaultId: vaultId,
    vaults: [
      {
        vaultId,
        name: "Amber Archive",
        createdAt: "2026-07-18T12:00:00.000Z",
        active: true,
        unlocked: true,
        manuallyLocked: false,
      },
    ],
  },
};

describe("popup state model", () => {
  it("requires an explicit synchronization decision before local Vault onboarding", () => {
    expect(
      popupView({
        ...base,
        account: {
          configuration: { mode: "Unconfigured" },
          accountState: "SignedOut",
          vaultSyncState: "LocalOnly",
        },
      }),
    ).toEqual({ screen: "server-choice", hostedOrigin: "https://awsm.foo" });
  });

  it("shows popup login after a server is configured and no Account is authenticated", () => {
    expect(
      popupView({
        ...base,
        account: {
          configuration: {
            mode: "Configured",
            serverOrigin: "https://sync.example.test",
          },
          accountState: "SignedOut",
          vaultSyncState: "AuthenticationRequired",
        },
      }),
    ).toEqual({ screen: "login", serverOrigin: "https://sync.example.test" });
  });
  it("shows Firefox permission recovery before attempting Account traffic", () => {
    expect(
      popupView({
        ...base,
        account: {
          configuration: {
            mode: "Configured",
            serverOrigin: "https://sync.example.test",
          },
          accountState: "Authenticated",
          vaultSyncState: "PermissionRequired",
        },
      }),
    ).toEqual({
      screen: "permission-required",
      serverOrigin: "https://sync.example.test",
    });
  });
  it("shows a recent capture only on the same fragmentless URL", () => {
    expect(
      recentCaptureMatchesActiveUrl(
        "https://example.test/page?mode=full#saved",
        "https://example.test/page?mode=full#current",
      ),
    ).toBe(true);
    expect(
      recentCaptureMatchesActiveUrl(
        "https://example.test/page?mode=full",
        "https://example.test/page?mode=compact",
      ),
    ).toBe(false);
    expect(recentCaptureMatchesActiveUrl("https://example.test/page", undefined)).toBe(false);
  });

  it("shows onboarding before a Vault exists", () => {
    const { activeVaultId: _activeVaultId, ...workspace } = base.workspace;
    expect(popupView({ ...base, workspace: { ...workspace, vaults: [] } })).toEqual({
      screen: "onboarding",
    });
  });

  it("shows device-only unlock while the Vault is locked", () => {
    const active = base.workspace.vaults[0];
    if (active === undefined) throw new Error("Expected active Vault fixture.");
    expect(
      popupView({
        ...base,
        workspace: {
          ...base.workspace,
          vaults: [{ ...active, unlocked: false }],
        },
      }),
    ).toEqual({
      screen: "locked",
    });
  });

  it("shows persisted background capture progress", () => {
    expect(
      popupView({
        ...base,
        latestJob: {
          version: 1,
          vaultId,
          jobId: "00000000-0000-4000-8000-000000000001",
          commandId: "00000000-0000-4000-8000-000000000002",
          tabId: 7,
          state: "Running",
          stage: "Screenshot",
          createdAt: "2026-07-16T17:00:00.000Z",
          updatedAt: "2026-07-16T17:00:01.000Z",
        },
      }),
    ).toEqual({ screen: "capturing", stage: "Screenshot" });
  });

  it("shows success and typed failure without depending on message text", () => {
    expect(
      popupView({
        ...base,
        latestJob: {
          version: 1,
          vaultId,
          jobId: "00000000-0000-4000-8000-000000000001",
          commandId: "00000000-0000-4000-8000-000000000002",
          tabId: 7,
          state: "Succeeded",
          stage: "Commit",
          createdAt: "2026-07-16T17:00:00.000Z",
          updatedAt: "2026-07-16T17:00:01.000Z",
        },
      }),
    ).toEqual({ screen: "ready", notice: "capture-succeeded" });
    expect(
      popupView({
        ...base,
        latestJob: {
          version: 1,
          vaultId,
          jobId: "00000000-0000-4000-8000-000000000001",
          commandId: "00000000-0000-4000-8000-000000000002",
          tabId: 7,
          state: "Failed",
          stage: "Snapshot",
          errorId: "PAGE_SNAPSHOT_FAILED",
          createdAt: "2026-07-16T17:00:00.000Z",
          updatedAt: "2026-07-16T17:00:01.000Z",
        },
      }),
    ).toEqual({ screen: "ready", notice: "PAGE_SNAPSHOT_FAILED" });
  });

  it("shows a visible warning when the committed capture lacks its screenshot", () => {
    expect(
      popupView({
        ...base,
        latestWarnings: ["SCREENSHOT_CAPTURE_FAILED"],
        latestJob: {
          version: 1,
          vaultId,
          jobId: "00000000-0000-4000-8000-000000000001",
          commandId: "00000000-0000-4000-8000-000000000002",
          tabId: 7,
          state: "Succeeded",
          stage: "Commit",
          createdAt: "2026-07-16T17:00:00.000Z",
          updatedAt: "2026-07-16T17:00:01.000Z",
        },
      }),
    ).toEqual({ screen: "ready", notice: "screenshot-warning" });
  });

  it("identifies the latest capture in a dismissible card with a thumbnail", () => {
    const state = {
      ...base,
      recentCapture: {
        vaultId,
        jobId: "00000000-0000-4000-8000-000000000001",
        bundleId: "00000000-0000-4000-8000-000000000002",
        title: "A page worth keeping",
        screenshotBase64: "iVBORw0KGgo=",
        warnings: [],
      },
    } as AppState;

    expect(popupView(state)).toEqual({
      screen: "ready",
      recentCapture: state.recentCapture,
    });
  });

  it("shows no stale success message after the recent capture is dismissed", () => {
    expect(
      popupView({
        ...base,
        latestJob: {
          version: 1,
          vaultId,
          jobId: "00000000-0000-4000-8000-000000000001",
          commandId: "00000000-0000-4000-8000-000000000002",
          tabId: 7,
          state: "Succeeded",
          stage: "Commit",
          createdAt: "2026-07-16T17:00:00.000Z",
          updatedAt: "2026-07-16T17:00:01.000Z",
          noticeDismissed: true,
        },
      }),
    ).toEqual({ screen: "ready" });
  });
});
