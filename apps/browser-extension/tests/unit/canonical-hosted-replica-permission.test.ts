import { describe, expect, it, vi } from "vitest";

const mockedBrowser = vi.hoisted(() => ({
  getManifest: vi.fn(() => ({})),
  request: vi.fn(async () => true),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: { getManifest: mockedBrowser.getManifest },
    permissions: { request: mockedBrowser.request },
  },
}));

import { CanonicalApplicationClientError } from "../../src/app/canonical-application-client";
import {
  hostedReplicaOriginPattern,
  requestHostedReplicaPermissions,
} from "../../src/ui/canonical-hosted-replica-permission";

describe("Hosted Replica permission prompt", () => {
  it("validates canonical HTTPS origins and requests every enabled Host in one user gesture", async () => {
    await expect(
      requestHostedReplicaPermissions([
        "https://archive.example.test/",
        "https://sync.example.test/",
        "https://archive.example.test/",
      ]),
    ).resolves.toBeUndefined();

    expect(mockedBrowser.request).toHaveBeenCalledWith({
      origins: ["https://archive.example.test/*", "https://sync.example.test/*"],
    });
    expect(hostedReplicaOriginPattern("https://sync.example.test/path")).toBe(
      "https://sync.example.test/*",
    );
    expect(() => hostedReplicaOriginPattern("http://sync.example.test/")).toThrow(
      new CanonicalApplicationClientError(
        "HOSTED_REPLICA_ENDPOINT_INVALID",
        "Enter a canonical HTTPS Replica Host address.",
      ),
    );
  });

  it("reports a denied retrieval permission without starting network work", async () => {
    mockedBrowser.request.mockResolvedValueOnce(false);

    await expect(
      requestHostedReplicaPermissions(["https://sync.example.test/"], {
        deniedMessage: "Allow access to this Replica Host before retrieving the Capture.",
      }),
    ).rejects.toEqual(
      new CanonicalApplicationClientError(
        "HOST_PERMISSION_DENIED",
        "Allow access to this Replica Host before retrieving the Capture.",
      ),
    );
  });
});
