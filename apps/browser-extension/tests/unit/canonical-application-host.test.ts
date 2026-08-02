import { describe, expect, it, vi } from "vitest";

import {
  CANONICAL_APPLICATION_STATE_CHANGED,
  installCanonicalApplicationMessageHandler,
} from "../../src/app/canonical-application-host";

describe("canonical application message host", () => {
  it("returns only the canonical application result or a bounded current error", async () => {
    let listener: ((message: unknown) => Promise<unknown>) | undefined;
    const application = {
      handle: vi.fn(async (message: unknown) => {
        if (message === "fails")
          throw Object.assign(new Error("No Vault is selected."), { id: "NO_VAULT" });
        return { selectedVaultId: undefined, vaults: [] };
      }),
    };
    installCanonicalApplicationMessageHandler(
      {
        onMessage: {
          addListener(callback) {
            listener = callback;
          },
        },
      },
      application,
    );
    if (listener === undefined) throw new Error("message listener was not installed");

    await expect(listener({ type: "GetState" })).resolves.toEqual({
      ok: true,
      value: { selectedVaultId: undefined, vaults: [] },
    });
    await expect(listener("fails")).resolves.toEqual({
      ok: false,
      error: { id: "NO_VAULT", message: "No Vault is selected." },
    });
  });

  it("does not forward arbitrary exception text or a non-string error identity to the UI", async () => {
    let listener: ((message: unknown) => Promise<unknown>) | undefined;
    installCanonicalApplicationMessageHandler(
      {
        onMessage: {
          addListener(callback) {
            listener = callback;
          },
        },
      },
      {
        handle: async () => {
          throw Object.assign(new Error("private decrypted detail"), { id: { not: "an id" } });
        },
      },
    );
    if (listener === undefined) throw new Error("message listener was not installed");

    await expect(listener({ type: "GetState" })).resolves.toEqual({
      ok: false,
      error: {
        id: "APPLICATION_FAILED",
        message: "The local application could not complete that action.",
      },
    });
  });

  it("does not treat a state invalidation as an application Command", async () => {
    let listener: ((message: unknown) => Promise<unknown>) | undefined;
    const application = { handle: vi.fn() };
    installCanonicalApplicationMessageHandler(
      {
        onMessage: {
          addListener(callback) {
            listener = callback;
          },
        },
      },
      application,
    );
    if (listener === undefined) throw new Error("message listener was not installed");

    await expect(listener(CANONICAL_APPLICATION_STATE_CHANGED)).resolves.toBeUndefined();
    expect(application.handle).not.toHaveBeenCalled();

    const malformedNotification = {
      ...CANONICAL_APPLICATION_STATE_CHANGED,
      unexpected: true,
    };
    await expect(listener(malformedNotification)).resolves.toEqual({ ok: true, value: undefined });
    expect(application.handle).toHaveBeenCalledWith(malformedNotification);
  });
});
