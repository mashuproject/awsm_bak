import { describe, expect, it, vi } from "vitest";

import {
  CanonicalPopupApplicationClientError,
  createCanonicalPopupApplicationClient,
} from "../../src/ui/canonical-popup-application-client";

describe("canonical popup application client", () => {
  it("accepts only exact state and Library payloads", async () => {
    const client = createCanonicalPopupApplicationClient({
      request: vi
        .fn()
        .mockResolvedValueOnce({
          selectedVaultId: "a".repeat(64),
          vaults: [
            { vaultId: "a".repeat(64), label: "Research", selected: true },
            { vaultId: "b".repeat(64), label: null, selected: false },
          ],
        })
        .mockResolvedValueOnce([
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
        ]),
      subscribe: vi.fn(() => () => undefined),
    });

    await expect(client.state()).resolves.toEqual({
      selectedVaultId: "a".repeat(64),
      vaults: [
        { vaultId: "a".repeat(64), label: "Research", selected: true },
        { vaultId: "b".repeat(64), label: null, selected: false },
      ],
    });
    await expect(client.listLibrary("a".repeat(64))).resolves.toEqual([
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
    ]);
  });

  it("rejects an inconsistent selected Vault before rendering it", async () => {
    const client = createCanonicalPopupApplicationClient({
      request: vi.fn().mockResolvedValue({
        selectedVaultId: "a".repeat(64),
        vaults: [{ vaultId: "b".repeat(64), label: null, selected: true }],
      }),
      subscribe: vi.fn(() => () => undefined),
    });

    await expect(client.state()).rejects.toEqual(
      new CanonicalPopupApplicationClientError(
        "APPLICATION_PROTOCOL_INVALID",
        "The local application returned an invalid popup response.",
      ),
    );
  });
});
