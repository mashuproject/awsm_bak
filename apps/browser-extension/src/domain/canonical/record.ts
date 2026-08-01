import type sodium from "libsodium-wrappers-sumo";
import { readySodium } from "../../crypto/sodium";
import { bytesEqual } from "../hash";
import { validateVaultBaselineBody } from "./baseline-body";
import {
  DEPENDENCY_TYPES,
  type DependencyType,
  dependencySet,
  type TypedDependency,
} from "./dependencies";
import { type CanonicalEventFamily, validateEventBodyAndDependencies } from "./event-bodies";
import { advisoryExtensions } from "./features";
import { type Identifier, identifier, vaultRecordId } from "./identifiers";
import { signedInteger } from "./schema";
import { transcript } from "./transcript";
import {
  type CanonicalMapKey,
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "./value";

export const VAULT_RECORD_FORMAT = 1 as const;
export const VAULT_EVENT_KIND = 1 as const;
export const VAULT_BASELINE_KIND = 2 as const;

export type EventFamily = CanonicalEventFamily;

export interface VaultEventInput {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly parentRecordIds: readonly Identifier<"VaultRecord">[];
  readonly authorityParentRecordIds: readonly Identifier<"VaultRecord">[];
  readonly dependencies: readonly TypedDependency[];
  readonly requiredFeatureSetId: Identifier<"RequiredFeatureSet">;
  readonly extensions: ReadonlyMap<string, CanonicalValue>;
  readonly family: EventFamily;
  readonly type: number;
  readonly signerCredentialId: Identifier<"ClientCredential">;
  readonly assertedAt: number | bigint;
  readonly body: CanonicalValue;
}

export interface AuthenticatedVaultEvent extends VaultEventInput {
  readonly signature: Uint8Array;
  readonly bytes: Uint8Array;
  readonly recordId: Identifier<"VaultRecord">;
}

export interface VaultBaselineInput {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly dependencies: readonly TypedDependency[];
  readonly requiredFeatureSetId: Identifier<"RequiredFeatureSet">;
  readonly extensions: ReadonlyMap<string, CanonicalValue>;
  readonly body: CanonicalValue;
}

export interface VaultBaseline extends VaultBaselineInput {
  readonly bytes: Uint8Array;
  readonly recordId: Identifier<"VaultRecord">;
}

const TYPE_LIMITS: Readonly<Record<EventFamily, number>> = { 1: 14, 2: 31, 3: 2 };

function assertEventInput(input: VaultEventInput): void {
  const maximum = TYPE_LIMITS[input.family];
  if (
    maximum === undefined ||
    !Number.isSafeInteger(input.type) ||
    input.type < 1 ||
    input.type > maximum
  ) {
    throw new TypeError("Unknown base Event family or type");
  }
  const genesis = input.family === 1 && input.type === 1;
  if (
    genesis &&
    (input.parentRecordIds.length !== 0 || input.authorityParentRecordIds.length !== 0)
  ) {
    throw new TypeError("Only Genesis has empty causal and Authority Parent frontiers");
  }
  if (
    !genesis &&
    (input.parentRecordIds.length === 0 || input.authorityParentRecordIds.length === 0)
  ) {
    throw new TypeError("Every non-Genesis Event requires both complete parent frontiers");
  }
  signedInteger(input.assertedAt, "Event assertedAt");
  advisoryExtensions(
    [...input.extensions].map(([key, value]) => {
      if (!(value instanceof Uint8Array))
        throw new TypeError("Advisory Extension values must be bytes");
      return [key, value] as const;
    }),
  );
  validateEventBodyAndDependencies(input.family, input.type, input.body, input.dependencies, input);
}

function unsignedEventValue(input: VaultEventInput): ReadonlyMap<number, CanonicalValue> {
  assertEventInput(input);
  return canonicalMap([
    [0, VAULT_RECORD_FORMAT],
    [1, input.vaultId],
    [2, input.generationId],
    [3, canonicalSet(input.parentRecordIds)],
    [4, canonicalSet(input.authorityParentRecordIds)],
    [5, dependencySet(input.dependencies)],
    [6, VAULT_EVENT_KIND],
    [7, input.requiredFeatureSetId],
    [8, input.extensions],
    [9, input.family],
    [10, input.type],
    [11, input.signerCredentialId],
    [12, input.assertedAt],
    [13, input.body],
  ]);
}

export function encodeUnsignedVaultEvent(input: VaultEventInput): Uint8Array {
  return encodeCanonicalValue(unsignedEventValue(input));
}

export async function signVaultEvent(
  input: VaultEventInput,
  secretKey: Uint8Array,
): Promise<AuthenticatedVaultEvent> {
  if (secretKey.byteLength !== 64) throw new TypeError("Ed25519 secret key must contain 64 bytes");
  const unsigned = unsignedEventValue(input);
  const library = await readySodium();
  const signature = Uint8Array.from(
    library.crypto_sign_detached(
      transcript("awsm:vault-event-signature:v1", [encodeCanonicalValue(unsigned)]),
      secretKey,
    ),
  );
  const authenticated = new Map(unsigned);
  authenticated.set(14, signature);
  const bytes = encodeCanonicalValue(authenticated);
  return decodeVaultEvent(bytes);
}

export async function verifyVaultEventSignature(
  event: AuthenticatedVaultEvent,
  publicKey: Uint8Array,
): Promise<boolean> {
  if (publicKey.byteLength !== 32 || event.signature.byteLength !== 64) return false;
  const library: typeof sodium = await readySodium();
  return library.crypto_sign_verify_detached(
    event.signature,
    transcript("awsm:vault-event-signature:v1", [encodeUnsignedVaultEvent(event)]),
    publicKey,
  );
}

function exactMap(
  value: CanonicalValue,
  expectedKeys: readonly CanonicalMapKey[],
  field: string,
): ReadonlyMap<CanonicalMapKey, CanonicalValue> {
  if (!(value instanceof Map)) throw new TypeError(`${field} must be a canonical map`);
  if (value.size !== expectedKeys.length || expectedKeys.some((key) => !value.has(key))) {
    throw new TypeError(`${field} contains missing or unknown fields`);
  }
  return value;
}

function mapValue(
  map: ReadonlyMap<CanonicalMapKey, CanonicalValue>,
  key: CanonicalMapKey,
): CanonicalValue {
  const value = map.get(key);
  if (value === undefined) throw new TypeError(`Missing canonical field ${String(key)}`);
  return value;
}

function integer(value: CanonicalValue, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  return value;
}

function bytes(value: CanonicalValue, length: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new TypeError(`${field} must contain ${length} bytes`);
  }
  return Uint8Array.from(value);
}

function idSet(value: CanonicalValue, kind: "VaultRecord"): readonly Identifier<"VaultRecord">[] {
  if (!Array.isArray(value)) throw new TypeError("Record frontier must be an array");
  const parsed = value.map((entry) => identifier(kind, bytes(entry, 32, `${kind} ID`)));
  const normalized = canonicalSet(parsed);
  if (!bytesEqual(encodeCanonicalValue(value), encodeCanonicalValue(normalized))) {
    throw new TypeError("Record frontier is not a canonical set");
  }
  return parsed;
}

function dependencies(value: CanonicalValue): readonly TypedDependency[] {
  if (!Array.isArray(value)) throw new TypeError("Dependencies must be an array");
  const parsed = value.map((entry) => {
    const map = exactMap(entry, [0, 1], "Typed Dependency");
    const type = integer(mapValue(map, 0), "Dependency type") as DependencyType;
    if (!Object.values(DEPENDENCY_TYPES).includes(type))
      throw new TypeError("Unknown dependency type");
    return { type, id: bytes(mapValue(map, 1), 32, "Dependency ID") };
  });
  if (!bytesEqual(encodeCanonicalValue(value), encodeCanonicalValue(dependencySet(parsed)))) {
    throw new TypeError("Dependencies are not a canonical set");
  }
  return parsed;
}

function extensions(value: CanonicalValue): ReadonlyMap<string, CanonicalValue> {
  if (!(value instanceof Map)) throw new TypeError("Advisory Extensions must be a map");
  const entries: (readonly [string, Uint8Array])[] = [];
  for (const [key, extension] of value) {
    if (typeof key !== "string" || !(extension instanceof Uint8Array)) {
      throw new TypeError("Advisory Extension entries must map scoped keys to bytes");
    }
    entries.push([key, extension]);
  }
  return advisoryExtensions(entries);
}

export function decodeVaultEvent(encoded: Uint8Array): AuthenticatedVaultEvent {
  const value = decodeCanonicalValue(encoded);
  const map = exactMap(value, [...Array(15).keys()], "Vault Event");
  if (integer(mapValue(map, 0), "Vault Record format") !== VAULT_RECORD_FORMAT) {
    throw new TypeError("Unknown Vault Record format");
  }
  if (integer(mapValue(map, 6), "Vault Record kind") !== VAULT_EVENT_KIND) {
    throw new TypeError("Vault Record is not an Event");
  }
  const input: VaultEventInput = {
    vaultId: identifier("Vault", bytes(mapValue(map, 1), 32, "Vault ID")),
    generationId: identifier("Generation", bytes(mapValue(map, 2), 32, "Generation ID")),
    parentRecordIds: idSet(mapValue(map, 3), "VaultRecord"),
    authorityParentRecordIds: idSet(mapValue(map, 4), "VaultRecord"),
    dependencies: dependencies(mapValue(map, 5)),
    requiredFeatureSetId: identifier(
      "RequiredFeatureSet",
      bytes(mapValue(map, 7), 32, "Required Feature Set ID"),
    ),
    extensions: extensions(mapValue(map, 8)),
    family: integer(mapValue(map, 9), "Event family") as EventFamily,
    type: integer(mapValue(map, 10), "Event type"),
    signerCredentialId: identifier(
      "ClientCredential",
      bytes(mapValue(map, 11), 32, "Client Credential ID"),
    ),
    assertedAt: signedInteger(mapValue(map, 12), "assertedAt"),
    body: mapValue(map, 13),
  };
  assertEventInput(input);
  const signature = bytes(mapValue(map, 14), 64, "Event signature");
  const eventBytes = Uint8Array.from(encoded);
  return { ...input, signature, bytes: eventBytes, recordId: vaultRecordId(eventBytes) };
}

export function encodeVaultBaseline(input: VaultBaselineInput): VaultBaseline {
  assertBaselineInput(input);
  const value = canonicalMap([
    [0, VAULT_RECORD_FORMAT],
    [1, input.vaultId],
    [2, input.generationId],
    [3, []],
    [4, []],
    [5, dependencySet(input.dependencies)],
    [6, VAULT_BASELINE_KIND],
    [7, input.requiredFeatureSetId],
    [8, input.extensions],
    [9, input.body],
  ]);
  const bytes = encodeCanonicalValue(value);
  return decodeVaultBaseline(bytes);
}

function assertBaselineInput(input: VaultBaselineInput): void {
  advisoryExtensions(
    [...input.extensions].map(([key, value]) => {
      if (!(value instanceof Uint8Array))
        throw new TypeError("Advisory Extension values must be bytes");
      return [key, value] as const;
    }),
  );
  validateVaultBaselineBody(input.body, input);
}

export function decodeVaultBaseline(encoded: Uint8Array): VaultBaseline {
  const value = decodeCanonicalValue(encoded);
  const map = exactMap(value, [...Array(10).keys()], "Vault Baseline");
  if (integer(mapValue(map, 0), "Vault Record format") !== VAULT_RECORD_FORMAT) {
    throw new TypeError("Unknown Vault Record format");
  }
  if (integer(mapValue(map, 6), "Vault Record kind") !== VAULT_BASELINE_KIND) {
    throw new TypeError("Vault Record is not a Baseline");
  }
  if (idSet(mapValue(map, 3), "VaultRecord").length !== 0) {
    throw new TypeError("A Vault Baseline cannot have causal parents");
  }
  if (idSet(mapValue(map, 4), "VaultRecord").length !== 0) {
    throw new TypeError("A Vault Baseline cannot have Authority Parents");
  }
  const input: VaultBaselineInput = {
    vaultId: identifier("Vault", bytes(mapValue(map, 1), 32, "Vault ID")),
    generationId: identifier("Generation", bytes(mapValue(map, 2), 32, "Generation ID")),
    dependencies: dependencies(mapValue(map, 5)),
    requiredFeatureSetId: identifier(
      "RequiredFeatureSet",
      bytes(mapValue(map, 7), 32, "Required Feature Set ID"),
    ),
    extensions: extensions(mapValue(map, 8)),
    body: mapValue(map, 9),
  };
  assertBaselineInput(input);
  const baselineBytes = Uint8Array.from(encoded);
  return { ...input, bytes: baselineBytes, recordId: vaultRecordId(baselineBytes) };
}

export function authenticatedEventBytesEqual(
  left: AuthenticatedVaultEvent,
  right: AuthenticatedVaultEvent,
): boolean {
  return bytesEqual(left.bytes, right.bytes);
}
