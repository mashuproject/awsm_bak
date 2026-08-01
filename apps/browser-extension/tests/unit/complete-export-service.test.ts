import { describe, expect, it } from "vitest";

import { openCompactItem } from "../../src/crypto/compact";
import { CausalGraph } from "../../src/domain/canonical/reducers";
import { concatBytes } from "../../src/domain/canonical/transcript";
import { bytesEqual } from "../../src/domain/hash";
import type { CanonicalIndexedDb } from "../../src/drivers/indexeddb/canonical-database";
import { NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import type { CanonicalArtifactStore } from "../../src/runtime/artifact/canonical-store";
import {
  decodeCompleteExportEntryHeader,
  openCompleteExportStream,
} from "../../src/runtime/complete-export/container";
import {
  decodeCompleteExportKeyInventory,
  decodeCompleteExportManifest,
} from "../../src/runtime/complete-export/contracts";
import { CanonicalCompleteExportService } from "../../src/runtime/complete-export/service";
import type { CanonicalReplayService } from "../../src/runtime/projection/canonical-replay";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import { prepareCanonicalVaultStorage } from "../../src/runtime/vault/canonical-local-state";
import type { CanonicalVaultService } from "../../src/runtime/vault/canonical-service";

async function wrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
}

describe("canonical Complete Export Service", () => {
  it("exports one authenticated initial Vault without changing its source", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Research", assertedAt: 1 });
    const local = await prepareCanonicalVaultStorage({
      creation,
      label: "Research",
      realm: NORMAL_STORAGE_REALM,
      wrappingKey: await wrappingKey(),
    });
    const replicaBytes = Uint8Array.from(local.commit.replicaState.bytes);
    const vault = {
      directory: {
        vaultId: creation.ids.vaultId,
        generationId: creation.ids.generationId,
        label: "Research",
        selectedClientCredentialId: creation.ids.clientCredentialId,
      },
      replicaState: local.replicaState,
      clientSecret: {
        vaultId: creation.ids.vaultId,
        memberId: creation.ids.firstMemberId,
        clientCredentialId: creation.ids.clientCredentialId,
        signingPublicKey: creation.secrets.client.signingPublicKey,
        signingSecretKey: creation.secrets.client.signingSecretKey,
        wrappingPublicKey: creation.secrets.client.wrappingPublicKey,
        wrappingPrivateKey: creation.secrets.client.wrappingPrivateKey,
      },
      epochSecret: {
        vaultId: creation.ids.vaultId,
        keyEpochId: creation.secrets.keyEpoch.id,
        displayNumber: 0,
        key: creation.secrets.keyEpoch.key,
      },
      baseline: creation.baseline,
      genesis: creation.genesis,
      installationWrappingKey: await wrappingKey(),
      replicaStateStorageBytes: replicaBytes,
    };
    const envelopes = new Map([
      [Buffer.from(creation.baseline.recordId).toString("hex"), creation.baselineEnvelope.bytes],
      [Buffer.from(creation.genesis.recordId).toString("hex"), creation.genesisEnvelope.bytes],
      [
        Buffer.from(creation.recoveryKeyEnvelope.id).toString("hex"),
        creation.recoveryKeyEnvelope.envelope.bytes,
      ],
      [
        Buffer.from(creation.clientKeyEnvelope.id).toString("hex"),
        creation.clientKeyEnvelope.envelope.bytes,
      ],
    ]);
    const storage = {
      getBytes: async (_realm: unknown, item: { readonly itemKey: string }) =>
        envelopes.get(item.itemKey),
    } as unknown as CanonicalIndexedDb;
    const vaults = {
      realm: NORMAL_STORAGE_REALM,
      storage,
      openResolvedCompactItem: async (input: { readonly logicalId: Uint8Array }) => {
        const bytes = envelopes.get(Buffer.from(input.logicalId).toString("hex"));
        if (bytes === undefined) throw new Error("missing fixture envelope");
        return openCompactItem({
          vaultId: creation.ids.vaultId,
          keyEpochId: creation.secrets.keyEpoch.id,
          keyEpochKey: creation.secrets.keyEpoch.key,
          envelopeBytes: bytes,
        });
      },
      readLogicalResolution: async (input: { readonly logicalId: Uint8Array }) => {
        const bytes = envelopes.get(Buffer.from(input.logicalId).toString("hex"));
        if (bytes === undefined) throw new Error("missing fixture resolution");
        const opened = await openCompactItem({
          vaultId: creation.ids.vaultId,
          keyEpochId: creation.secrets.keyEpoch.id,
          keyEpochKey: creation.secrets.keyEpoch.key,
          envelopeBytes: bytes,
        }).catch(() => undefined);
        const storageItemId =
          opened?.envelope.storageItemId ??
          (bytesEqual(input.logicalId, creation.recoveryKeyEnvelope.id)
            ? creation.recoveryKeyEnvelope.envelope.storageItemId
            : creation.clientKeyEnvelope.envelope.storageItemId);
        return {
          vaultId: creation.ids.vaultId,
          kind: 2 as const,
          logicalId: input.logicalId,
          storageItemId,
          keyEpochId: creation.secrets.keyEpoch.id,
          availability: 1 as const,
        };
      },
    } as unknown as CanonicalVaultService;
    const replays = {
      vaults,
      replay: async () => ({ vault, graph: new CausalGraph(), events: [creation.genesis] }),
    } as unknown as CanonicalReplayService;
    const artifacts = {
      open: async () => {
        throw new Error("An empty Vault has no Artifact wrappers");
      },
    } as unknown as CanonicalArtifactStore;
    const encrypted: Uint8Array[] = [];

    const result = await new CanonicalCompleteExportService(replays, artifacts).export({
      vaultId: creation.ids.vaultId,
      passphrase: "correct horse battery staple",
      salt: new Uint8Array(16).fill(7),
      nonce: new Uint8Array(24).fill(8),
      write: async (bytes) => {
        encrypted.push(Uint8Array.from(bytes));
      },
    });

    const plaintext: Uint8Array[] = [];
    await openCompleteExportStream({
      passphrase: "correct horse battery staple",
      encrypted: (async function* () {
        for (const part of encrypted) yield part;
      })(),
      writePlaintext: async (bytes) => {
        plaintext.push(Uint8Array.from(bytes));
      },
    });
    const opened = concatBytes(plaintext);
    const entries: { readonly kind: number; readonly bytes: Uint8Array }[] = [];
    let offset = 0;
    while (offset < opened.byteLength) {
      const headerLength = new DataView(opened.buffer, opened.byteOffset + offset, 4).getUint32(
        0,
        false,
      );
      offset += 4;
      const header = decodeCompleteExportEntryHeader(opened.slice(offset, offset + headerLength));
      offset += headerLength;
      entries.push({ kind: header.kind, bytes: opened.slice(offset, offset + header.byteLength) });
      offset += header.byteLength;
    }

    expect(entries.map(({ kind }) => kind)).toEqual([1, 2, 2, 2, 2, 3]);
    expect(decodeCompleteExportManifest(entries[0]?.bytes ?? new Uint8Array())).toEqual(
      result.manifest,
    );
    const inventory = decodeCompleteExportKeyInventory(entries.at(-1)?.bytes ?? new Uint8Array());
    expect(inventory.entries).toEqual([
      {
        keyEpochId: creation.secrets.keyEpoch.id,
        keyEpochKey: creation.secrets.keyEpoch.key,
      },
    ]);
    expect(result.opaqueItemCount).toBe(4);
    expect(local.commit.replicaState.bytes).toEqual(replicaBytes);
  }, 20_000);
});
