import { describe, expect, it } from "vitest";
import type { AuthoritativeClosure } from "../../src/runtime/synchronization/server-switch-recovery";
import {
  authoritativeClosuresEqual,
  ServerSwitchRecoveryProver,
} from "../../src/runtime/synchronization/server-switch-recovery";
import { testKeyring } from "../helpers/keyring";

const vaultId = "01900000-0000-7000-8000-000000000001";
const generationId = "01900000-0000-7000-8000-000000000002";
const eventId = "01900000-0000-7000-8000-000000000003";
const objectId = "01900000-0000-7000-8000-000000000004";

function closure(): AuthoritativeClosure {
  return {
    generation: {
      version: 1,
      generationId,
      generationNumber: 4,
      envelopeBytes: new Uint8Array([1]),
    },
    head: {
      version: 1,
      vaultId,
      generationId,
      generationNumber: 4,
      appendedObjectIds: [objectId],
      appendedEventIds: [eventId],
    },
    events: [
      {
        version: 1,
        vaultId,
        eventId,
        referencedObjectIds: [objectId],
        orderingTimestamp: "2026-07-20T00:00:00.000Z",
        envelopeBytes: new Uint8Array([2]),
      },
    ],
    objects: [
      {
        version: 1,
        objectId,
        objectType: "BundleDescriptor",
        envelopeBytes: new Uint8Array([3]),
      },
    ],
  };
}

describe("Server Switch Recovery base equality", () => {
  it("requires exact authoritative IDs, metadata, and encrypted bytes", () => {
    expect(authoritativeClosuresEqual(closure(), closure())).toBe(true);
    const changed = closure();
    changed.events[0]?.envelopeBytes.fill(9);
    expect(authoritativeClosuresEqual(closure(), changed)).toBe(false);
  });

  it("does not mistake a subset or append-tail difference for the same base", () => {
    const subset = closure();
    expect(authoritativeClosuresEqual(closure(), { ...subset, objects: [] })).toBe(false);
    expect(
      authoritativeClosuresEqual(closure(), {
        ...subset,
        head: { ...subset.head, appendedEventIds: [] },
      }),
    ).toBe(false);
  });

  it("classifies a malformed Recovery response as an integrity failure", async () => {
    const rootKey = await crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, [
      "deriveBits",
    ]);
    const prover = new ServerSwitchRecoveryProver(
      {
        request: async () => ({ status: 200, body: null }),
        getTransfer: async () => {
          throw new Error("unreachable");
        },
      },
      {
        prepareEncrypted: async () => undefined,
        openEncrypted: async () => {
          throw new Error("unreachable");
        },
      },
    );
    await expect(
      prover.prove({ vaultId, expected: closure(), keyring: testKeyring(rootKey) }),
    ).resolves.toEqual({
      state: "IntegrityFailure",
    });
  });
});
