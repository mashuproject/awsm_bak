import { describe, expect, it } from "vitest";

import { readySodium } from "../../src/crypto/sodium";
import { DEPENDENCY_TYPES, dependencySet } from "../../src/domain/canonical/dependencies";
import {
  advisoryExtensions,
  decodeRequiredFeatureSet,
  EMPTY_REQUIRED_FEATURE_SET_ID,
  encodeFeatureManifest,
  encodeRequiredFeatureSet,
  featureManifestId,
  requiredFeatureSetId,
} from "../../src/domain/canonical/features";
import {
  identifier,
  keyEpochId,
  vaultObjectId,
  vaultRecordId,
} from "../../src/domain/canonical/identifiers";
import {
  decodeVaultBaseline,
  decodeVaultEvent,
  encodeUnsignedVaultEvent,
  encodeVaultBaseline,
  signVaultEvent,
  type VaultEventInput,
  verifyVaultEventSignature,
} from "../../src/domain/canonical/record";
import { transcript, uint32be, uint64be } from "../../src/domain/canonical/transcript";
import {
  assertCanonicalScopedKey,
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../src/domain/canonical/value";

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

describe("restricted canonical serialization", () => {
  it("encodes integer-key maps in RFC 8949 deterministic order", () => {
    const encoded = encodeCanonicalValue(
      canonicalMap([
        [1, Uint8Array.of(2)],
        [0, 1],
      ]),
    );

    expect(hex(encoded)).toBe("a20001014102");
    expect(encodeCanonicalValue(decodeCanonicalValue(encoded))).toEqual(encoded);
  });

  it.each([
    ["non-shortest integer", "1801"],
    ["indefinite array", "9f01ff"],
    ["floating point", "f93e00"],
    ["undefined", "f7"],
    ["tag", "c001"],
    ["unordered map", "a201000000"],
    ["duplicate map key", "a200010002"],
    ["trailing bytes", "0102"],
  ])("rejects %s", (_name, encoded) => {
    expect(() => decodeCanonicalValue(fromHex(encoded))).toThrow();
  });

  it("requires normalized text and canonical scoped keys", () => {
    expect(() => encodeCanonicalValue("e\u0301")).toThrow(/NFC/u);
    expect(assertCanonicalScopedKey("awsm.search-v1")).toBe("awsm.search-v1");
    for (const invalid of ["Awsm.test", "awsm..test", "awsm_test_", "awsm/test", "a.-b", "local"]) {
      expect(() => assertCanonicalScopedKey(invalid)).toThrow();
    }
  });

  it("sorts canonical sets and rejects duplicate encodings", () => {
    expect(canonicalSet([24, 0, 23])).toEqual([0, 23, 24]);
    expect(() => canonicalSet([Uint8Array.of(1), Uint8Array.of(1)])).toThrow(/duplicate/u);
  });
});

describe("canonical transcripts and identifiers", () => {
  it("uses exact count and length framing", () => {
    expect(hex(transcript("awsm:test:v1", [Uint8Array.of(1), Uint8Array.of(2, 3)]))).toBe(
      "6177736d3a746573743a7631000000000200000000000000010100000000000000020203",
    );
    expect(hex(uint32be(0x0102_0304))).toBe("01020304");
    expect(hex(uint64be(0x0102_0304_0506_0708n))).toBe("0102030405060708");
  });

  it("matches fixed domain-separated identifier vectors", () => {
    const vaultId = filled("Vault", 1);
    const recordBytes = fromHex("a10001");
    const objectBytes = fromHex("a10001");

    expect(hex(vaultRecordId(recordBytes))).toBe(
      "30ee641f3b5a45aceee20fdb4dd40f3835270f32280b5f09ba2ce5766f6fd39a",
    );
    expect(hex(vaultObjectId(vaultId, 2, objectBytes))).toBe(
      "1416e9a785441a52cf9ea03d32e537f7462fe9ad582d95ffc146973fa84a82a5",
    );
    expect(hex(keyEpochId(vaultId, new Uint8Array(32).fill(2)))).toBe(
      "a15170f58c3006fed403e67173e76668462671109a847ac064e259db6a558f3e",
    );
  });
});

describe("features and typed dependencies", () => {
  it("binds exact Manifest bytes and set ordering", () => {
    const first = {
      featureKey: "awsm.alpha",
      revision: 0,
      parameters: new Uint8Array(),
      requiredManifestIds: [],
      incompatibleKeys: [],
    } as const;
    const firstBytes = encodeFeatureManifest(first);
    const firstId = featureManifestId(firstBytes);
    const second = {
      featureKey: "awsm.beta",
      revision: 2,
      parameters: Uint8Array.of(7),
      requiredManifestIds: [firstId],
      incompatibleKeys: ["awsm.gamma"],
    } as const;

    expect(requiredFeatureSetId([second, first])).toEqual(requiredFeatureSetId([first, second]));
    const setBytes = encodeRequiredFeatureSet([second, first]);
    expect(decodeRequiredFeatureSet(setBytes)).toHaveLength(2);
    const ordered = decodeCanonicalValue(setBytes) as readonly CanonicalValue[];
    expect(() => decodeRequiredFeatureSet(encodeCanonicalValue([...ordered].reverse()))).toThrow(
      /Manifest ID/u,
    );
    expect(hex(EMPTY_REQUIRED_FEATURE_SET_ID)).toBe(
      "ed3dd98a4e6cc13d9d14ca4d62eb6b33e11ed471172346ab5d38ac91f57d7ada",
    );
    expect(() => requiredFeatureSetId([first, first])).toThrow(/feature key/u);
    expect(() =>
      requiredFeatureSetId([
        {
          ...first,
          requiredManifestIds: [identifier("FeatureManifest", new Uint8Array(32).fill(9))],
        },
      ]),
    ).toThrow(/unsatisfied/u);
    expect(() =>
      requiredFeatureSetId([{ ...first, incompatibleKeys: [first.featureKey] }]),
    ).toThrow(/conflicts/u);
  });

  it("sorts typed dependency maps and rejects duplicates", () => {
    const dependencies = dependencySet([
      { type: DEPENDENCY_TYPES.ArtifactObject, id: new Uint8Array(32).fill(2) },
      { type: DEPENDENCY_TYPES.VaultRecord, id: new Uint8Array(32).fill(1) },
    ]);
    expect(dependencies).toHaveLength(2);
    expect(() =>
      dependencySet([
        { type: DEPENDENCY_TYPES.VaultRecord, id: new Uint8Array(32).fill(1) },
        { type: DEPENDENCY_TYPES.VaultRecord, id: new Uint8Array(32).fill(1) },
      ]),
    ).toThrow(/duplicate/u);
  });
});

describe("canonical Vault Record envelopes", () => {
  function eventInput(): VaultEventInput {
    return {
      vaultId: filled("Vault", 1),
      generationId: filled("Generation", 2),
      parentRecordIds: [filled("VaultRecord", 3)],
      authorityParentRecordIds: [filled("VaultRecord", 4)],
      dependencies: [
        { type: DEPENDENCY_TYPES.BundleDescriptorObject, id: new Uint8Array(32).fill(5) },
      ],
      requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
      extensions: advisoryExtensions([]),
      family: 2,
      type: 3,
      signerCredentialId: filled("ClientCredential", 6),
      assertedAt: 1_725_000_000_000,
      body: canonicalMap([
        [0, filled("Bundle", 7)],
        [1, filled("VaultObject", 5)],
        [2, filled("Collection", 9)],
      ]),
    };
  }

  it("signs every envelope field and round-trips exact authenticated bytes", async () => {
    const sodium = await readySodium();
    const keypair = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(8));
    const signed = await signVaultEvent(eventInput(), keypair.privateKey);
    const decoded = decodeVaultEvent(signed.bytes);

    expect(decoded.bytes).toEqual(signed.bytes);
    expect(decoded.recordId).toEqual(signed.recordId);
    expect(await verifyVaultEventSignature(decoded, keypair.publicKey)).toBe(true);
    expect(hex(decoded.recordId)).toBe(
      "9fedf2327dabf5535a65e78559d3eb28b45739283acc6f902cb484bd6be1c3fb",
    );

    const changed = { ...eventInput(), assertedAt: Number(eventInput().assertedAt) + 1 };
    const forged = { ...decoded, ...changed };
    expect(await verifyVaultEventSignature(forged, keypair.publicKey)).toBe(false);
  });

  it("keeps unsigned bytes signature-free and rejects incomplete frontiers", () => {
    const unsigned = decodeCanonicalValue(encodeUnsignedVaultEvent(eventInput()));
    expect(unsigned).toBeInstanceOf(Map);
    expect((unsigned as ReadonlyMap<number, unknown>).size).toBe(14);
    expect(() =>
      encodeUnsignedVaultEvent({ ...eventInput(), authorityParentRecordIds: [] }),
    ).toThrow(/both complete parent frontiers/u);
  });

  it("encodes Baselines without signer or parent fields", () => {
    const memberId = filled("Member", 10);
    const clientCredentialId = filled("ClientCredential", 11);
    const recoveryCredentialId = filled("RecoveryCredential", 12);
    const keyEpochId = filled("KeyEpoch", 13);
    const clientEnvelopeId = filled("KeyEnvelope", 14);
    const recoveryEnvelopeId = filled("KeyEnvelope", 15);
    const clientCertificate = indexedMap(
      clientCredentialId,
      memberId,
      new Uint8Array(32).fill(16),
      new Uint8Array(32).fill(17),
    );
    const recoveryCredential = indexedMap(
      recoveryCredentialId,
      memberId,
      0,
      new Uint8Array(32).fill(18),
      new Uint8Array(32).fill(19),
    );
    const recoverySlot = indexedMap(keyEpochId, 1, recoveryCredentialId, 0, recoveryEnvelopeId);
    const clientSlot = indexedMap(keyEpochId, 2, clientCredentialId, null, clientEnvelopeId);
    const contentCheckpoint = indexedMap(1, indexedMap(null, []), [], [], [], [], [], [], [], []);
    const authorityCheckpoint = indexedMap(
      1,
      canonicalSet([memberId]),
      canonicalSet([memberId]),
      canonicalSet([clientCertificate]),
      canonicalSet([recoveryCredential]),
      [],
      canonicalSet([indexedMap(keyEpochId, 0, true)]),
      canonicalSet([recoverySlot, clientSlot]),
      [],
      [],
    );
    const baseline = encodeVaultBaseline({
      vaultId: filled("Vault", 1),
      generationId: filled("Generation", 2),
      dependencies: [
        { type: DEPENDENCY_TYPES.KeyEnvelope, id: recoveryEnvelopeId },
        { type: DEPENDENCY_TYPES.KeyEnvelope, id: clientEnvelopeId },
      ],
      requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
      extensions: advisoryExtensions([]),
      body: indexedMap(1, 1, contentCheckpoint, authorityCheckpoint, indexedMap(1), null),
    });
    const decoded = decodeCanonicalValue(baseline.bytes);
    expect(decoded).toBeInstanceOf(Map);
    expect((decoded as ReadonlyMap<number, unknown>).size).toBe(10);
    expect(baseline.recordId).toEqual(vaultRecordId(baseline.bytes));
    expect(decodeVaultBaseline(baseline.bytes)).toEqual(baseline);
  });
});
