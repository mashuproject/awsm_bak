import { describe, expect, it, vi } from "vitest";

import { createCanonicalBackgroundApplication } from "../../src/app/canonical-background";
import type { CanonicalArtifactStore } from "../../src/runtime/artifact/canonical-store";
import type { CanonicalVaultService } from "../../src/runtime/vault/canonical-service";

describe("canonical background", () => {
  it("composes one canonical Runtime with the browser Capture Host", async () => {
    const vaults = {
      listVaults: vi.fn().mockResolvedValue([]),
    } as unknown as CanonicalVaultService;
    const pageCapture = {
      captureActivePage: vi.fn(),
    };
    const application = createCanonicalBackgroundApplication({
      vaults,
      artifacts: {} as CanonicalArtifactStore,
      pageCapture,
      now: () => 1234,
      createCaptureCommandId: () => "command",
    });

    await expect(application.handle({ type: "GetState" })).resolves.toEqual({ vaults: [] });
    expect(vaults.listVaults).toHaveBeenCalledTimes(1);
  });
});
