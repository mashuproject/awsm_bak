import { sha256 } from "@noble/hashes/sha2.js";

import type { RuntimeTransfer, RuntimeTransferSummary } from "./runtime-api";
import { sealDesktopTransfer } from "./transfer-envelope";

export interface DesktopVaultMoveConnection {
  beginTransfer(vaultId: string): Promise<RuntimeTransfer>;
  stageTransfer(
    transferId: string,
    secret: string,
    envelope: Uint8Array,
  ): Promise<RuntimeTransferSummary>;
}

export interface DesktopVaultMoveResult {
  readonly transfer: Omit<RuntimeTransfer, "secret">;
  readonly staged: RuntimeTransferSummary;
  readonly retireSource: () => Promise<void>;
}

/**
 * Performs the copy half of a move. Source retirement is deliberately a
 * separate callback so the caller can wait for destination approval and show
 * the irreversible consequence to the user.
 */
export async function stageVaultMove(input: {
  readonly connection: DesktopVaultMoveConnection;
  readonly vaultId: string;
  readonly exportPackage: (transferSecret: string) => Promise<Uint8Array>;
  readonly retireSource: () => Promise<void>;
}): Promise<DesktopVaultMoveResult> {
  const transfer = await input.connection.beginTransfer(input.vaultId);
  if (transfer.vaultId !== input.vaultId)
    throw new Error("Desktop transfer Vault identity changed.");
  const plaintext = await input.exportPackage(transfer.secret);
  const envelope = await sealDesktopTransfer({ secret: transfer.secret, plaintext });
  const staged = await input.connection.stageTransfer(
    transfer.transferId,
    transfer.secret,
    envelope,
  );
  const expectedDigest = hex(sha256(plaintext));
  // The desktop verifies the outer envelope; the digest returned by the
  // destination is the digest of the package after decryption.
  if (staged.byteLength !== plaintext.byteLength || staged.digest !== expectedDigest) {
    throw new Error("Desktop transfer verification did not match the exported package.");
  }
  return {
    transfer: { transferId: transfer.transferId, vaultId: transfer.vaultId },
    staged,
    retireSource: input.retireSource,
  };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
