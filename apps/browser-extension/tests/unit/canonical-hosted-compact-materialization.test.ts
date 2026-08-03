import { describe, expect, it } from "vitest";

import { bytesEqual } from "../../src/domain/hash";
import { CanonicalHostedCompactMaterializationService } from "../../src/runtime/synchronization/canonical-hosted-compact-materialization";
import type { CanonicalRemoteMaterializationLedgerEntry } from "../../src/runtime/synchronization/canonical-state";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";
import type { PersistedOpenedCanonicalVault } from "../../src/runtime/vault/canonical-service";
import { decodeOpaqueEnvelope } from "../../src/storage/opaque-envelope";

const REMOTE_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function materializationKey(input: {
  readonly logicalNamespace: number;
  readonly logicalId: Uint8Array;
}): string {
  return `${input.logicalNamespace}:${key(input.logicalId)}`;
}

function replicaState(
  input: Awaited<ReturnType<typeof prepareCanonicalVaultCreation>>,
): CanonicalReplicaState {
  return {
    vaultId: input.ids.vaultId,
    generationId: input.ids.generationId,
    causalFrontier: [input.genesis.recordId],
    authorityFrontier: [input.genesis.recordId],
    continuityRecordIds: [input.genesis.recordId],
    baselineId: input.baseline.recordId,
    currentKeyEpochId: input.secrets.keyEpoch.id,
    requiredFeatureSetId: input.genesis.requiredFeatureSetId,
    authoringClientCredentialId: input.ids.clientCredentialId,
    memberId: input.ids.firstMemberId,
    lifecycle: 1,
    preservationRoots: [],
    garbageCollectionFences: [],
    adoption: null,
  };
}

async function fixture(options: { readonly rejectFirstAdmission?: boolean } = {}) {
  const creation = await prepareCanonicalVaultCreation({ label: "Hosted", assertedAt: 1 });
  const vault = {
    directory: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      label: "Hosted",
      selectedClientCredentialId: creation.ids.clientCredentialId,
    },
    replicaState: replicaState(creation),
    clientSecret: null,
    epochSecret: {
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      displayNumber: 0,
      key: Uint8Array.from(creation.secrets.keyEpoch.key),
    },
    baseline: creation.baseline,
    genesis: creation.genesis,
    installationWrappingKey: await crypto.subtle.generateKey(
      { name: "AES-KW", length: 256 },
      false,
      ["wrapKey", "unwrapKey"],
    ),
    replicaStateStorageBytes: new Uint8Array([1]),
  } satisfies PersistedOpenedCanonicalVault;
  const remote = {
    remoteId: REMOTE_ID,
    vaultId: creation.ids.vaultId,
    name: "Hosted Replica",
    endpoint: "https://host.example/",
    hostedReplicaHandle: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
    locatorSalt: new Uint8Array(32).fill(12),
    enabled: true,
    inventoryPageSize: 100,
  } as const;
  const prepared = new Map<
    string,
    { readonly entry: CanonicalRemoteMaterializationLedgerEntry; readonly bytes: Uint8Array | null }
  >();
  const attempts: { readonly locator: Uint8Array; readonly bytes: Uint8Array }[] = [];
  let reject = options.rejectFirstAdmission ?? false;
  const service = new CanonicalHostedCompactMaterializationService({
    remotes: {
      withLoaded: async <T>(
        _input: unknown,
        operation: (loaded: {
          readonly remote: typeof remote;
          readonly bearerToken: string;
        }) => Promise<T>,
      ): Promise<T> => operation({ remote, bearerToken: "channel-token" }),
    },
    replays: {
      replay: async () => ({
        vault,
        authority: {
          recoveryCredentials: [
            {
              recoveryCredentialId: creation.ids.recoveryCredentialId,
              memberId: creation.ids.firstMemberId,
              revision: 0,
              signingPublicKey: creation.secrets.recovery.signingPublicKey,
              wrappingPublicKey: creation.secrets.recovery.wrappingPublicKey,
              effective: true,
            },
          ],
          clientCredentials: new Map([
            [
              key(creation.ids.clientCredentialId),
              {
                clientCredentialId: creation.ids.clientCredentialId,
                memberId: creation.ids.firstMemberId,
                signingPublicKey: creation.secrets.client.signingPublicKey,
                wrappingPublicKey: creation.secrets.client.wrappingPublicKey,
                active: true,
              },
            ],
          ]),
          keyEnvelopeSlots: [
            {
              keyEpochId: creation.secrets.keyEpoch.id,
              targetKind: 1 as const,
              targetCredentialId: creation.ids.recoveryCredentialId,
              targetRevision: 0,
              keyEnvelopeId: creation.recoveryKeyEnvelope.id,
            },
            {
              keyEpochId: creation.secrets.keyEpoch.id,
              targetKind: 2 as const,
              targetCredentialId: creation.ids.clientCredentialId,
              targetRevision: null,
              keyEnvelopeId: creation.clientKeyEnvelope.id,
            },
          ],
        },
      }),
      vaults: {
        listEpochSecrets: async () => [
          {
            vaultId: creation.ids.vaultId,
            keyEpochId: creation.secrets.keyEpoch.id,
            displayNumber: 0,
            key: Uint8Array.from(creation.secrets.keyEpoch.key),
          },
        ],
        openResolvedCompactItem: async ({ logicalId }: { readonly logicalId: Uint8Array }) => {
          if (bytesEqual(logicalId, creation.baseline.recordId)) {
            return {
              keyEpochId: creation.secrets.keyEpoch.id,
              payloadType: 1 as const,
              payloadBytes: creation.baseline.bytes,
              envelope: creation.baselineEnvelope,
            };
          }
          if (bytesEqual(logicalId, creation.genesis.recordId)) {
            return {
              keyEpochId: creation.secrets.keyEpoch.id,
              payloadType: 1 as const,
              payloadBytes: creation.genesis.bytes,
              envelope: creation.genesisEnvelope,
            };
          }
          throw new TypeError("unexpected Compact item");
        },
      },
    },
    ledger: {
      find: async (input: { readonly logicalNamespace: number; readonly logicalId: Uint8Array }) =>
        prepared.get(materializationKey(input)) ?? null,
      prepare: async ({
        entry,
        bytes,
      }: {
        readonly entry: CanonicalRemoteMaterializationLedgerEntry;
        readonly bytes: Uint8Array;
      }) => {
        prepared.set(materializationKey(entry), { entry, bytes: Uint8Array.from(bytes) });
      },
      confirm: async ({
        entry,
        admission,
      }: {
        readonly entry: CanonicalRemoteMaterializationLedgerEntry;
        readonly admission: {
          readonly storageItemId: Uint8Array;
          readonly byteLength: number;
          readonly admission: "stored" | "already_present";
        };
      }) => {
        expect(admission.storageItemId).toEqual(entry.storageItemId);
        expect(admission.byteLength).toBe(entry.byteLength);
        const confirmed = { ...entry, state: "Confirmed" as const };
        prepared.set(materializationKey(entry), { entry: confirmed, bytes: null });
        return confirmed;
      },
    },
    createHttp: () => ({
      admitCompact: async ({
        locator,
        bytes,
      }: {
        readonly locator: Uint8Array;
        readonly bytes: Uint8Array;
      }) => {
        attempts.push({ locator: Uint8Array.from(locator), bytes: Uint8Array.from(bytes) });
        if (reject) {
          reject = false;
          throw new TypeError("Host channel failed after local preparation");
        }
        return {
          storageItemId: decodeOpaqueEnvelope(bytes).storageItemId,
          byteLength: bytes.byteLength,
          admission: "stored" as const,
          hintCursor: 1,
        };
      },
    }),
  } as never);
  return {
    attempts,
    prepared,
    service,
    sourceStorageItemIds: [
      creation.baselineEnvelope.storageItemId,
      creation.genesisEnvelope.storageItemId,
      creation.recoveryKeyEnvelope.envelope.storageItemId,
      creation.clientKeyEnvelope.envelope.storageItemId,
    ],
    vaultId: creation.ids.vaultId,
  };
}

describe("canonical Hosted Compact materialization", () => {
  it("reseals an authenticated Compact closure without sending protected logical identities", async () => {
    const { attempts, prepared, service, sourceStorageItemIds, vaultId } = await fixture();

    await expect(service.materialize({ vaultId, remoteId: REMOTE_ID })).resolves.toEqual({
      remoteId: REMOTE_ID,
      materializedCompactItemCount: 4,
      retriedCompactItemCount: 0,
      alreadyConfirmedCompactItemCount: 0,
    });

    expect(attempts).toHaveLength(4);
    expect([...prepared.values()]).toHaveLength(4);
    expect(
      [...prepared.values()].every(
        ({ entry, bytes }) => entry.state === "Confirmed" && bytes === null,
      ),
    ).toBe(true);
    expect(attempts.every(({ locator }) => locator.byteLength === 32)).toBe(true);
    expect(
      attempts.every(({ bytes }) => decodeOpaqueEnvelope(bytes).storageItemId.byteLength === 32),
    ).toBe(true);
    expect(
      attempts.every(({ bytes }) =>
        sourceStorageItemIds.every(
          (sourceStorageItemId) =>
            !bytesEqual(decodeOpaqueEnvelope(bytes).storageItemId, sourceStorageItemId),
        ),
      ),
    ).toBe(true);

    await expect(service.materialize({ vaultId, remoteId: REMOTE_ID })).resolves.toEqual({
      remoteId: REMOTE_ID,
      materializedCompactItemCount: 0,
      retriedCompactItemCount: 0,
      alreadyConfirmedCompactItemCount: 4,
    });
    expect(attempts).toHaveLength(4);
  });

  it("retries the exact locally prepared bytes after an ambiguous Host failure", async () => {
    const { attempts, prepared, service, vaultId } = await fixture({ rejectFirstAdmission: true });

    await expect(service.materialize({ vaultId, remoteId: REMOTE_ID })).rejects.toThrow(
      /Host channel failed/u,
    );
    expect(attempts).toHaveLength(1);
    expect([...prepared.values()]).toHaveLength(1);
    expect([...prepared.values()][0]).toMatchObject({ entry: { state: "Prepared" } });
    const firstAttemptBytes = attempts[0]?.bytes;
    if (firstAttemptBytes === undefined) throw new TypeError("first admission was not attempted");

    await expect(service.materialize({ vaultId, remoteId: REMOTE_ID })).resolves.toEqual({
      remoteId: REMOTE_ID,
      materializedCompactItemCount: 3,
      retriedCompactItemCount: 1,
      alreadyConfirmedCompactItemCount: 0,
    });
    expect(attempts).toHaveLength(5);
    expect(attempts[1]?.bytes).toEqual(firstAttemptBytes);
    expect(
      [...prepared.values()].every(
        ({ entry, bytes }) => entry.state === "Confirmed" && bytes === null,
      ),
    ).toBe(true);
  });
});
