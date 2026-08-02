import { describe, expect, it, vi } from "vitest";

const mockedRuntime = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      sendMessage: mockedRuntime.sendMessage,
      onMessage: {
        addListener: mockedRuntime.addListener,
        removeListener: mockedRuntime.removeListener,
      },
    },
  },
}));

import {
  CanonicalApplicationClientError,
  sendCanonicalApplicationRequest,
  subscribeCanonicalApplicationState,
} from "../../src/app/canonical-application-client";
import { CANONICAL_APPLICATION_STATE_CHANGED } from "../../src/app/canonical-application-host";

describe("canonical application client", () => {
  it("accepts only an exact successful response and exposes bounded current failures", async () => {
    mockedRuntime.sendMessage.mockResolvedValueOnce({ ok: true, value: { vaults: [] } });
    await expect(sendCanonicalApplicationRequest({ type: "GetState" })).resolves.toEqual({
      vaults: [],
    });

    mockedRuntime.sendMessage.mockResolvedValueOnce({
      ok: false,
      error: { id: "VAULT_CONTEXT_CHANGED", message: "The selected Vault changed." },
    });
    await expect(sendCanonicalApplicationRequest({ type: "GetState" })).rejects.toEqual(
      new CanonicalApplicationClientError("VAULT_CONTEXT_CHANGED", "The selected Vault changed."),
    );

    mockedRuntime.sendMessage.mockResolvedValueOnce({ ok: true, value: {}, unexpected: true });
    await expect(sendCanonicalApplicationRequest({ type: "GetState" })).rejects.toEqual(
      new CanonicalApplicationClientError(
        "APPLICATION_PROTOCOL_INVALID",
        "The local application returned an invalid response.",
      ),
    );
  });

  it("subscribes only to the exact canonical state notification", async () => {
    const changed = vi.fn();
    const unsubscribe = subscribeCanonicalApplicationState(changed);
    const listener = mockedRuntime.addListener.mock.calls[0]?.[0] as
      | ((message: unknown) => unknown)
      | undefined;
    if (listener === undefined) throw new Error("state listener was not installed");

    expect(listener({ ...CANONICAL_APPLICATION_STATE_CHANGED, extra: true })).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
    expect(listener(CANONICAL_APPLICATION_STATE_CHANGED)).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(mockedRuntime.removeListener).toHaveBeenCalledWith(listener);
  });
});
