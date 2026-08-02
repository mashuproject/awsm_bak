import { describe, expect, it, vi } from "vitest";

import { CanonicalPopupController } from "../../src/ui/canonical-popup-controller";

describe("canonical popup controller", () => {
  it("subscribes before its initial fetch and renders the selected Vault Library", async () => {
    let changed: (() => void) | undefined;
    const client = {
      state: vi.fn(async () => ({
        selectedVaultId: "a".repeat(64),
        vaults: [{ vaultId: "a".repeat(64), label: "Research", selected: true }],
      })),
      listLibrary: vi.fn(async () => [
        {
          bundleId: "b".repeat(64),
          collectionId: "c".repeat(64),
          artifactId: "d".repeat(64),
          capturedAt: 1,
          originalUrl: "https://example.com/original",
          finalUrl: "https://example.com/final",
          title: "Example",
          availableLocally: true,
          lifecycle: "Active" as const,
        },
      ]),
      subscribe: vi.fn((listener: () => void) => {
        changed = listener;
        return () => undefined;
      }),
    };
    const render = vi.fn();
    const controller = new CanonicalPopupController(client, render);

    await controller.start();

    expect(client.subscribe.mock.invocationCallOrder[0]).toBeLessThan(
      client.state.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(render).toHaveBeenCalledWith({
      state: {
        selectedVaultId: "a".repeat(64),
        vaults: [{ vaultId: "a".repeat(64), label: "Research", selected: true }],
      },
      library: [
        {
          bundleId: "b".repeat(64),
          collectionId: "c".repeat(64),
          artifactId: "d".repeat(64),
          capturedAt: 1,
          originalUrl: "https://example.com/original",
          finalUrl: "https://example.com/final",
          title: "Example",
          availableLocally: true,
          lifecycle: "Active",
        },
      ],
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
      state: vi
        .fn()
        .mockImplementationOnce(() => firstState)
        .mockResolvedValueOnce({
          selectedVaultId: "b".repeat(64),
          vaults: [{ vaultId: "b".repeat(64), label: "Inbox", selected: true }],
        }),
      listLibrary: vi.fn().mockResolvedValueOnce([
        {
          bundleId: "c".repeat(64),
          collectionId: "d".repeat(64),
          artifactId: "e".repeat(64),
          capturedAt: 1,
          originalUrl: "https://example.com/original",
          finalUrl: "https://example.com/final",
          title: "Example",
          availableLocally: true,
          lifecycle: "Active" as const,
        },
      ]),
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
      state: {
        selectedVaultId: "b".repeat(64),
        vaults: [{ vaultId: "b".repeat(64), label: "Inbox", selected: true }],
      },
      library: [
        {
          bundleId: "c".repeat(64),
          collectionId: "d".repeat(64),
          artifactId: "e".repeat(64),
          capturedAt: 1,
          originalUrl: "https://example.com/original",
          finalUrl: "https://example.com/final",
          title: "Example",
          availableLocally: true,
          lifecycle: "Active",
        },
      ],
    });
  });
});
