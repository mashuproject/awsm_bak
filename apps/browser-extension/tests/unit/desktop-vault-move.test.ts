import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it, vi } from "vitest";

import { stageVaultMove } from "../../src/hosts/desktop/vault-move";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

describe("desktop Vault move ceremony", () => {
  it("stages a verified encrypted copy and leaves retirement explicit", async () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    const retire = vi.fn(async () => undefined);
    const connection = {
      beginTransfer: vi.fn(async () => ({
        transferId: "transfer-1",
        vaultId: "a".repeat(64),
        secret: "A".repeat(43),
      })),
      stageTransfer: vi.fn(async (_transferId: string, _secret: string, _envelope: Uint8Array) => ({
        transferId: "transfer-1",
        vaultId: "a".repeat(64),
        byteLength: source.byteLength,
        digest: hex(sha256(source)),
      })),
    };

    const result = await stageVaultMove({
      connection,
      vaultId: "a".repeat(64),
      exportPackage: async (secret) => {
        expect(secret).toBe("A".repeat(43));
        return source;
      },
      retireSource: retire,
    });

    expect(result.transfer).toEqual({ transferId: "transfer-1", vaultId: "a".repeat(64) });
    expect(retire).not.toHaveBeenCalled();
    await result.retireSource();
    expect(retire).toHaveBeenCalledOnce();
    const envelope = connection.stageTransfer.mock.calls[0]?.[2];
    if (envelope === undefined) throw new Error("transfer envelope was not staged");
    expect(new TextDecoder().decode(envelope.slice(0, 7))).toBe("AWSMTR1");
    expect(new TextDecoder().decode(envelope)).not.toContain("1,2,3,4");
  });
});
