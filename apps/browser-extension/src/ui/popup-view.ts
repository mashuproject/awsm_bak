import type { AppState, RecentCapture } from "../app/protocol";
import type { RuntimeErrorId } from "../domain/contracts";

export function recentCaptureMatchesActiveUrl(
  capturedUrl: string,
  activeUrl: string | undefined,
): boolean {
  if (activeUrl === undefined) return false;
  try {
    const captured = new URL(capturedUrl);
    const active = new URL(activeUrl);
    captured.hash = "";
    active.hash = "";
    return captured.href === active.href;
  } catch {
    return false;
  }
}

export type PopupView =
  | {
      readonly screen: "server-choice";
      readonly hostedOrigin: "https://awsm.foo";
    }
  | { readonly screen: "permission-required"; readonly serverOrigin: string }
  | { readonly screen: "login"; readonly serverOrigin: string }
  | { readonly screen: "account-setup" }
  | { readonly screen: "stale-replica" }
  | { readonly screen: "onboarding" }
  | { readonly screen: "locked" }
  | { readonly screen: "capturing"; readonly stage: string }
  | {
      readonly screen: "ready";
      readonly notice?: "capture-succeeded" | "screenshot-warning" | RuntimeErrorId;
      readonly recentCapture?: RecentCapture;
    };

export function popupView(state: AppState): PopupView {
  if (state.account.configuration.mode === "Unconfigured") {
    return { screen: "server-choice", hostedOrigin: "https://awsm.foo" };
  }
  if (
    state.account.configuration.mode === "Configured" &&
    state.account.vaultSyncState === "PermissionRequired"
  ) {
    return {
      screen: "permission-required",
      serverOrigin: state.account.configuration.serverOrigin,
    };
  }
  if (
    state.account.configuration.mode === "Configured" &&
    state.account.accountState !== "Authenticated"
  ) {
    return {
      screen: "login",
      serverOrigin: state.account.configuration.serverOrigin,
    };
  }
  if (state.account.vaultSyncState === "SetupRequired") return { screen: "account-setup" };
  if (state.account.staleResolutionRequired === true) return { screen: "stale-replica" };
  const active = state.workspace.vaults.find((vault) => vault.active);
  if (active === undefined) return { screen: "onboarding" };
  if (!active.unlocked) {
    return { screen: "locked" };
  }
  if (state.latestJob?.state === "Running" || state.latestJob?.state === "Created") {
    return { screen: "capturing", stage: state.latestJob.stage };
  }
  if (state.latestJob?.state === "Failed") {
    return {
      screen: "ready",
      ...(state.latestJob.errorId === undefined ? {} : { notice: state.latestJob.errorId }),
    };
  }
  if (state.recentCapture !== undefined) {
    return { screen: "ready", recentCapture: state.recentCapture };
  }
  if (state.latestJob?.state === "Succeeded") {
    if (state.latestJob.noticeDismissed === true) return { screen: "ready" };
    return {
      screen: "ready",
      notice:
        state.latestWarnings !== undefined && state.latestWarnings.length > 0
          ? "screenshot-warning"
          : "capture-succeeded",
    };
  }
  return { screen: "ready" };
}
