import { describe, expect, it, vi } from "vitest";

import { CanonicalPopupController } from "../../src/ui/canonical-popup-controller";

describe("canonical popup controller", () => {
  it("subscribes before its initial fetch and renders the selected Vault Library", async () => {
    let changed: (() => void) | undefined;
    const client = {
      request: vi.fn(async (request: { readonly type: string }) =>
        request.type === "GetState"
          ? {
              selectedVaultId: "a".repeat(64),
              vaults: [{ vaultId: "a".repeat(64), label: "Research", selected: true }],
            }
          : [{ bundleId: "b".repeat(64) }],
      ),
      subscribe: vi.fn((listener: () => void) => {
        changed = listener;
        return () => undefined;
      }),
    };
    const render = vi.fn();
    const controller = new CanonicalPopupController(client, render);

    await controller.start();

    expect(client.subscribe.mock.invocationCallOrder[0]).toBeLessThan(
      client.request.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(render).toHaveBeenCalledWith({
      state: {
        selectedVaultId: "a".repeat(64),
        vaults: [{ vaultId: "a".repeat(64), label: "Research", selected: true }],
      },
      library: [{ bundleId: "b".repeat(64) }],
    });
    expect(changed).toBeDefined();
  });

  it("does not render a stale response when an invalidation arrives during reconciliation", async () => {
    let changed: (() => void) | undefined;
    let resolveFirstState: ((value: unknown) => void) | undefined;
    const firstState = new Promise<unknown>((resolve) => {
      resolveFirstState = resolve;
    });
    const client = {
      request: vi
        .fn()
        .mockImplementationOnce(() => firstState)
        .mockResolvedValueOnce({ selectedVaultId: "b".repeat(64), vaults: [] })
        .mockResolvedValueOnce([{ bundleId: "c".repeat(64) }]),
      subscribe: vi.fn((listener: () => void) => {
        changed = listener;
        return () => undefined;
      }),
    };
    const render = vi.fn();
    const controller = new CanonicalPopupController(client, render);

    const started = controller.start();
    changed?.();
    resolveFirstState?.({ selectedVaultId: "a".repeat(64), vaults: [] });
    await started;

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenLastCalledWith({
      state: { selectedVaultId: "b".repeat(64), vaults: [] },
      library: [{ bundleId: "c".repeat(64) }],
    });
  });
});
