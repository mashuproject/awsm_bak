import { describe, expect, it } from "vitest";
import { NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import {
  CanonicalDesktopRuntimeGrantStore,
  DESKTOP_RUNTIME_GRANT_ITEM,
  type DesktopRuntimeGrantState,
} from "../../src/hosts/desktop/runtime-grant-store";

function memoryStorage() {
  let bytes: Uint8Array | undefined;
  return {
    getBytes: async () => (bytes === undefined ? undefined : Uint8Array.from(bytes)),
    putMutable: async (_realm: unknown, item: { bytes: Uint8Array }) => {
      bytes = Uint8Array.from(item.bytes);
    },
    commitInstallationMutation: async (input: { deletedItems?: readonly unknown[] }) => {
      if (input.deletedItems !== undefined) bytes = undefined;
    },
    raw: () => bytes,
  };
}

const grant: DesktopRuntimeGrantState = {
  endpoint: "http://127.0.0.1:37373",
  grantId: "grant-1",
  clientName: "AWSM browser extension",
  scopes: ["runtime.vault"],
  token: "opaque-bearer-token",
};

describe("desktop Runtime grant storage", () => {
  it("wraps and restores the grant without storing plaintext", async () => {
    const storage = memoryStorage();
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const store = new CanonicalDesktopRuntimeGrantStore(
      storage as never,
      NORMAL_STORAGE_REALM,
      wrappingKey,
    );

    await store.save(grant);
    const raw = storage.raw();
    expect(raw).toBeDefined();
    expect(new TextDecoder().decode(raw)).not.toContain(grant.token);
    await expect(store.load()).resolves.toEqual(grant);
  });

  it("fails closed for a different installation wrapping key and clears state", async () => {
    const storage = memoryStorage();
    const firstKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const secondKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const first = new CanonicalDesktopRuntimeGrantStore(
      storage as never,
      NORMAL_STORAGE_REALM,
      firstKey,
    );
    await first.save(grant);
    const second = new CanonicalDesktopRuntimeGrantStore(
      storage as never,
      NORMAL_STORAGE_REALM,
      secondKey,
    );
    await expect(second.load()).rejects.toThrow();
    await second.clear();
    expect(storage.raw()).toBeUndefined();
    expect(DESKTOP_RUNTIME_GRANT_ITEM.namespace).toBe("awsm.storage.desktop-runtime-grant");
  });

  it("fails closed for a grant outside the current Vault scope", async () => {
    const storage = memoryStorage();
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const store = new CanonicalDesktopRuntimeGrantStore(
      storage as never,
      NORMAL_STORAGE_REALM,
      wrappingKey,
    );

    await store.save({ ...grant, scopes: ["runtime.unknown"] });
    await expect(store.load()).rejects.toThrow("Desktop Runtime grant scopes are invalid.");
  });
});
